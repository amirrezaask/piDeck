# Plan 017: Isolate socket writing and fan out output only to attached clients

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
>   apps/server/src/server.rs apps/server/src/event_hub.rs \
>   apps/server/src/outbound_mailbox.rs apps/server/src/terminal.rs \
>   apps/server/src/wire.rs apps/server/tests \
>   packages/yaade-rpc/src/terminal-ws.ts \
>   packages/yaade-host-client/src/web-transport.ts \
>   docs/architecture/terminal-runtime.md
> git diff --stat -- \
>   apps/server/src/server.rs apps/server/src/event_hub.rs \
>   apps/server/src/outbound_mailbox.rs apps/server/src/terminal.rs \
>   apps/server/src/wire.rs apps/server/tests \
>   packages/yaade-rpc/src/terminal-ws.ts \
>   packages/yaade-host-client/src/web-transport.ts \
>   docs/architecture/terminal-runtime.md
> ```
>
> Plan 015 changes terminal frames from strings to immutable bytes and introduces
> a temporary globally ordered terminal-frame broadcast. Confirm Plan 015 is
> `DONE`; build on its live `TerminalFrame` type. Do not recreate a string event
> payload. Plan 013 and Plan 018 may touch terminal disposal/history but are not
> prerequisites for this socket/fan-out work.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 015
- **Category**: perf / correctness / architecture
- **Planned at**: commit `7276f526`, 2026-08-30
- **Source findings**: SolPro Ghostty review P0-4 and P0-5

## Why this matters

The active WebSocket loop owns both halves of the socket in one
`tokio::select!`. It awaits `sender.send(...)` for pongs, command results,
replay-required messages, terminal bytes, and metadata. A slow network/client
can therefore delay that same connection's input, ACK, resize, attach, lease,
and close commands.

Terminal output also passes through one global Tokio broadcast. Every socket
wakes for every terminal frame, then checks local attached/raw sets. Cost scales
with total output × total socket connections instead of output × clients
attached to that terminal. The repository already contains a bounded
`OutboundMailbox`, and its architecture doc claims per-browser isolated queues,
but the live socket path bypasses it.

The target gives the socket sink one owner, routes all producers through a
bounded non-awaiting mailbox, and registers terminal subscriptions centrally.
A slow client gets a deterministic replay fence or is closed; it never stalls a
PTY reader, another client, or its own inbound command task.

## Current state

`apps/server/src/server.rs:637-749` directly sends from both select branches:

```rust
message = receiver.next() => {
    // ... dispatch command ...
    if send_json(&mut sender, &response).await.is_err() { break; }
}
event = events.recv() => {
    // every connection receives every terminal:data
    if !attached.contains(id) || !raw.contains(id) { continue; }
    if sender.send(Message::Binary(frame)).await.is_err() { break; }
}
```

`apps/server/src/event_hub.rs` has one `broadcast::Sender`; `subscribe()` gives
all connections the same stream. Terminal data is ephemeral for replay, but it
still wakes all receivers.

`apps/server/src/outbound_mailbox.rs` already bounds three conceptual lanes:
reliable FIFO, ordered raw (`legacy`), and replaceable semantic snapshots. It
has tests for ordering, overflow, and semantic replacement, but `server.rs`
never creates or drains an `OutboundMailbox`.

Current flow credit in `server.rs::TerminalFlow` correctly prevents unlimited
unacknowledged bytes, but overflow sends `terminal:replay-required` by awaiting
the same blocked sink. The reliable recovery signal is therefore not isolated
from the condition it is meant to recover.

`docs/architecture/terminal-runtime.md` states the intended invariant:

> Each browser has an isolated bounded socket queue; a slow viewer cannot pause
> the PTY or another viewer.

This plan makes that statement true rather than creating a second queue module.

## Target design

```text
Connection
  SocketReader task
    WebSocket receiver -> auth/commands/ACK/attach/detach
                       -> synchronous dispatch
                       -> ConnectionOutbound.try_enqueue(...)

  SocketWriter task (only SplitSink owner)
    ConnectionOutbound mailbox + Notify -> await sink.send

