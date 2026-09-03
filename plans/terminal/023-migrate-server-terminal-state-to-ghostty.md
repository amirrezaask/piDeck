# Plan 023: Replace server vt100 and custom scanners with native Ghostty

> **Executor instructions**: Plans 019, 021, and 022 are complete. Run the drift
> check, preserve operator changes, and work in an isolated worktree. Keep the
> migration inside the existing per-terminal owner thread: `ghostty_vt::Terminal`
> is `!Send + !Sync`, must be constructed and dropped there, and must never enter
> an `Arc`, mutex, async task, history worker, or socket path. Stop on an
> unexplained native/WASM parity failure or a checkpoint wire change. Mark this
> plan and its README row `DONE` only after production `vt100` and the OSC/query
> scanners are gone.
>
> **Drift check refreshed at `b2e03509` (run first)**:
>
> ```bash
> git status --short
> git diff --stat b2e03509..HEAD -- \
>   apps/server/Cargo.toml apps/server/Cargo.lock \
>   apps/server/src/terminal.rs apps/server/src/runtime.rs \
>   apps/server/src/wire.rs apps/server/tests \
>   crates/ghostty-vt docs/architecture plans/README.md
> git diff --stat -- \
>   apps/server/Cargo.toml apps/server/Cargo.lock \
>   apps/server/src/terminal.rs apps/server/src/runtime.rs \
>   apps/server/src/wire.rs apps/server/tests \
>   crates/ghostty-vt docs/architecture plans/README.md
> ```
>
> At this baseline, `terminal_owner_loop` is the sole mutable PTY/runtime owner.
> It owns the PTY master, writer, child, `EntryState`, replay, checkpoints, and
> lease registry. A separate bounded reader thread sends immutable `Bytes`; no
> parser state lives outside the owner.

## Status

- **Status**: DONE
- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 019, 021, and 022 (all DONE)
- **Category**: migration / correctness / terminal semantics
- **Originally planned at**: commit `8bbcd017`, 2026-08-30
- **Refreshed at**: commit `b2e03509`, 2026-08-31
- **Source findings**: SolPro P1-7 and P1-8

## Resolved blocker (2026-09-03)

The pinned public `libghostty-vt` terminal stream discarded OSC 4/10/11/12 color
query actions even though Ghostty's application stream handler answered them.
The repository now applies
`patches/ghostty/lib-vt-osc-color-reports.patch` during source preparation. The
patch emits Ghostty's default 16-bit reports through the existing bounded
write-PTY effect. Native and WASM builds verify and consume the same patched
source tree, and their shared corpus matches.

This keeps the server on one parser. No compatibility scanner remains. Focused
browser tests now pass background queries and DEC 2031 theme-change workflows.
The combined web E2E run still reports the pre-existing mobile catch-up failure
from concurrent `packages/ghostty-react/src/surface.ts` work; 27 other tests pass.
`pnpm lint` also stops before inspecting source because the configured
`tools/oxlint/anti-slop/index.ts` plugin is absent. `pnpm lint:server`, changed
Rust formatting, Clippy, typecheck, and server builds pass.

## Why this matters

The browser uses pinned libghostty-vt while the server still uses `vt100` for
synthetic replay checkpoints and scans every output chunk again for terminal
queries and OSC 7. The engines disagree on modern modes, malformed/split input,
Unicode, query policy, and metadata. The duplicate server parsing also defeats
the one-owner/one-parse architecture established by Plan 019.

The existing owner thread is now the correct seam. It should feed each output
chunk once to native Ghostty, synchronously drain bounded effects, and continue
publishing the original immutable bytes to replay, history, and clients.

## Current state at refreshed HEAD

`apps/server/src/terminal.rs` now has the Plan 019 architecture, not the planning
baseline described by the original plan:

- `TerminalHost` stores only immutable entry handles and two bounded command
  senders per terminal.
