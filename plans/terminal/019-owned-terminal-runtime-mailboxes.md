# Plan 019: Give each terminal one state/control owner with bounded mailboxes

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
> git diff --stat 7276f526..HEAD -- \
>   apps/server/src/terminal.rs apps/server/src/terminal_control.rs \
>   apps/server/src/terminal_history.rs apps/server/src/event_hub.rs \
>   apps/server/src/runtime.rs apps/server/src/server.rs \
>   apps/server/Cargo.toml apps/server/Cargo.lock apps/server/tests \
>   tests/bench docs/architecture/terminal-runtime.md
> git diff --stat -- \
>   apps/server/src/terminal.rs apps/server/src/terminal_control.rs \
>   apps/server/src/terminal_history.rs apps/server/src/event_hub.rs \
>   apps/server/src/runtime.rs apps/server/src/server.rs \
>   apps/server/Cargo.toml apps/server/Cargo.lock apps/server/tests \
>   tests/bench docs/architecture/terminal-runtime.md
> ```
>
> Confirm Plans 012, 015, 017, and 018 are `DONE`. This plan builds on byte
> chunks, attached-only non-awaiting fan-out, asynchronous history, and the
> existing client latest-wins resize coordinator. Do not recreate global socket
> broadcast, synchronous history, or string terminal output. Plan 023 later
> replaces the actor-owned transitional `vt100` recorder with libghostty-vt.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 012, 015, 017, and 018
- **Category**: perf / correctness / architecture
- **Planned at**: commit `7276f526`, 2026-08-30
- **Source finding**: SolPro Ghostty review P0-3

## Why this matters

The PTY reader thread currently does far more than read: replay mutation,
sequence allocation, OSC/query scanning, `vt100` parsing, checkpoint creation,
history append, query writes, and event construction. Meanwhile request/runtime
threads lock the PTY writer for every write+flush, lock the master for every
resize, then lock terminal state and checkpoint again. Attach/snapshot and
lifecycle operations compete with output on broad mutexes.

The target is single ownership. A minimal blocking reader copies each PTY read
into `Bytes` and submits it to a bounded terminal actor. That actor owns terminal
state, writer, master, child lifecycle, parser/checkpoint state, replay, and
terminal-specific lease/control state. Commands cross a reserved bounded
mailbox, adjacent writes drain in one turn, resize is latest-wins, and one batch
publishes one set of notifications. No normal PTY operation reaches through a
shared writer/master/state mutex.

## Current state

`apps/server/src/terminal.rs::TerminalEntry` stores:

```rust
master: Mutex<Box<dyn MasterPty + Send>>,
writer: Mutex<Box<dyn Write + Send>>,
child: Mutex<Box<dyn Child + Send + Sync>>,
state: Mutex<EntryState>,
```

`TerminalHost::write` takes the writer mutex, `write_all`, and `flush` for each
request. `resize` immediately locks master, calls resize, locks state, resizes
`vt100`, and constructs a checkpoint. `attach` locks state and clones replay.

`output_loop` holds state while it allocates sequence/replay, scans OSC/query
content, parses/checkpoints, then drops it for history/query writer/event work.
At EOF it takes child and state locks again. The host-level
`TerminalControlRegistry` is another global mutex over all terminals and records
a command ID during authorization before the PTY mutation is attempted.

Plan 018 removes disk/compression from output but does not change these ownership
and scheduling relationships.

## Target design

```text
TerminalRuntimeHandle (stored in TerminalHost map)
  ├─ bounded output sender (byte budget)
  ├─ bounded control sender (reserved capacity)
  └─ immutable identity/process metadata

blocking PTY reader thread
  read only -> Bytes -> output sender.blocking_send

terminal owner thread
  owns:
    EntryState / sequence / byte replay / transitional parser
    PTY writer / MasterPty / Child
    per-terminal lease + duplicate-command state
    TerminalHistoryStream
    subscriber publication handle

  event loop:
    urgent lifecycle/control
    bounded output quantum
    normal commands
    drain immediately available batch
    one notification/publication phase
