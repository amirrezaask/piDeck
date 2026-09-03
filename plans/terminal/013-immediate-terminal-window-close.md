# Plan 013: Make terminal and Window close feedback immediate and teardown bounded

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Preserve all pre-existing working-tree changes. If anything in the
> "STOP conditions" section occurs, stop and report instead of improvising.
> When done, update this plan and its row in `plans/README.md` to `DONE`.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 4341fd51..HEAD -- \
>   packages/yaade-app/src/mux/TerminalMultiplexer.tsx \
>   packages/yaade-app/src/mux/mux-client.ts \
>   packages/yaade-app/src/mux/mux-store.ts \
>   apps/server/src/runtime.rs apps/server/src/store.rs \
>   apps/server/src/terminal.rs apps/server/src/terminal_history.rs \
>   tests/bench tests/web/e2e/terminal-multiplexer.web.spec.ts
> git diff --stat -- \
>   packages/yaade-app/src/mux/TerminalMultiplexer.tsx \
>   packages/yaade-app/src/mux/mux-client.ts \
>   packages/yaade-app/src/mux/mux-store.ts \
>   apps/server/src/runtime.rs apps/server/src/store.rs \
>   apps/server/src/terminal.rs apps/server/src/terminal_history.rs \
>   tests/bench tests/web/e2e/terminal-multiplexer.web.spec.ts
> ```
>
> At plan creation, `apps/server/src/runtime.rs` and
> `apps/server/src/terminal.rs` have operator-authored, uncommitted terminal-theme
> and query-response work. Other uncommitted files include host-client/RPC,
> `TerminalPanel`, workspace types, compatibility E2E, and a query fixture.
> Preserve all of it. In `runtime.rs` and `terminal.rs`, limit this plan to close
> routing, PTY disposal/history finalization, and focused tests; do not reset or
> rewrite theme/query behavior. If the close lifecycle itself has changed from
> the excerpts below, stop and reconcile this plan first.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 007 and 008
- **Category**: perf / correctness / robustness
- **Planned at**: commit `4341fd51`, 2026-08-30

## Why this matters

Closing a terminal or Window currently waits on host teardown before the item
leaves the screen. The host synchronously flushes compressed history and scans
all retained archives before it asks the OS to kill the PTY child. Closing a
Window repeats that path serially for every terminal and persists multiple full
state snapshots. This turns a direct manipulation into an approximately
one-second pause and creates a correctness hole: a fallible history flush can
return before `child.kill()`, while the caller discards the disposal error and
archives the terminal anyway.

The target is immediate command feedback without weakening lifecycle semantics:
the local terminal or Window is absent by the next paint, the host promptly and
reliably requests process termination, one command performs one persisted mux
state transaction, and history finalization happens outside the interaction
response path.

## Current state

### Client close waits for the host

`packages/yaade-app/src/mux/TerminalMultiplexer.tsx:920-974`:

```ts
const closeTab = useCallback(async (tab: SessionTab) => {
  closingTabIdsRef.current.add(tab.id)
  try {
    await hostPorts.mux.archiveTab?.({
      _tag: "ArchiveSessionTab",
      tabId: tab.id,
      mode: "stop-terminals",
    })
    await client.reconcileSession(tab.sessionId)
  } finally {
    closingTabIdsRef.current.delete(tab.id)
  }
}, [client])