- `terminal_owner_loop` exclusively owns PTY master/writer/child, `EntryState`,
  replay, checkpoint state, and terminal-control leases.
- the reader thread sends bounded immutable `Bytes` over a 64-entry channel;
  `process_terminal_output` performs replay, scanning, checkpointing, history,
  and fan-out in the owner thread.
- `EntryState` still contains `query_leftover`, `Osc7Scanner`,
  `theme_updates_enabled`, and `Option<vt100::Parser>`.
- `resize_terminal` resizes the PTY and the `vt100` screen in the same owner
  turn; command batching preserves latest-wins resize behavior.
- checkpoint v1 remains synthetic VT bootstrap bytes consumed by web and GPUI
  clients. Plan 024, not this migration, decides whether true parser restore is
  feasible.
- `crates/ghostty-vt` already exposes a bounded, thread-confined `Terminal`,
  public state, VT formatter, resize/reset, modes, colors, title/cwd effects,
  bells, host-query callbacks, and exact write-PTY response bytes.
- Plan 022 parity passes on Linux, macOS, and Windows at Ghostty revision
  `9f62873bf195e4d8a762d768a1405a5f2f7b1697`.

## Target architecture

```text
bounded PTY reader Bytes
  -> per-terminal owner thread
       -> ghostty_vt::Terminal::write(bytes) exactly once
       -> copy/drain bounded effects after write returns
            write-PTY bytes -> same owner-held PTY writer, before later input
            title/cwd/bell  -> bounded owner metadata/events
       -> optional public VT formatter -> checkpoint-v1 synthetic bootstrap
       -> original Bytes -> replay -> history -> live fan-out

resize owner turn
  -> PTY resize
  -> Ghostty resize
  -> drain any in-band resize response
```

The native terminal is a deep module at the owner seam. Callers continue using
the existing `TerminalHost` interface and do not learn Ghostty lifecycle,
callback, parser, or formatter details.

## Decisions fixed by the refresh

1. **Construction handshake**: construct Ghostty inside the new owner thread and
   report initialization success/failure before `TerminalHost::create` publishes
   the entry or starts the PTY reader. On failure, terminate/reap the spawned
   child and return the existing typed `TerminalError::Runtime`; never move a
   successfully constructed `Terminal` into the thread.
2. **One parser even when checkpoints are disabled**: the feature flag controls
   checkpoint production only. Native Ghostty remains authoritative for query
   effects and metadata in every terminal.
3. **Effect ordering**: copy borrowed effect values only after `write` returns,
   release the effect borrow, then write responses through the owner-held PTY
   writer before history/live publication. No callback writes or blocks.
4. **Theme policy**: configure default foreground/background/cursor and color
   scheme through typed wrapper methods. Keep YAADE's explicit DEC 2031
   notification policy, but derive mode state from Ghostty instead of scanning
   output.
5. **CWD policy**: decode only Ghostty's completed, bounded working-directory
   effect. Do not canonicalize or access that path while parsing. Existing
   allowed-root validation remains mandatory before any later host filesystem
   access.
6. **Checkpoint compatibility**: retain checkpoint version 1 and existing attach
   semantics. Build bytes only from public Ghostty state/formatter output and
   continue calling them synthetic replay bootstrap bytes, never serialized
   parser state.
7. **Approved semantic difference**: server responses now follow the same pinned
   Ghostty device attributes and mode behavior as the browser. Do not preserve
   custom scanner response bytes merely because they differ from Ghostty.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Focused server | `vp run test:server && vp run test:terminal:integration` | migration/lifecycle tests pass |