```

A separate blocking reader is necessary because `portable_pty::Read` is blocking.
Do not add a writer thread as well: the terminal owner can own writer/master/child
and process reader messages plus commands. This adds one bounded owner thread per
terminal; measure thread stack/RSS at 64 terminals and use an explicit small
safe stack size. If that cost is unacceptable, stop and propose a shared owner
pool with preserved per-terminal ordering rather than silently creating hundreds
of default-stack threads.

Use two bounded lanes or a mailbox with reserved control capacity. Output may
apply controlled backpressure to the reader when the actor/history pipeline is
saturated. Attach/snapshot/dispose/query response must not starve behind an
unbounded output flood.

The external `TerminalHost` interface remains small and synchronous for current
Rust dispatch callers. Methods enqueue a command and wait for a bounded reply
where a result is required. Queue-full/owner-stopped are typed errors, not hidden
blocking or panic.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Server unit/integration | `vp run test:server && vp run test:terminal:integration` | runtime/PTY tests pass |
| Rust lint | `vp run lint:server:rust` | fmt/Clippy exit 0 |
| Protocol client | `vp run test:terminal:protocol && vp test packages/yaade-host-client` | ACK/lease/resize tests pass |
| Web E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts tests/web/e2e/terminal-compatibility.web.spec.ts` | pass |
| Platform E2E | `vp exec playwright test --project=platform-e2e` | lifecycle/process tests pass |
| Bench | `vp run test:bench` plus focused Rust runtime benchmark command added here | terminal budgets pass |
| Build | `vp run build:server` | release server builds on current platform |

## Suggested executor toolkit

- Use `perfguy` for mailbox sizing, batching, fairness, thread stack/RSS, and
  saturation/tail-latency measurements.
- Use `codebase-design` to keep actor internals behind `TerminalRuntimeHandle`
  rather than exposing channels and lock details to `runtime.rs`.
- Use `playwright-best-practices` for real PTY resize/write/query/flood tests.

## Scope

**In scope**

- `apps/server/src/terminal.rs`
- A new internal `apps/server/src/terminal_runtime.rs` if it gives the owner a
  coherent module interface
- `apps/server/src/terminal_control.rs`
- `apps/server/src/runtime.rs` only for typed runtime calls/error handling
- `apps/server/src/server.rs` only for queue-full wire mapping if required
- `apps/server/src/event_hub.rs`/fan-out only for the owner publication handle
- `apps/server/src/terminal_history.rs` only for actor-owned stream usage
- `apps/server/src/lib.rs`
- `apps/server/Cargo.toml`/`Cargo.lock` for a bounded selectable channel crate if
  standard channels cannot provide fair reserved lanes
- Rust unit/integration tests and focused runtime benchmarks
- Existing terminal web/platform E2E and benchmark diagnostics
- `docs/architecture/terminal-runtime.md`
- `docs/architecture/rust-server-migration.md`
- `plans/README.md` and this plan's status

**Out of scope**

- Native libghostty-vt integration or checkpoint replacement; Plans 023 and 024.
- Socket writer/fan-out/history architecture already completed in Plans 017/018.
- Browser worker/rendering changes.
- Detached process supervision or host-restart durability.
- One actor/runtime process per terminal, an unbounded mailbox, a polling sleep
  loop, or delaying every write to create a batch.
- Debouncing resize until interaction ends; final size and first useful resize
  must remain prompt.

## Git workflow

- Do not commit, push, or open a PR unless explicitly instructed.
- Preserve all prior-plan/operator changes; never reset files.
- No channel send, reply wait, or mutex guard may occur while holding the
  `TerminalHost.entries` map lock.

## Steps

### Step 1: Characterize lock, syscall, and starvation behavior

Add payload-free stage metrics:

```text
pty_read_bytes / read_calls
output_mailbox_depth_bytes / blocked_ns
control_mailbox_depth / queue_full
terminal_owner_batch_messages / bytes
write_calls / write_bytes / flush_calls
resize_requested / resize_applied / resize_coalesced
state_command_wait_ns
attach_snapshot_wait_ns
terminal_owner_loop_ns
terminal_state_lock_wait_ns / hold_ns (baseline only)
owner_threads / reader_threads / stack_bytes
```

Add deterministic adapters/barriers for a blocked writer, resize, output flood,
and delayed snapshot reply. Characterize:

- 1/8/64-byte adjacent writes;
- 10,000 resize requests;
- attach/snapshot during continuous 64 KiB output;
- terminal query during user-input flood;
- dispose/exit race;
- 1/8/64 simultaneous terminals and idle RSS.

Record current write/flush counts and state/writer/master lock wait/hold. Use
barriers, not sleeps, for starvation tests.

**Verify**:

```bash
vp run test:server
```

Expected at this intermediate step: counters expose per-request write/flush and
current lock/starvation behavior; existing tests pass.