const runTerminalAction = useCallback(async (action, terminal) => {
  const result = action === "archive"
    ? await hostPorts.mux.closeTerminal?.({
        _tag: "CloseTerminal",
        muxTerminalId: terminal.id,
      })
    : /* stop/restart */ undefined
  if (result) client.store.replaceMuxTerminal(result)
  await client.reconcileSession(terminal.sessionId)
}, [client])
```

`closingTabIdsRef` prevents stale creates but does not publish visible state.
Neither close path removes anything until a host event/response arrives.

### Window close repeats terminal teardown serially

`apps/server/src/runtime.rs:389-413`:

```rust
let stop = command.get("mode").and_then(Value::as_str) == Some("stop-terminals");
for terminal in self.store.terminals_for_tab(tab_id, false) {
    self.close_mux_terminal(&terminal, stop)?;
}
let tab = self.store.archive_tab(tab_id)?;
self.emit_tab("SessionTabArchived", &tab);
```

A live terminal close calls `cancel_mux_terminal`, persists a cancelled update,
then calls `archive_terminal`, which persists again. A Window with `N` live
terminals therefore performs roughly `2N + 1` state mutations before its tab
archive event.

### Fallible history work precedes process termination

`apps/server/src/terminal.rs:640-664`:

```rust
pub fn dispose(&self, id: &str) -> Result<(), TerminalError> {
    let entry = self.entries.lock().remove(id)?;
    entry.state.lock().disposed = true;
    self.control.lock().unregister_terminal(id, Some(&entry.terminal_epoch));
    self.history.close_terminal(id)?;
    entry.child.lock().kill().map_err(/* ... */)
}
```

`apps/server/src/runtime.rs:675-693` discards the result:

```rust
if let Some(pty_id) = terminal.output.pty_id.as_deref() {
    let _ = self.terminal.dispose(pty_id);
}
```

If history finalization fails, `kill()` is never reached and the host continues
to persist a cancelled/archived mux terminal.

### History close performs compression, file IO, and a global scan

`apps/server/src/terminal_history.rs:195-202` synchronously flushes pending
records, writes the manifest, and calls `enforce_total_quota()`. The quota pass
at lines 306-334 reads every archive directory and manifest. `flush_state()` at
lines 340-372 serializes pending records, compresses them with gzip level 6,
and writes/renames files while the archive's global state mutex is involved.

### Every mux mutation persists the complete state document

`apps/server/src/store.rs:229-243` clones `PersistedState`, serializes all
Sessions/Windows/terminals, performs a synchronous SQLite update, and then swaps
the in-memory state. Command-level batching therefore has much more leverage
than optimizing one small field update.

### Existing tests do not budget close feedback

`tests/bench/terminal-throughput.bench.ts` covers throughput, dashboard
presentation, and typing. `tests/bench/budgets.json` has no terminal-close or
Window-close budget. The functional Window-close E2E checks eventual row count,
but not click-to-paint latency, process termination, slow history, or rollback.

## Target design

```text
click/shortcut
  -> client pending-close side table
  -> publish normalized snapshot and deterministic next selection
  -> terminal/Window absent on next paint
  -> typed host close command
       -> fence input/control for each PTY
       -> request child termination before fallible history work
       -> one persisted mux-state transaction
       -> ordered authoritative events/response
       -> enqueue history flush/closed marker/quota maintenance
  -> confirm local pending close

failure
  -> reconcile authoritative state while the pending close remains hidden
  -> confirm if the host committed, otherwise roll back and publish once
  -> show the existing action error