| Native/WASM gate | `vp run test:ghostty:parity` | same-revision corpus passes |
| Rust lint | `vp run lint:server:rust` | exit 0 without `vt100` |
| Browser compatibility | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts tests/web/e2e/terminal-multiplexer.web.spec.ts` | query/theme/replay behavior passes |
| Platform lifecycle | `vp exec playwright test --project=platform-e2e` | host lifecycle passes |

## Scope

**In scope**

- `apps/server/Cargo.toml` and `apps/server/Cargo.lock`
- `apps/server/src/terminal.rs`
- focused server unit/integration tests
- minimal `crates/ghostty-vt` additions required for mutable server host policy
- existing checkpoint-v1 wire compatibility, without changing its schema
- terminal runtime/server migration architecture docs
- this plan and `plans/README.md`

**Out of scope**

- checkpoint export/import or a new checkpoint schema (Plan 024)
- semantic snapshot/patch transport (Plan 033)
- socket/history/actor redesign already completed in Plans 017–019
- browser renderer/worker changes
- Ghostty revision or build-profile changes
- new clipboard/file permissions or servicing unsafe terminal requests
- pixel-accurate native rendering or private Ghostty state access

## Steps

### Step 1: Lock old/new behavior decisions in focused tests

Before deleting scanners, add focused tests that exercise native Ghostty with
split chunks for:

- DA/DSR/DECRQM and OSC default-color responses and their exact ordering;
- OSC title and OSC 7 updates, including malformed/oversized/incomplete strings;
- DEC 2031 color-scheme query, enable/disable, and host theme-change notice;
- primary/alternate screen, resize, and checkpoint bootstrap output.

Record custom-server differences as approved Ghostty corrections or explicit
host policy. Reuse Plan 022 fixture bytes where useful, but do not make
production code depend on the test observation schema. Do not preserve the old
parser in production.

**Verify**:

```bash
vp run test:server
vp run test:ghostty:parity
```

### Step 2: Construct native Ghostty in the owner thread

Add `ghostty-vt` as a path dependency. Replace caller-built `EntryState` with a
small `Send` initialization description. In the owner thread:

1. create `ghostty_vt::Terminal` with validated rows/columns, 10,000-row
   scrollback (matching the browser authority), maximal safe per-read effect
   bounds, host query policy, device attributes, and initial color scheme;
2. set default terminal colors;
3. send a one-shot initialization result to `TerminalHost::create`;
4. enter the owner loop only after success.

Bound PTY read chunks so one parser call cannot exceed the wrapper's callback
count limits. On construction/configuration failure, kill/reap the child, drop
PTY resources on the owner thread, and return a typed runtime error without
publishing an entry.

**Verify**:

```bash
vp run test:server
cargo clippy --manifest-path apps/server/Cargo.toml --all-targets -- -D warnings
```

### Step 3: Parse each output chunk once and drain effects causally

Replace query and OSC scanners plus `vt100::Parser::process` with exactly one
`Terminal::write(data.as_ref())`. After it returns:

- copy ordered write-PTY response slices and bounded title/cwd/bell metadata;
- release the borrowed `TerminalEffects`;
- write and flush response bytes on the owner-held PTY writer;
- update live title/cwd and emit bounded bell metadata;
- then append the original `Bytes` to replay/history and emit it live.

Treat parser/effect overflow as a visible typed runtime failure; never silently
normalize or drop required response bytes. Keep malformed PTY bytes opaque in
replay/history/fan-out.

**Verify**:

```bash
vp run test:server
vp run test:terminal:integration
```

### Step 4: Route resize and theme policy through Ghostty

In the existing latest-wins owner turn, commit PTY resize first, then native
Ghostty resize, then drain any in-band response before later normal writes.
Retain the current cells-only host contract by using a documented nonzero
logical cell-pixel fallback until a later wire plan carries measured pixels.

On `SetTheme`, update Ghostty default colors and mutable color-scheme callback
configuration. If Ghostty reports DEC mode 2031 enabled, send the existing 997
notification from the owner after the theme mutation. Do not scan output to
track mode state.

**Verify**:

```bash
vp run test:server
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts
```

### Step 5: Preserve checkpoint-v1 with the public formatter

Replace `vt100::Screen::contents_formatted` with bounded Ghostty VT formatting
and public active-screen/cursor state. Preserve checkpoint version, sequence,
dimensions, replay-quality selection, and attach ordering. Keep output bounded by
the wrapper formatter limit and surface formatting failure without private state
fallbacks.

Test primary and alternate screen checkpoints, resize-triggered checkpoints,
truncated replay attach, and browser bootstrap consumption. Document that this
is a lossy synthetic presentation bootstrap and cannot resume parser state.

**Verify**:

```bash
vp run test:server
vp run test:terminal:protocol
vp run test:terminal:integration
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts
```

### Step 6: Remove legacy parser/scanners and update architecture docs

Delete `vt100`, `query_leftover`, `Osc7Scanner`, `feed_terminal_requests`, custom
query enums/writers, and dead carry helpers. A URI-to-path policy helper may
remain only for decoding Ghostty's completed cwd effect; it must not scan PTY
bytes.

Update architecture docs with owner-thread Ghostty construction/destruction,
one-parse ownership, effect drain ordering, mutable host policy, pinned revision
diagnostics, and checkpoint-v1 limitations.

**Verify**:

```bash
rg -n 'vt100|feed_terminal_requests|query_leftover|Osc7Scanner|TERMINAL_REQUEST_SEQUENCES' apps/server
vp run lint:server:rust
vp run test:server
vp run test:terminal:integration
vp run test:ghostty:parity
```

Expected: the search has no production matches and every command passes.

### Step 7: Run final browser/platform gates

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:terminal:protocol
vp run test:terminal:integration
vp run test:ghostty:parity
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-compatibility.web.spec.ts \
  tests/web/e2e/terminal-multiplexer.web.spec.ts
vp exec playwright test --project=platform-e2e
vp run build:server
```