### Step 2: Introduce a deep `TerminalRuntimeHandle` and bounded owner lanes

Move mutable per-terminal runtime state behind an actor handle. `TerminalHost`
keeps a short-lived mutex only for the ID→handle map; cloning a handle then
releases the map lock before any send/wait.

Define explicit message types, equivalent to:

```rust
enum OutputMessage {
    Bytes(Bytes),
    Eof,
    ReadFailed(io::ErrorKind),
}

enum TerminalCommand {
    AuthorizeAndWrite { data: Bytes, fence: Option<TerminalMutationFence>, reply: Reply<()> },
    Resize { cols: u16, rows: u16, fence: Option<TerminalMutationFence>, reply: Reply<()> },
    SetTheme { theme: TerminalTheme, reply: Reply<()> },
    Attach { client_id: String, after_sequence: u64, reply: Reply<TerminalAttach> },
    MarkReplayReady { client_id: String, reply: Reply<()> },
    Detach { client_id: String, reply: Reply<()> },
    Inspect { reply: Reply<TerminalInspect> },
    Dispose { reply: Reply<DisposeResult> },
    ReleaseConnection { connection_id: String },
    Shutdown { reply: Reply<()> },
}
```

Exact variants may differ, but authorization and mutation acceptance must be one
actor transaction. Queue-full must not consume a duplicate-command ID. Use
small typed reply channels with timeouts only as a defect guard; normal command
latency comes from fair owner scheduling, not arbitrary timeout retries.

Reserve urgent/control capacity so dispose/shutdown/query response and snapshot
requests progress during output flood. Bound output by bytes and messages. Add
fairness: process urgent commands, then at most a measured output quantum, then
normal commands. Drain currently available work per turn and publish/wake once
after the batch.

**Verify**:

```bash
vp run test:server
vp run lint:server:rust
```

Expected: mailbox bound/fairness/queue-full/owner-stop tests pass; no caller can
access actor-owned mutable state directly.

### Step 3: Make the blocking PTY reader read-only

At terminal creation, transfer writer, master, child, state, history stream,
control state, and publication handle to the terminal owner. Give the blocking
reader only its reader object, terminal identity for thread naming/metrics, and
the bounded output sender.

The reader loop does exactly:

1. blocking `read` into reusable scratch;
2. create/freeze one `Bytes` chunk for non-empty data;
3. bounded send to owner;
4. report EOF/error and exit.

It may handle interrupted reads and actor cancellation. It may not allocate
sequence, mutate replay, parse bytes, scan OSC/query, checkpoint, append history,
write query responses, emit events, wait child, or perform cleanup.

Use controlled blocking when output mailbox bytes are full. Record blocked time;
do not drop. Ensure disposal closes/cancels reader promptly on every platform,
including an idle PTY blocked in `read`.

**Verify**:

```bash
vp run test:server
vp run test:terminal:integration
```

Expected: source/tests prove the reader invokes no parser/history/fan-out/writer
operations; exact output/replay behavior remains unchanged.

### Step 4: Move output state and publication into the owner

For each output chunk, the owner:

- checks disposed/lifecycle state;
- allocates the next terminal sequence;
- appends a `Bytes` clone to bounded replay and evicts by bytes;
- feeds bounded byte scanners and transitional `vt100` recorder;
- updates title/cwd/theme/query/checkpoint state;
- submits `Bytes` to the asynchronous `TerminalHistoryStream`;
- publishes one shared terminal frame to Plan 017 fan-out;
- queues/writes any terminal query response through the actor-owned writer.

Keep state local; remove `EntryState` mutex. Batch immediately available output
chunks up to a measured byte/time quantum, but preserve one sequence per input
chunk unless protocol/ACK tests explicitly approve a sequence batching change.
Notify fan-out once per processed chunk/fence as required; do not wake a renderer
for scanner-only metadata separately when one terminal frame already does so.

Attach/snapshot commands clone `Bytes` handles and construct a consistent
sequence/checkpoint/replay view entirely in the owner turn. They must complete
within the fairness bound under sustained output.

**Verify**:

```bash
vp run test:server
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts
```

Expected: exact bytes, replay fences, OSC cwd, query responses, checkpoints, and
attach under flood pass; `EntryState` has no shared mutex.

### Step 5: Batch writes immediately and flush once per drained group

