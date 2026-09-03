# Plan 032: Preserve the workspace catalog and terminal history across host restart

> **Executor instructions**: Follow this plan in order. Preserve all pre-existing
> working-tree changes, especially the current edits in `apps/server/Cargo.toml`
> and `apps/server/src/terminal.rs`. Complete Plans 018 and 019 first. This plan
> does **not** make PTYs survive a host restart: the repository explicitly
> forbids a detached supervisor. If any STOP condition occurs, stop and report
> rather than weakening that invariant. When complete, update this plan and its
> row in `plans/README.md` to `DONE`.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat a0bb3fc9..HEAD -- \
>   apps/server/src/{model,runtime,store,terminal,terminal_history}.rs \
>   packages/yaade-rpc/src/mux-session.ts \
>   packages/yaade-app/src/mux packages/yaade-ui/src/panels \
>   tests/{runtime,recovery,platform,web/durability} \
>   docs/architecture/terminal-runtime.md
> git diff --stat -- \
>   apps/server/src/{model,runtime,store,terminal,terminal_history}.rs \
>   packages/yaade-rpc/src/mux-session.ts \
>   packages/yaade-app/src/mux packages/yaade-ui/src/panels \
>   tests/{runtime,recovery,platform,web/durability} \
>   docs/architecture/terminal-runtime.md
> ```
>
> Reconcile the live code with the excerpts below before editing. A materially
> different startup/history owner is a STOP condition until this plan is revised.

## Status

- **Status**: DONE
- **Gate note**: the operator waiver from Plan 015 covers the unchanged repository-wide anti-slop baseline; Plan 032's Rust and changed-TypeScript lint scopes pass.
- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 018 and 019
- **Category**: persistence / recovery / product correctness
- **Planned at**: commit `a0bb3fc9`, 2026-08-30
- **Source finding**: Superlogical continuity and history parity

## Why this matters

YAADE correctly keeps PTYs alive when a browser or Tauri window closes, but host
startup currently replaces the entire persisted Session → Window → terminal
catalog. A routine service restart therefore loses names, layouts, routes, and
access to useful terminal history in addition to ending processes. Keeping the
catalog and reconciling every former live terminal to an explicit interrupted
state gives users deterministic recovery without introducing the forbidden
second process owner.

This closes the recoverable part of the reference gap. Process survival across
**host** crash remains intentionally unsupported and must stay documented as a
blocked parity item.

## Current state

- `apps/server/src/runtime.rs:141-147` opens the store and immediately calls:

  ```rust
  store.reset_runtime_state()?;
  ```

- `apps/server/src/store.rs:215-220` implements that call by replacing all state:

  ```rust
  *state = PersistedState::new(machine);
  ```

- `docs/architecture/terminal-runtime.md:16-21` says host shutdown/crash ends all
  PTYs and startup discards persisted Session, Window, and terminal rows.
- The RPC model already contains `interrupted`, `restoring`, and `orphaned`
  `ProcessState` values in `packages/yaade-rpc/src/mux-session.ts`, but startup
  never emits them.
- `HostRuntime::restart_mux_terminal` already creates a new PTY and increments
  `output.generation`; reuse that revision-fenced path.
- `TerminalHistoryArchive` persists raw output, but
  `TerminalHost::read_replay_page` currently requires a live `TerminalEntry`.
  Persisted history is therefore not a usable post-restart product surface.
- `AGENTS.md` and `docs/architecture/terminal-runtime.md` prohibit a detached
  supervisor. Do not add a broker, orphan-adoption protocol, browser runtime, or
  provider-specific agent process.

## Target contract

On startup the host must atomically reconcile persisted state:

1. Preserve Session, Window, layout, title, position, archive, and terminal IDs.
2. Keep terminals already known to be exited/failed/cancelled unchanged.
3. Convert every formerly live terminal to `status=disconnected`,
   `processState=interrupted`, no live `ptyId`, idle activity, and history
   availability derived from the archive index.
4. Record a restart reason and previous/new server epochs as metadata, never as
   terminal output.
5. Allow the archived terminal to render retained history read-only and offer an
   explicit revision-fenced restart that creates a new PTY generation.
6. Ensure unrecoverable child processes do not remain silently orphaned after a
   crash; use platform process-group/job-object lifecycle or exact persisted
   process identity cleanup without adopting the PTY.

Any new `@yaade/app` unit test file must also be listed in
`packages/yaade-app/package.json`, per repository convention.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Server | `vp run test:server` | store/runtime/history tests pass |
| Integration | `vp run test:terminal:integration` | restart and generation cases pass |
| Recovery | `vp exec playwright test tests/recovery --project=platform-e2e` | restart catalog/history cases pass |
| Durability UI | `vp exec playwright test tests/web/durability --project=web-e2e` | interrupted terminal is visible and restartable |
| Full gates | `vp run typecheck && vp run lint && vp run build:server` | exit 0 |

## Scope

**In scope**

- `apps/server/src/model.rs`, `store.rs`, `runtime.rs`, `terminal.rs`, and
  `terminal_history.rs`
- Effect Schema/RPC changes under `packages/yaade-rpc/src/`
- Shared browser/Tauri recovery UI under `packages/yaade-app/src/mux/` and
  `packages/yaade-ui/src/panels/`
- Runtime, recovery, durability, and platform tests
- `docs/architecture/terminal-runtime.md`

- Test manifests/scripts required by this plan, including
  `packages/yaade-app/package.json`

**Out of scope**

- Keeping a PTY alive after the host process exits
- A detached PTY broker/supervisor, daemon-within-daemon, or process adoption
- Automatic rerunning of a command after restart
- Persisted-state migration machinery; a reviewed development-state reset is
  allowed if the schema changes
- A standalone history/file/search application

## Steps

### Step 1: Characterize persisted startup and archive recovery

Add tests that create two Sessions, multiple Windows/layouts, one naturally
exited terminal, one running terminal, and one archived session. Restart the
same data directory and assert the current destructive behavior before changing
it. Add archive fixtures for a clean shutdown, abrupt host kill, finalizer in
flight, missing block, and corrupt manifest.

Record process identity and process-group behavior on Linux, macOS, and Windows.
The test must detect an unrecoverable child that remains alive after host death;
it may not assume PTY teardown from server exit is sufficient.

**Verify**:

```bash
vp run test:server
vp run test:terminal:integration
```

Expected before implementation: the characterization proves the catalog reset;
a dedicated expected-failure/recovery test identifies the gap without making the
suite globally red.

### Step 2: Replace destructive reset with one atomic startup reconciliation

Remove the unconditional `reset_runtime_state` call. Add one store operation
that clones, validates, reconciles, and commits the complete persisted state in a
single mutation. It must be idempotent for repeated startup with the same server
epoch and preserve ordering/layout/archive fields.

For formerly live terminals clear stale PTY/process handles, increment revision,
set `disconnected`/`interrupted`, and derive `replayAvailable` from bounded
history metadata. Preserve the last terminal generation; restart increments it.
Do not emit one database write per terminal.

**Verify**:

```bash
vp run test:server
```

Expected: restart keeps exact IDs/layouts and produces one deterministic
interrupted transition per formerly live terminal.

### Step 3: Make closed/interrupted history addressable without a live PTY

Deepen `TerminalHistoryArchive` so a validated archive can be inspected and read
by terminal ID/epoch without `TerminalHost::entry`. Expose a typed read-only
attach/history route that cannot acquire a writer lease, resize, answer terminal
queries, or write to a process. Keep page and byte limits from Plan 018.

Corrupt/missing archives return a typed degraded-history error and metadata; they
must not crash startup or return partial bytes as exact. Keep active and closed
history quota policy explicit.

**Verify**:

```bash
vp run test:server
vp run test:terminal:protocol
```

Expected: clean history replays exactly after process restart; corrupt fixtures
fail closed with bounded errors.

### Step 4: Add shared interrupted-terminal recovery UI

In the shared `@yaade/app` terminal renderer, show retained output read-only for
an interrupted terminal, plus explicit **Restart terminal** and **Close** actions.
Do not put output bytes or rows in React state; feed paged history directly into
the terminal surface/output pipeline. Display that the old process ended and
that restart creates a new shell rather than resuming execution.

Preserve `/?s=&t=&term=` routes and Session/Window layout. The same UI must run in
the browser and Tauri shell. Verify keyboard focus, narrow mobile layout, reduced
motion, and an archive-unavailable error.

**Verify**:

```bash
vp run test:web
vp exec playwright test tests/web/durability --project=web-e2e
```

Expected: scoped DOM assertions prove the same terminal row remains in the same
Window, history is non-empty, and restart yields real PTY output with generation
`N+1`.

### Step 5: Enforce child cleanup without adopting the old PTY

Use one platform-reviewed ownership mechanism for descendants: process groups
and parent-death behavior where available, and Windows Job Objects on Windows.
Persist only the exact identity needed to detect/terminate a stale group. Startup
may terminate a matching orphan; it may never attach to its PTY or kill a PID
whose boot/start identity differs.

Add crash tests that distinguish browser/Tauri exit (child survives) from host
exit (child ends). Keep graceful shutdown kill ordering from Plan 013/018.

**Verify**:

```bash
vp exec playwright test tests/recovery --project=platform-e2e
```

Expected: no orphan remains after host crash/restart, while closing only the
browser or desktop client leaves the PTY alive.

### Step 6: Document and run the full recovery gate

Update architecture docs and README wording: workspace metadata/history survive,
PTY processes do not. Document interrupted/restart semantics and the exact
archive durability fence.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:terminal:integration
vp exec playwright test --project=platform-e2e
vp exec playwright test tests/web/durability --project=web-e2e
vp run build:server
```