Document any unrelated pre-existing full-repository lint/CI failure separately;
all changed files and focused migration gates must pass.

## Test plan

- owner-thread construction success/failure and child cleanup
- `Terminal` remains owner-confined through create/write/resize/drop
- exact split query effects and response ordering before live publication
- title/cwd/bell bounds, malformed controls, and no parser-path filesystem IO
- theme defaults, color queries, 996/997 policy, and DEC 2031 mode state
- latest-wins resize plus in-band resize response ordering
- checkpoint-v1 primary/alternate/bootstrap/truncated-history behavior
- repository search proving all production `vt100`/scanner state is removed
- native/WASM parity and browser terminal compatibility

## Done criteria

- [x] Every PTY output chunk enters exactly one native Ghostty parser call.
- [x] The owner thread constructs, exclusively owns, and drops the `!Send`
  Ghostty handle.
- [x] Query responses drain after callbacks and before later writes/fan-out.
- [x] Title/cwd/bell/theme/size/device behavior follows approved Ghostty plus
  explicit YAADE host policy.
- [x] Checkpoint-v1 remains explicit, bounded, synthetic, and wire-compatible.
- [x] `vt100` and duplicate OSC/query scanners are absent from production.
- [x] Native/WASM revision and parity gates pass.
- [x] Focused server, browser compatibility, platform, lint, and build gates pass
  or unrelated repository-baseline failures are recorded precisely.

## STOP conditions

- Native Ghostty must move across threads or be shared behind a mutex.
- A callback must block, re-enter Ghostty, or write the PTY directly.
- Required response bytes can overflow without a bounded, tested failure path.
- Approved behavior differs from browser Ghostty without an explicit host-policy
  explanation.
- Migration requires private Ghostty memory or changes checkpoint wire semantics.
- Removing old code regresses replay, resize, close, theme, cwd, or security
  behavior.
- Work expands into semantic transport, native rendering, or Plan 024 restore.

## Maintenance notes

Add terminal semantic regressions to the shared Plan 022 corpus first. Keep host
policy as typed mutable configuration/effects on the safe wrapper, not byte
scanners in `apps/server`. Plan 024 remains the sole authority for true parser
checkpoint feasibility.