Make the owner the sole PTY writer. A write command is accepted promptly; do not
add a debounce timer. In each owner turn, drain all immediately available
adjacent writes in command order up to a measured maximum batch byte size. Use a
reusable scratch buffer only when combining avoids multiple syscalls; a single
`Bytes` may write directly.

Call `write_all` for the drained group and flush once. Preserve ordering with
resize/signal/dispose commands: do not move a write across a lifecycle fence.
Terminal-generated query responses use an urgent path so a shell waiting for
DA/DSR/OSC response cannot starve behind bulk user input, while still preserving
byte order relative to output parsing.

Return errors to every affected command receipt deterministically. If a partial
batch write fails, do not report later commands as accepted/applied without a
clear typed outcome. Keep duplicate-command semantics aligned with actual
mailbox acceptance/application.

**Verify**:

```bash
vp run test:server
vp run test:terminal:integration
```

Expected: N adjacent writes produce fewer write syscalls and one flush, no
artificial delay appears for a single keystroke, input/query byte order is exact,
and write failure receipts are deterministic.

### Step 6: Coalesce resize latest-wins with a final-size guarantee

Integrate with Plan 012's client first+latest policy. The owner tracks one pending
resize and applies latest-wins within a measured starting window of 16–25 ms,
without delaying unrelated writes/query/dispose. Apply the first useful resize
promptly enough for interactive feedback and guarantee the final requested grid
is applied after the burst settles.

Each applied resize updates `MasterPty`, actor dimensions, transitional parser,
and checkpoint state transactionally in one owner turn. Intermediate superseded
resize receipts must resolve with an explicit coalesced/applied result compatible
with the current RPC response; do not leave callers hanging. A stale completion
cannot overwrite a newer actor dimension.

Use deterministic fake clock/channel tests for first+latest, reverse resize,
continuous resize, write interleaving, failure, and disposal. Tune the constant
against existing resize benchmarks; do not copy Ghostty's 25 ms blindly and do
not raise Plan 012 budgets.

**Verify**:

```bash
vp run test:server
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts
vp run test:bench
```

Expected: applied resize count is bounded, final host/PTY grid matches final
client grid, and no stale geometry or typing regression appears.

### Step 7: Move lease/control state per terminal and harden lifecycle

Refactor `terminal_control.rs` so reusable pure `TerminalControlState` is owned
by the terminal actor. `TerminalControlRegistry` may remain only as a thin host
router/aggregate during migration, then remove its global mutex from terminal
mutation paths. Acquire/renew/release/takeover/transfer/authorize execute in
actor order with the corresponding mutation.

`release_connection` snapshots terminal handles from the host map and sends a
bounded control command to each without holding the map. `list_all_leases`
collects actor snapshots with a bounded deadline and explicit unavailable state;
it may not freeze output globally.

Lifecycle rules:

- dispose fences new input/resize/attach first;
- request child kill before history close work (Plan 013 invariant);
- retain child ownership until kill/wait outcome is known;
- EOF asks the actor-owned child for exit status and finalizes once;
- natural exit vs explicit dispose is idempotent;
- remove the host map entry only after the owner acknowledges final lifecycle;
- shutdown attempts every terminal, drains history, joins owner/reader threads,
  and reports failures.

Test queue-full authorization: a command ID is reusable if mutation was not
accepted, and duplicate only after acceptance according to the existing fence
contract.

**Verify**:

```bash
vp run test:server
vp exec playwright test --project=platform-e2e
```

Expected: no writer/master/child/state/control broad mutex remains in normal
terminal operations; lifecycle, leases, duplicate fences, and shutdown pass.

### Step 8: Enforce fairness, thread, and throughput budgets

Add deterministic/release benchmarks for:

```text
idle key write
64 adjacent writes
output parse/fan-out at 1/8/64 terminals
attach/snapshot during output flood
query response during input flood
resize storm
natural exit / dispose race
64 idle terminal RSS/thread stacks
mailbox saturation and recovery
```

Report p50/p95/p99 command acceptance/application, output queue lag, owner batch
size, syscalls/flushes, resize coalescing, attach wait, reader blocked time,
thread count, and RSS. Keep fixture generation outside measured regions.

Machine gates:

- attach/snapshot/dispose/control progress within a bounded number of owner
  quanta under continuous output;
- one keystroke adds no batching delay;
- adjacent writes reduce syscalls/flushes;
- final resize always applies;
- queue memory and thread stacks stay within recorded bounds at 64 terminals;
- no terminal lock wait/hold metrics remain in hot operations;
- existing end-to-end typing/flood/replay/resize/close budgets do not regress by
  more than 5% and no ceiling is loosened.