```

Use a pending-close **state bucket**, not fabricated entity revisions. The
client's optimistic state must never compete with host revision ordering or be
serialized to RPC/persistence. `MuxClient` should present a small close
interface to React and hide staging/confirmation/rollback behavior inside the
module. Browser and Tauri continue using the same implementation.

On the host, process termination and mux persistence are interaction-critical;
history compression, manifests, and global quota maintenance are not. A close
response may acknowledge after the termination request and state commit. It
must not wait for history finalization, but shutdown/flush barriers must still
drain accepted history work.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| App unit | `vp test packages/yaade-app` | mux store/client tests pass |
| Server unit | `vp run test:server` | all Rust unit/integration tests pass |
| Rust lint | `vp run lint:server:rust` | fmt check and Clippy exit 0 |
| Typecheck/lint | `vp run typecheck && vp run lint` | exit 0 |
| Focused web E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts` | close/lifecycle cases pass |
| Compatibility E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts` | terminal semantics pass |
| Platform E2E | `vp exec playwright test --project=platform-e2e` | terminal lifecycle cases pass |
| Bench | `vp run test:bench` | close budgets and existing terminal budgets pass |

## Suggested executor toolkit

- Use `perfguy` for stage budgets, batching, and before/after reporting.
- Use `frontend-performance` for click-to-next-paint measurement and React
  invalidation; do not use memoization as a substitute for the pending-close
  state design.
- Use `playwright-best-practices` and `webapp-verification` for the visible close
  behavior and real PTY assertions.
- Use `codebase-design` to keep optimistic mutation and history finalization
  behind small module interfaces rather than distributing lifecycle flags
  across callers.

## Scope

**In scope**

- `packages/yaade-app/src/mux/TerminalMultiplexer.tsx`
- `packages/yaade-app/src/mux/mux-client.ts`
- `packages/yaade-app/src/mux/mux-store.ts`
- `packages/yaade-app/src/mux/mux-client.test.ts`
- `packages/yaade-app/src/mux/mux-store.test.ts`
- `apps/server/src/runtime.rs`
- `apps/server/src/store.rs`
- `apps/server/src/terminal.rs`
- `apps/server/src/terminal_history.rs`
- Focused Rust tests colocated with those modules
- `tests/web/e2e/terminal-multiplexer.web.spec.ts`
- A focused `tests/bench/mux-close-latency.bench.ts` test
- `tests/bench/budgets.json`
- `plans/README.md` and this plan's status

**Out of scope**

- Terminal renderer, worker, viewport, resize, or frame-scheduler changes.
- `packages/yaade-ui/src/panels/TerminalPanel.tsx` and the operator's current
  terminal theme/query work.
- A new RPC response shape or protocol version unless a test proves the current
  response/events cannot confirm a close; stop before changing wire contracts.
- Normalizing the singleton JSON store into relational tables.
- Moving live history append/checkpoint generation off the PTY reader; that is a
  separate renderer/host throughput investigation.
- Session-close product behavior or adding an undo affordance.
- Motion redesign. The semantic close must be immediate; animation may not delay it.

## Git workflow

- Do not commit, push, or open a PR unless the operator explicitly asks.
- Preserve the working tree listed in the drift check. Never use reset/checkout
  to remove operator changes.
- Keep ESM `.js` imports, avoid `any`, casts, and broad unvalidated values.

## Steps

### Step 1: Add close-stage characterization and failure tests

Add a focused benchmark and test vocabulary for:

```text
interaction-start -> local-state-published -> next-paint
request-start -> host-result
host-result -> authoritative-client-state
history-close-enqueued -> history-close-finished
```

The first metric is the user-visible budget. Host completion and history finish
are separate diagnostics and must not be folded into it.

In `terminal-multiplexer.web.spec.ts`, follow the existing delayed-create test:
wrap `window.yaade.mux.closeTerminal` and `archiveTab` with a manually released
promise. Add tests that click the real close controls and, before releasing the
RPC, require the terminal row/tile or Window tab to be absent by the next paint.
After release, verify authoritative state and the absence of an action error.
Add a rejected-RPC case that reconciles and restores the real row content,
selection, focusability, and non-empty terminal state.

In Rust tests, add deterministic slow/failing history-finalization coverage.
Prefer an internal test adapter or test hook at the history-finalization seam;
do not add sleep-based production behavior. Record baseline close stages before
changing ordering.

**Verify**:

```bash
vp test packages/yaade-app
vp run test:server
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts
```

Expected before the implementation: the new delayed-RPC immediate-feedback
assertions demonstrate the current failure. Existing tests remain green.

### Step 2: Put optimistic close semantics behind `MuxClient`

Add pending terminal and Window close side tables to `MuxSessionStore`. They are
local overlays only: do not mutate `MuxTerminal.revision`, `SessionTab.revision`,
`archivedAt`, or the `revisions` map to represent optimism.

Expose a small internal mutation handle from the store, equivalent to:

```ts
type PendingMuxClose = {
  readonly mutationId: number
  confirm(): void
  rollback(): void
}