EventHub / TerminalFanout
  metadata -> every admitted ConnectionOutbound
  terminal frame -> only attached/raw ConnectionOutbound handles
  semantic state -> only attached semantic handles, latest-wins
```

Use a deep connection module, local to `server.rs` or a focused new
`connection_outbound.rs`, with a small interface equivalent to:

```rust
struct ConnectionOutbound { /* bounded mailbox, flow, subscriptions, notify */ }

impl ConnectionOutbound {
    fn enqueue_reliable(&self, message: Message) -> EnqueueOutcome;
    fn enqueue_terminal(&self, frame: Arc<TerminalFrame>) -> EnqueueOutcome;
    fn enqueue_semantic(&self, terminal_id: &str, frame: Bytes) -> EnqueueOutcome;
    fn acknowledge(&self, terminal_id: &str, sequence: u64);
    fn attach(&self, terminal_id: &str, mode: AttachMode, after: u64);
    fn detach(&self, terminal_id: &str);
    async fn next(&self) -> Option<Message>;
    fn close(&self, code: u16, reason: &'static str);
}
```

No producer method awaits network IO. The writer never calls terminal/runtime
logic. Do not expose `Mutex<OutboundMailbox>` to callers.

Preserve one ordering source for host event sequences. The safest implementation
is to register connection handles in `EventHub` and enqueue metadata/terminal
messages under the same sequence lock that assigns `HostEvent.sequence`.
Metadata iterates admitted connections; terminal output iterates only that
terminal's subscriber handles. This avoids racing separate global/per-terminal
receivers and delivering sequence N+1 before N to one connection.

If Plan 015 revised terminal frames so they no longer participate in the global
host-event cursor, keep that explicit separation instead. Do not merge two
independently scheduled channels while retaining a client-side global ordering
filter; that can silently drop a delayed lower-sequence metadata event.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Server tests | `vp run test:server` | socket/mailbox/fan-out tests pass |
| Rust lint | `vp run lint:server:rust` | fmt and Clippy exit 0 |
| Protocol integration | `vp run test:terminal:integration` | WS attach/replay/flow tests pass |
| Protocol client | `vp run test:terminal:protocol && vp test packages/yaade-host-client` | client ordering/replay tests pass |
| Platform E2E | `vp exec playwright test --project=platform-e2e` | host lifecycle/terminal cases pass |
| Web E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts tests/web/e2e/terminal-compatibility.web.spec.ts` | pass |
| Bench | `vp run test:bench` | fan-out/slow-client gates and existing budgets pass |
| Build | `vp run build:server` | release server builds |

## Suggested executor toolkit

- Use `perfguy` for queue budgets, fan-out scaling, tail latency, and blocked-sink
  tests.
- Use `codebase-design` to keep mailbox policy behind `ConnectionOutbound`
  instead of leaking lane selection into runtime/event producers.
- Use `playwright-best-practices` for multi-client and reconnect/replay tests.

## Scope

**In scope**

- `apps/server/src/server.rs`
- `apps/server/src/event_hub.rs`
- `apps/server/src/outbound_mailbox.rs`
- `apps/server/src/terminal.rs` only for subscriber publication/registration
- `apps/server/src/wire.rs` only for shared terminal-frame/message types
- A focused new `apps/server/src/connection_outbound.rs` or
  `terminal_fanout.rs` if it deepens the module
- `apps/server/src/lib.rs` for module registration
- Rust unit tests and `apps/server/tests/server_parity.rs`
- `packages/yaade-rpc/src/terminal-ws.ts` only if the replay fence or terminal
  frame ordering contract needs a typed adjustment
- `packages/yaade-host-client/src/web-transport.ts` and tests only for that
  typed adjustment
- Focused multi-client E2E/bench additions
- `docs/architecture/rust-server-migration.md`
- `docs/architecture/terminal-runtime.md`
- `plans/README.md` and this plan's status

**Out of scope**

- PTY writer/state ownership, command batching, resize coalescing, or moving
  synchronous runtime work; Plan 019 owns those.
- History representation/background IO; Plans 015/018 own it.
- Browser renderer/worker scheduling.
- An unbounded Tokio channel in front of `OutboundMailbox`.
- Latest-wins replacement for raw PTY bytes.
- Changing attachment semantics, writer leases, auth policy, or process lifetime.
- A second mailbox abstraction alongside `outbound_mailbox.rs`.

## Git workflow

- Do not commit, push, or open a PR unless explicitly instructed.
- Preserve operator and prior-plan changes. Do not reset files.
- No mutex guard may be held across `.await`; Clippy cannot prove this property.
  Review every sink-send path.

## Steps

### Step 1: Characterize blocked-sink and global-wakeup behavior

Add deterministic test adapters:

- a socket sink whose `send` remains pending until a test releases it;
- an outbound observer that counts enqueue/send stages by lane;
- terminal frame publication counters (published, subscriber deliveries,
  connections skipped, queue overflow, replay fences, socket closes);
- inbound command timing independent from writer completion.

Tests must prove the current defect before refactor: while one terminal binary
send is blocked, a subsequent ACK/resize/ping on that connection is not
processed. With 1/8/64 connections attached to only one of several terminals,
record how many receiver wakeups/filter checks each unrelated terminal frame
causes.

Use channels/barriers, not sleeps, to block the sink. Keep metrics payload-free.

**Verify**:

```bash
vp run test:server
```

Expected at this intermediate step: characterization exposes direct-send
coupling/global wakeups; existing functional tests remain green.

### Step 2: Deepen `OutboundMailbox` into the three active lanes

Rename `legacy` concepts to ordered terminal/raw output; keep compatibility
helpers only temporarily while callers migrate. Store encoded `Message` or a
small typed outbound frame without round-tripping through `Vec<u8>` unnecessarily
when Plan 015 already produced `Bytes`.

Required policy:

1. **Reliable FIFO**: command results, protocol hello/snapshot/replay gap,
   lease/security/control events, replay-required, ping/pong, close.
2. **Ordered terminal bytes**: per-terminal sequence order; batch adjacent
   frames only when headers/fences remain exact; never replace.
3. **Replaceable semantic state**: newest pending snapshot per terminal replaces
   older pending state and marks resync according to the existing contract.

Add a terminal `resyncRequired` state. On first raw queue/flow overflow for a
terminal:

- record its parser-acknowledged replay sequence as the safe recovery floor;
- reject all later live terminal frames for that terminal until a successful
  attach/resume resets the state;
- enqueue exactly one reliable `terminal:replay-required`;
- release queued unsent frames newer than the safe floor according to the
  documented recovery policy; do not ACK them;
- if the reliable lane cannot accept the recovery signal, close the connection
  with 1013 rather than dropping the signal or growing memory.

Reliable overflow and malformed internal state close the connection. Semantic
overflow remains latest-wins/resync, never raw-byte replacement.

Add explicit byte/frame high-water getters and fair lane draining. Preserve
cross-lane enqueue order for reliable/raw frames where protocol correctness
requires it; prevent sustained raw output from starving an already-enqueued
reliable response.

**Verify**:

```bash
vp run test:server
```

Expected: deterministic tests cover every overflow, one replay fence, raw order,
reliable response progress, semantic replacement, and byte/frame bounds.

### Step 3: Introduce `ConnectionOutbound` and a single socket writer

After authentication and initial protocol negotiation, move the `SplitSink` into
one writer task. The reader task owns only `SplitStream`, principal/connection
state, and command dispatch. All responses/pongs/errors are encoded and
`try_enqueue_reliable`; they do not await the sink.

`ConnectionOutbound.next()` waits on `Notify` (or equivalent) and pops bounded
mailbox items. Avoid lost-wakeup races by checking the queue before and after
registering for notification. The writer:

- is the only code that calls `sender.send`/`close_socket` after startup;
- stops on sink error, connection cancellation, or queued close;
- records enqueue→send lag and current queue bytes by lane;
- never invokes runtime, history, terminal, auth, or event code;
- does not hold mailbox locks across `await`.

Tie reader, writer, and event registration to one cancellation/lifetime guard.
Whichever side ends first unregisters subscriptions, releases connection leases
exactly once, wakes the other side, and awaits/aborts child tasks without leaks.
Authentication and the initial hello/snapshot may remain sequential before the
split if that materially simplifies admission; no terminal live subscription is
active yet.

**Verify**:

```bash
vp run test:server
vp run lint:server:rust
```

Expected: a blocked sink leaves the reader processing ACK, resize, detach, and
ping/command dispatch; only the writer task is blocked; disconnect cleanup runs
once.

### Step 4: Register attached-only terminal subscribers

Replace the global terminal-data broadcast/filter path with a subscriber index:

```text
terminal_id -> connection_id -> Weak/Arc<ConnectionOutbound>
connection_id -> attached terminal IDs (for cleanup)
```

Keep sequence allocation and dispatch ordering centralized as described in
Target design. Terminal publication constructs one `Arc<TerminalFrame>` and
calls non-awaiting `enqueue_terminal` only on attached/raw subscribers. No
payload clone per subscriber is allowed; encoding may create per-socket frame
headers only when protocol variants differ.

Attach ordering must preserve the replay barrier:

1. mark the connection as attaching/raw before taking the authoritative attach
   snapshot so concurrent live bytes enter its bounded queue;
2. dispatch `terminal:attach` and enqueue its reliable result;
3. client consumes replay and buffered live bytes using existing floors;
4. attach failure rolls back subscription/flow state;
5. detach removes subscriber state before acknowledging success;
6. reconnect/disconnect removes every subscription even if a task exits during
   a blocked send.

Mode `semantic`/`both` retains typed validation; if the current Rust runtime
rejects semantic attach, do not silently subscribe a raw lane.

Security revocation and low-frequency metadata still reach relevant
connections. Keep `EventHub` replay for non-PTY host events; only hot terminal
output leaves all-connection broadcast.

**Verify**:

```bash
vp run test:server
vp run test:terminal:integration
```

Expected with one publishing terminal and 64 connections, 2 attached: exactly 2
terminal enqueue attempts and 62 zero wakeups/filter checks; both attached
clients receive byte-identical ordered frames.

### Step 5: Harden flow overflow and replay recovery

Add end-to-end protocol tests for:

- raw byte queue reaches exact byte/frame limit;
- cumulative ACK frees flow credit;
- overflow emits one reliable replay-required at acknowledged sequence;
- further live bytes are ignored for that terminal without memory growth;
- another attached terminal on the same connection continues normally if the
  reliable mailbox permits;
- another connection on the same PTY is unaffected;
- reattach after durable replay resets the fence and resumes at the first newer
  sequence without duplicate/missing bytes;
- reliable-lane saturation closes 1013 deterministically;
- disconnect during overflow removes subscribers and leases.

Do not resume automatically merely because queue bytes fall after sending; only
an explicit successful replay/attach fence proves parser continuity.

**Verify**:

```bash
vp run test:server
vp test packages/yaade-host-client
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts
```

Expected: exact output after resync, bounded queue metrics, no nested resync loop,
and no impact on fast clients.

### Step 6: Add fan-out and slow-client performance gates

Add a focused Rust benchmark/test harness for terminal frames to 1/8/64
connections with attachment densities 1%, 25%, and 100%. Report publication
latency, enqueue attempts, pointer clones, encoded bytes, queue high water, and
p50/p95/p99 send lag. Add a browser multi-client test with one deliberately
throttled/paused WebSocket and one normal client watching the same real PTY.

Machine gates:

- terminal enqueue attempts equal attached raw subscribers, not total sockets;
- no producer awaits socket send;
- queue bytes never exceed configured limits;
- normal client reaches the final marker and remains within existing flood/input
  budgets while the slow client enters replay-required;
- inbound ACK/resize/close on the slow connection is processed while its writer
  is blocked;
- no PTY reader pause or output loss is attributed to a browser sink.

Record queue constants and rationale; do not copy Ghostty's queue sizes without
measurement. Existing defaults are the starting point.

**Verify**:

```bash
vp run test:server
vp run test:bench
```

Expected: exact counter gates pass and existing terminal budgets are unchanged
or tighter.

### Step 7: Run platform and integration gates

Update both architecture docs so they describe the actual writer owner,
mailbox lanes, subscriber routing, overflow fence, and metrics. Remove stale
comments saying the socket path is isolated if any direct send remains.

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

Expected: all commands exit 0; no direct post-admission socket send exists
outside the writer; no benchmark ceiling is loosened.

## Test plan

- `outbound_mailbox.rs`: lane bounds/order/fairness, one replay fence, reliable
  overflow close, semantic replacement, ACK credit, reattach reset.
- `event_hub.rs`/fan-out: attached-only deliveries, metadata all-client delivery,
  sequence order under concurrent publishers, attach/detach/cleanup races.
- `server.rs`: blocked sink versus inbound commands, single sink owner,
  cancellation, auth/hello, ping/pong, close, writer failure.
- `server_parity.rs`: two fast viewers, slow+fast viewers, overflow→durable replay
  →resume, multiple terminals on one connection.
- Host client: replay-required exactly once, acknowledged floor, no duplicate or
  gap after resume.
- Bench/E2E: 1/8/64 fan-out and real slow-client isolation.

## Done criteria

- [x] Exactly one task owns each WebSocket `SplitSink` after admission.
- [x] Inbound command/ACK processing never awaits socket sending.
- [x] The active path uses `OutboundMailbox`; no parallel unbounded queue exists.
- [x] Reliable, ordered byte, and replaceable semantic lanes have explicit bounds.
- [x] Raw PTY bytes are never latest-wins replaced.
- [x] Overflow emits one replay-required at a safe acknowledged fence or closes 1013 if reliability cannot be guaranteed.
- [x] Only attached/raw clients are considered for a terminal frame.
- [x] One immutable terminal payload allocation is shared across subscribers.
- [x] Metadata/security/replay event ordering remains correct under concurrent publication.
- [x] Slow clients do not stall PTY readers, other clients, or their own inbound task.
- [x] Attach/detach/reconnect cleanup leaves no subscriber or lease leaks.
- [x] Plan-scoped unit, integration, platform, web, build, lint, and benchmark behavior is verified.

## Completion record

`ConnectionOutbound` now deepens the existing bounded mailbox into the active
connection path, while one post-admission writer task exclusively owns the
socket sink. `EventHub` dispatches one shared immutable byte frame only to weak
attached subscribers and retains the common sequence lock. Server, Rust lint,
terminal integration/protocol, host-client, web E2E, platform E2E, and release
server build gates passed. Repository-wide lint and the unrelated renderer
benchmark remain covered by the operator waiver recorded in Plan 015.

## STOP conditions

- Metadata and terminal frames can reach one connection through independent
  queues while the client still rejects lower global event sequences.
- A producer must await or block on socket send to preserve correctness.
- Reliable replay-required can be dropped while raw bytes continue.
- The design uses an unbounded channel or allows queue bytes above configured
  limits.
- Attach snapshot and live subscription cannot form a tested replay fence.
- EventHub/subscriber locks require a reverse lock order with
  `ConnectionOutbound`, creating deadlock risk.
- Correct implementation requires changing PTY ownership/history/browser
  rendering rather than only transport/fan-out seams.

## Maintenance notes

The connection mailbox is a correctness module, not just a performance queue.
Future outbound message kinds must declare a lane, ordering rule, overflow rule,
and replay/recovery behavior. Keep socket sending single-owner and keep producer
interfaces non-awaiting. Reviewers should scrutinize global sequence ordering,
reliable overflow, attach races, lock order, task cancellation, and any raw
payload clone per subscriber.