Expected: all commands pass on the supported platform matrix.

## Test plan

- Store: idempotent reconciliation, revision monotonicity, all terminal states,
  archived rows, malformed layouts, one commit.
- History: clean/crash/finalizer-in-flight/missing/corrupt archive reopening.
- Lifecycle: browser and Tauri exit versus graceful/crash host exit.
- UI: preserved route/layout/title, non-empty read-only history, unavailable
  history, explicit restart, new generation, mobile controls.
- Security: stale process identity cannot kill an unrelated reused PID.

## Done criteria

- [x] Host startup no longer calls `reset_runtime_state` unconditionally.
- [x] Session, Window, terminal, layout, and archive IDs survive restart.
- [x] Formerly live terminals become explicitly interrupted; no UI claims they resumed.
- [x] Retained history is readable without a live `TerminalEntry`.
- [x] Restart is explicit, revision-fenced, and creates generation `N+1`.
- [x] Browser/Tauri disconnect still preserves PTYs; host exit still ends them.
- [x] No detached supervisor or process-adoption boundary exists.
- [x] Recovery, platform, web, type, plan-scoped lint, and build gates pass.

## Completion record

The committed baseline already preserved the catalog, atomically reconciled
formerly live terminals to `interrupted`, exposed bounded archive reads without
a live `TerminalEntry`, and rendered explicit read-only/restartable desktop and
mobile recovery states. Completion adds the dedicated recovery suite and makes
stale-process cleanup use exact persisted process identity followed by a bounded
graceful-then-forced process-group/tree shutdown. Recovery, server, terminal
integration/protocol, platform E2E, durability web E2E, typecheck, Rust lint,
changed-TypeScript lint, and release server/web build gates pass. Repository-wide
lint remains covered by the operator's pre-existing-baseline waiver.

## STOP conditions

- Closing this gap appears to require a detached supervisor or adopting an old PTY.
- Startup cannot distinguish the old process identity from PID reuse.
- Archive recovery returns unverifiable partial output as exact.
- Reconciliation requires per-row migrations instead of an allowed state reset.
- Output bytes/rows enter React state.
- Existing Plan 018/019 owners differ enough to create a second history or
  terminal lifecycle owner.

## Maintenance notes

Keep two promises separate: client loss is non-destructive; host loss is
process-destructive but metadata/history-preserving. Any future proposal for
host-surviving PTYs is an architecture change that must first revise `AGENTS.md`
and the terminal-runtime ADR rather than being smuggled into recovery code.