stageTerminalClose(id: MuxTerminalId): PendingMuxClose | null
stageTabClose(id: SessionTabId): PendingMuxClose | null
```

The exact names may follow repository conventions, but preserve these
semantics:

- staging publishes exactly once and excludes the entity from visible indexes;
- a pending Window excludes its terminals from visible tab/terminal indexes;
- selection moves deterministically to the same successor authoritative archive
  would choose;
- duplicate close attempts coalesce or no-op;
- confirmation clears only the matching mutation generation;
- stale failure cannot roll back a newer attempt or an authoritative archive;
- rollback rebuilds membership/selection once without replacing entity models;
- realtime updates received while pending update the authoritative maps but do
  not make the entity visible.

Add `MuxClient.closeTerminal(...)` and `MuxClient.closeTab(...)` methods that
stage immediately, invoke the existing typed host methods, apply the returned
entity/event state, and then confirm or reconcile/rollback. React should call
these methods instead of owning lifecycle ordering. Keep stop and restart on
their current non-optimistic paths.

For terminal close, the returned archived `MuxTerminal` is sufficient to apply
and confirm without an unconditional successful `reconcileSession()`. For
Window close, apply the returned archived tab and confirm; that tab alone keeps
its retained terminals out of visible indexes, while the existing terminal,
replacement-Window, and Session events complete authoritative state. Reconcile
on revision gaps/reconnects, and trigger one background single-flight
`reconcileSession()` only if a successful last-Window response leaves a live
Session with no visible Window after the current event turn. Never await that
fallback before local paint or RPC success.

In `TerminalMultiplexer`, mark interaction start immediately before staging and
measure the first paint after the staged snapshot excludes the entity. Keep
`closingTabIdsRef` only if create/close race protection still needs it; it must
not be the visible-state mechanism.

**Verify**:

```bash
vp test packages/yaade-app
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts
```

Expected: delayed close RPCs remain unresolved while scoped DOM row/tile/tab
counts already reflect the close; rejection restores the exact authoritative
entity once; duplicate and stale completion unit tests pass.

### Step 3: Make PTY termination independent of history finalization

Refactor `TerminalHost::dispose` so no compression, manifest write, quota scan,
or other fallible history operation can prevent or precede the child termination
request. Preserve the control fence: after disposal begins, no new input,
resize, attach, or lease operation may reach that PTY.

Move closed-history finalization behind a deep module in
`terminal_history.rs`. Its external interface should remain small:

- live `append` and `read_page` keep their existing semantics;
- close enqueue returns promptly and is ordered after every append already
  accepted for that terminal, including an append that crossed the output-loop
  state-lock boundary while disposal began;
- an append cannot reopen or remain pending behind a completed close marker;
- a shutdown/test barrier drains accepted close work and reports failures;
- finalization remains idempotent per terminal epoch/id;
- queue growth is bounded by the host's bounded terminal population or by an
  explicit capacity with a non-lossy overflow policy;
- background failures are observable in tests/logging but cannot resurrect or
  skip PTY termination.

Do not move the live append path in this plan. Do not run synchronous gzip or
`enforce_total_quota()` in an HTTP/WS close response. Coalesce global quota
maintenance so closing six terminals does not scan the archive root six times.

Replace `let _ = self.terminal.dispose(...)` on explicit stop/close paths with
intentional handling. Treat a PTY that already exited/disappeared as idempotent
success. Do not remove or drop the last child handle before kill is accepted; a
real inability to request termination must retain a retry/cleanup path and must
not be silently converted into a cancelled/archived terminal. Preserve shutdown
behavior: `stop_all()` must attempt every child termination and then drain/flush
history work.

**Verify**:

```bash
vp run test:server
vp run lint:server:rust
```

Expected tests:

- a blocked history finalizer does not delay the child kill signal or close return;
- a history IO failure still reaches child termination and is surfaced separately;
- an injected child-termination failure is not silently archived as success;
- natural exit and explicit dispose finalize history exactly once;
- shutdown drains accepted close work and leaves no PTY entry.

### Step 4: Persist each close command in one mux transaction

Add command-level store operations rather than calling `update_terminal`,
`archive_terminal`, and `archive_tab` repeatedly. Keep the generic `mutate`
implementation for now; deepen the store interface with operations equivalent
to:

```text
close_terminal(terminal_id) -> archived terminal + changed tab/session
close_tab(tab_id, mode, stopped_terminal_ids) -> archived terminals + archived tab
                                               + changed session + replacement tabs