**Verify**:

```bash
vp run test:server
# Run the focused runtime benchmark command added by this plan.
vp run test:bench
```

Expected: all fairness/memory/exactness gates pass on recorded hardware.

### Step 9: Run full integration and document ownership

Update architecture docs with the blocking reader, actor owner, lane capacities,
fairness quantum, write batching, resize policy, lifecycle, saturation, and
thread/RSS measurements.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:terminal:protocol
vp run test:terminal:integration
vp test packages/yaade-host-client
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-multiplexer.web.spec.ts \
  tests/web/e2e/terminal-compatibility.web.spec.ts
vp exec playwright test --project=platform-e2e
vp run test:bench
vp run build:server
```

Expected: all commands exit 0; no budget is loosened; source and docs agree on
single ownership.

## Test plan

- Mailbox/owner: byte/message bounds, reserved control, fairness quantum,
  queue-full receipts, owner stop, no map lock during send/wait.
- Reader: read-only responsibilities, interrupted/error/EOF, saturation,
  disposal wakeup on supported platforms.
- Output state: exact sequence/replay/history/fan-out, scanners, query response,
  attach snapshot under flood.
- Writes: immediate single write, adjacent batching, max batch, interleaving,
  partial failure, query priority, duplicate fences.
- Resize: fake-clock first+latest, final guarantee, failure, write/dispose
  interleaving, parser/checkpoint dimensions.
- Control/lifecycle: per-terminal leases, takeover/transfer, release connection,
  natural/explicit race, kill/history order, shutdown/join.
- Bench/E2E: 1/8/64 terminals, real shell/TUI/query, resize/flood, thread/RSS.

## Done criteria

- [x] The blocking PTY reader only reads, creates `Bytes`, and sends bounded output messages.
- [x] One terminal owner owns mutable state, writer, master, child, parser, replay, history stream, and control state.
- [x] No normal write/resize/attach/output path uses broad writer/master/state/control mutexes.
- [x] Output and control mailboxes are bounded with reserved lifecycle/snapshot progress.
- [x] Adjacent writes drain immediately and flush once without adding key delay.
- [x] Resize is measured latest-wins and guarantees the final PTY grid.
- [x] Attach/snapshot/query/dispose cannot starve under sustained output.
- [x] Queue-full mutation does not consume a duplicate-command fence.
- [x] Explicit/natural exit, history close, reader cancellation, and shutdown are idempotent and joined.
- [x] Thread stack/RSS and mailbox memory remain bounded at 64 terminals.
- [x] Plan-scoped unit, integration, platform, web, build, lint, and benchmark behavior is verified.

## Completion record

The committed terminal actor already owned the PTY master, writer, child,
parser/checkpoint, replay, history submission, and lease state behind 64-entry
urgent/normal/output lanes with explicit 1 MiB/256 KiB thread stacks. Completion
bounds the remaining host cleanup lane, batches up to 64 immediately available
adjacent writes into a 256 KiB flush group, and coalesces consecutive resizes to
the final grid without a timer or key delay. Server, Rust lint, terminal
integration/protocol, host-client, web E2E, platform E2E, and release server
build gates passed. The operator waiver from Plan 015 covers only the unchanged
global lint/renderer benchmark baseline.

## STOP conditions

- The owner design requires a third per-terminal writer thread or default large
  stacks without measuring 64-terminal RSS.
- A command/reply waits while `TerminalHost.entries` is locked.
- Output can starve snapshot/dispose/query response despite reserved capacity.
- Queue saturation drops PTY bytes or becomes unbounded memory.
- Command IDs are consumed before mailbox acceptance and cannot be retried.
- Resize coalescing cannot guarantee final dimensions or adds an unconditional
  delay to all writes.
- Disposal cannot interrupt an idle blocking reader on a supported platform.
- The change starts implementing native Ghostty, socket, history, or browser
  architecture already assigned to another plan.

## Maintenance notes

The terminal actor's interface includes capacity, ordering, error, and latency
semantics in addition to method signatures. Future commands must declare their lane,
reply fence, batching/coalescing rule, and lifecycle priority. Keep output reader
responsibilities minimal and actor state private. Reviewers should scrutinize
map-lock/channel lock order, starvation tests, partial write outcomes, duplicate
command acceptance, resize finality, reader shutdown, and 64-terminal thread
memory.