```

One call to either operation must clone/serialize/write `PersistedState` once.
Add a test-only mutation/commit counter or another deterministic assertion that
proves one SQLite state update per command; elapsed-time-only unit tests are not
sufficient.

For each affected entity:

- increment its revision exactly once;
- use one command timestamp consistently;
- set live terminal status/process/activity/replay fields to the final cancelled
  state before archiving;
- update tab/session selection once after the final visible membership is known;
- create the fallback Window exactly once when the last Window is archived;
- return enough committed models for `runtime.rs` to emit existing typed events
  in revision order.

In `runtime.rs`, for `stop-terminals`, first request termination for all live
PTYs covered by the command. Preserve `keep-running`: archive placement/state in
one transaction without killing those PTYs. Once required termination requests
are accepted/idempotently complete, call the one store transaction and emit
events from its result. Do not call `close_mux_terminal` in a per-terminal
persistence loop. If one required PTY termination request genuinely fails,
leave the Window authoritative state reconcilable, return an error, and let the
client reconciliation decide confirmation versus rollback; never hide a
still-running process in `stop-terminals` mode.

**Verify**:

```bash
vp run test:server
```

Expected: one-terminal close and one/six-terminal Window close each perform one
persisted store commit; revision-gap tests pass; final active Session/Window/
terminal selection is deterministic; every stopped PTY is absent from
`TerminalHost`.

### Step 5: Harden cross-client, reconnect, and completion races

Add tests for these orderings:

1. optimistic stage -> host archive event -> RPC response;
2. optimistic stage -> RPC response -> delayed archive event;
3. optimistic stage -> connection loss -> authoritative reconnect snapshot;
4. optimistic stage -> host rejection -> reconcile says still live;
5. optimistic stage -> response lost -> reconcile says archived;
6. close active terminal while another client selects/renames it;
7. close Window while automatic terminal creation is in flight;
8. close a terminal whose PTY exited immediately before the command;
9. close six terminals while output and history append continue.

Authoritative revisions always win. A pending overlay may suppress visibility,
but it may not consume, forge, or advance host revisions. Keep pending mutation
maps bounded and clear them on confirmation, rollback, client disposal, and full
host replacement where the entity is authoritatively absent.

**Verify**:

```bash
vp test packages/yaade-app
vp run test:server
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts
```

Expected: no entity resurrection, duplicate action, stale rollback, revision
loop, hidden live PTY, or unbounded pending mutation.

### Step 6: Add close latency and throughput regression budgets

Create `tests/bench/mux-close-latency.bench.ts` using the real UI controls and
real PTYs. Keep setup outside measured regions. Collect p50/p95/p99 separately
for:

- terminal click -> terminal row/tile absent on next paint;
- Window click -> Window tab absent on next paint;
- host close request -> result, as a diagnostic rather than the local-feedback
  endpoint;
- one-terminal idle close;
- one-terminal close during controlled output;
- six-terminal Window close;
- close with a nearly full pending history block;
- close after creating many retained history archive directories.

Run three matched release-build sets on recorded hardware before setting host
completion ceilings. The local interaction budget is fixed by product behavior:
terminal and Window close feedback must have p95 at or below 50 ms, with no main
thread task above 50 ms. Add alert output at 80% of that limit. Do not loosen
existing typing, flood, resize, or presentation budgets; reject the change if
those p95 values regress by more than 5%.

The benchmark must distinguish local removal from host completion. A delayed
host fake should make host completion slow while local feedback remains within
budget. Functional E2E, not the benchmark alone, must verify eventual PTY death.

**Verify**:

```bash
vp run test:bench
```

Expected: new close metrics and backend/runtime/hardware context are printed;
injected delayed local publication fails the 50 ms budget; injected slow history
does not fail local feedback or delay host termination acceptance.

### Step 7: Run the full integration gate

Run all repository-required checks after reconciling any operator changes that
landed during implementation.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:web
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-multiplexer.web.spec.ts \
  tests/web/e2e/terminal-compatibility.web.spec.ts
vp exec playwright test --project=platform-e2e
vp run test:bench
```

Expected: all commands exit 0; no benchmark ceiling is loosened; `git status
--short` contains only intentional Plan 013 changes plus the operator's preserved
pre-existing work.

## Test plan

- `mux-store.test.ts`: pending terminal/Window state buckets, stable authoritative
  revisions, deterministic selection, duplicate staging, stale confirmation,
  rollback, event-before-response, and full-snapshot cleanup.
- `mux-client.test.ts`: immediate stage before host await, response/event races,
  confirmed success without redundant terminal reconciliation, failed command
  reconciliation, and disposal cleanup.
- `store.rs` tests: one commit per terminal/Window close, final entity fields,
  revision increments, selection, and fallback Window creation.
- `terminal.rs` tests: kill-before-history, idempotent already-exited close,
  explicit failure handling, natural-exit race, and stop-all drain.
- `terminal_history.rs` tests: delayed/failing finalizer, queue bound, coalesced
  quota maintenance, idempotence, and shutdown barrier.
- Web E2E: real close buttons, scoped row/tile/tab counts, next-paint behavior,
  delayed/rejected RPC, non-empty rollback content, focus, active selection, and
  eventual real PTY termination.
- Bench: local feedback and host completion as separate distributions for idle,
  flood, six-terminal, pending-history, and many-archive workloads.

## Done criteria

- [ ] Terminal and Window close publish local removal before awaiting host/network work.
- [ ] Click/shortcut to next painted removal is p95 <= 50 ms in the release benchmark.
- [ ] Pending closes use local side tables and never modify authoritative revisions.
- [ ] Explicit terminal close cannot skip or delay the kill request because of history IO.
- [ ] A genuine termination failure is not silently persisted as a successful close.
- [ ] Terminal close and Window close each perform one persisted mux transaction.
- [ ] Closing a Window does not run one history quota scan per terminal.
- [ ] History close work is ordered after accepted appends, drained on shutdown,
      and remains bounded/idempotent.
- [ ] Terminal close success does not perform an unconditional session refetch.
- [ ] Delayed, rejected, reordered, reconnect, and multi-client cases pass.
- [ ] Existing terminal typing, flood, resize, renderer, and replay budgets do not regress.
- [ ] Browser and Tauri continue using the same client and typed host interfaces.
- [ ] Full typecheck, lint, unit, E2E, platform, and benchmark gates pass.

## STOP conditions

- The current close lifecycle differs materially from the excerpts because the
  operator's uncommitted work changed it.
- Optimistic removal would require forging `revision`, `updatedAt`, or
  `archivedAt` on an authoritative entity instead of using a side table.
- A design can acknowledge success while a PTY may still be running and no
  retained handle can terminate it.
- The history queue can drop accepted records/close markers or has no shutdown
  drain/error path.
- One-command persistence cannot preserve entity revision/event ordering.
- Correct confirmation requires changing a public RPC response or protocol;
  stop and propose the minimal typed wire change before editing contracts.
- The implementation touches renderer/worker/resize paths or overwrites the
  operator's `runtime.rs`/`terminal.rs` theme and query-response changes.
- The performance test cannot distinguish local feedback from host completion.
- A proposed animation delays semantic removal or ignores reduced motion.

## Maintenance notes

Close is a distributed transition across local visibility, host process
ownership, persisted mux state, events, and history retention. Keep those stages
explicit. Future destructive actions should use the same pending-mutation module
rather than inventing component-local flags or fake revisions. History failure
must remain operational degradation, never a reason to skip process termination.
Reviewers should scrutinize PTY handle ownership, stale completion generations,
one-commit assertions, queue shutdown, and tests that prove the item is truly
absent by paint rather than merely showing a spinner.
