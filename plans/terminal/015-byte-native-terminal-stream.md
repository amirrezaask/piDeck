# Plan 015: Keep terminal output byte-native from PTY read to Ghostty WASM

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
>   apps/server/src/terminal.rs apps/server/src/terminal_history.rs \
>   apps/server/src/event_hub.rs apps/server/src/server.rs apps/server/src/wire.rs \
>   packages/yaade-rpc packages/yaade-host-client packages/yaade-workspace \
>   packages/ghostty-core packages/ghostty-react \
>   packages/yaade-ui/src/panels/TerminalPanel.tsx \
>   packages/yaade-ui/src/panels/terminal-output-writer.ts \
>   tests/web/e2e/terminal-compatibility.web.spec.ts tests/bench
> git diff --stat -- \
>   apps/server/src/terminal.rs apps/server/src/terminal_history.rs \
>   apps/server/src/event_hub.rs apps/server/src/server.rs apps/server/src/wire.rs \
>   packages/yaade-rpc packages/yaade-host-client packages/yaade-workspace \
>   packages/ghostty-core packages/ghostty-react \
>   packages/yaade-ui/src/panels/TerminalPanel.tsx \
>   packages/yaade-ui/src/panels/terminal-output-writer.ts \
>   tests/web/e2e/terminal-compatibility.web.spec.ts tests/bench
> ```
>
> At plan creation, commit `7276f526` includes operator work in terminal theme
> and query handling. The working tree also contains Plan 014 and `.pi/` output.
> Preserve those changes. Plan 014 owns WebGL scene submission; this plan must
> not edit renderer batching, glyph atlas, or WebGL code. If terminal output is
> already represented as bytes at any seam listed below, keep that implementation
> and continue from the first remaining string seam instead of adding a parallel
> representation.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: perf / correctness / architecture
- **Planned at**: commit `7276f526`, 2026-08-30
- **Source finding**: SolPro Ghostty review P0-1

## Why this matters

Normal PTY output currently becomes a Rust `String`, is cloned into replay and
JSON-shaped event data, is encoded into a binary WebSocket frame, is decoded to
a JavaScript string, is queued and joined as UTF-16, and is encoded again before
`ghostty_terminal_vt_write`. Besides allocation and UTF-8 work, malformed bytes
are replaced with `U+FFFD`, so durable replay cannot reproduce the process's
actual byte stream.

The target is one immutable byte chunk per PTY read, shared by bounded replay,
history, and live fan-out. The browser keeps payloads as `Uint8Array` through
transport, replay coordination, frame scheduling, and the worker protocol.
Only terminal IDs and inherently textual metadata are decoded. WebSocket framing
and frame-level coalescing may still need a bounded copy. The path removes each
bytes→terminal-text→bytes conversion.

## Current state

### Rust decodes and clones each PTY read

`apps/server/src/terminal.rs:198-204` stores replay as text:

```rust
struct ReplayChunk {
    sequence: u64,
    data: String,
    bytes: usize,
}
```

`terminal.rs:868-958` calls `decode_pty_utf8`, clones the resulting `String` into
replay, scans the string, feeds `vt100` using `data.as_bytes()`, appends text to
history, and emits `serde_json::Value::String` through `EventHub`:

```rust
let data = decode_pty_utf8(&mut pending_utf8, &buffer[..read]);
state.replay.push_back(ReplayChunk {
    sequence,
    data: data.clone(),
    bytes,
});
// ...
host.history.append(&entry.id, sequence, &data)?;
host.events.emit(
    "terminal:data",
    vec![json!(entry.id), json!(data), json!(sequence)],
);
```

The malformed-input test at `terminal.rs:1417-1422` explicitly expects `0xff`
to become `U+FFFD`. That behavior is incompatible with exact terminal replay.

### The binary frame payload is decoded as UTF-8

`packages/yaade-rpc/src/terminal-ws.ts:68-104` decodes both the ID and remainder:

```ts
const id = utf8Decode(buf.subarray(19, 19 + idLen));
const data = utf8Decode(buf.subarray(19 + idLen));
return { eventSequence, terminalSequence, id, data };
```

`packages/yaade-host-client/src/web-transport.ts:726-760` then creates a generic
`HostEvent` whose `args` contain that string. `create-yaade-api.ts` buffers by
`data.length`, and `packages/yaade-workspace/src/types.ts` exposes `onData` and
replay chunks as strings.

### Browser scheduling and the worker protocol are string-shaped

`packages/yaade-ui/src/panels/terminal-output-writer.ts` queues strings, joins
them, counts UTF-16 characters, and contains surrogate-boundary slicing logic.
`packages/ghostty-react/src/worker/protocol.ts` declares:

```ts
| { readonly type: "write"; readonly data: string }
| { readonly type: "writeReplay"; readonly chunks: readonly string[] }
| { readonly type: "resetAndWrite"; readonly data: string }
```

`GhosttyTerminalCore.write` already accepts `string | Uint8Array`, so the final
encoding is avoidable.

### Durable replay is text JSON

`apps/server/src/terminal_history.rs` stores `HistoryRecord { data: String }`,
serializes records to JSON, then gzip-compresses the JSON. Attach and replay-page
RPC schemas expose arrays of strings. This loses malformed bytes before they
reach disk and expands raw data before compression.

### Applicable repository conventions

- `apps/server/src/wire.rs::encode_terminal_data_frame` already uses
  `bytes::Bytes`/`BytesMut`; keep that ownership model.
- External TypeScript data is validated in `packages/yaade-rpc/src/routes.ts`
  with Effect Schema. For JSON replay fields, use the existing Effect
  `Schema.Uint8ArrayFromBase64` transformation rather than hand-casting unknown
  values or duplicating encoded/decoded models.
- Package exports point to source, ESM imports retain `.js`, and no `any`, unsafe
  TypeScript casts, or unvalidated worker messages may be introduced.
- `docs/architecture/terminal-runtime.md` requires bounded replay, exact gap
  recovery, parser ACK after consumption, and no browser-induced PTY blocking.

## Target design

```text
SERVER
PTY read -> Bytes
            ├─ bounded replay VecDeque<Bytes>
            ├─ byte scanners / vt100 transitional recorder
            ├─ binary history block encoder
            └─ Arc<TerminalFrame> -> WebSocket binary payload

CLIENT
WebSocket ArrayBuffer
  -> decode fixed header + UTF-8 terminal ID only
  -> payload Uint8Array view
  -> bounded byte replay/live coordinator
  -> byte-aware output scheduler
  -> transferable writeBytes command
  -> GhosttyTerminalCore.write(Uint8Array)
```

Introduce one Rust live-frame model instead of smuggling terminal bytes through
`HostEvent.args`:

```rust
struct TerminalChunk {
    sequence: u64,
    data: Bytes,
}

struct TerminalFrame {
    event_sequence: u64,
    terminal_id: Arc<str>,
    chunk: TerminalChunk,
}
```

For this plan, `EventHub` may still broadcast every `TerminalFrame` globally so
socket behavior remains unchanged. Use one ordered hub message enum for metadata
and terminal frames so separate receivers cannot reorder global event sequence.
Plan 017 replaces this global terminal broadcast with attached-only fan-out.

The decoded browser shape is:

```ts
type DecodedTerminalDataFrame = {
  readonly eventSequence: number
  readonly terminalSequence: number
  readonly terminalId: string
  readonly payload: Uint8Array<ArrayBuffer>
}
```

The view may borrow the WebSocket `ArrayBuffer`; code that retains or transfers
it must make ownership explicit. Do not transfer a buffer while another
listener or replay bridge still references it. A bounded one-copy coalesced
worker post is acceptable; silently detaching shared transport state is not.

Cold attach/history responses remain JSON RPC in this plan. Encode their byte
fields as base64 on the wire and decode them to `Uint8Array` at the canonical
Effect Schema seam. Base64 is a cold transport encoding, not terminal text; no
`TextDecoder`/`TextEncoder` may process those payload bytes.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Rust unit/integration | `vp run test:server && vp run test:terminal:integration` | all tests pass |
| Protocol tests | `vp run test:terminal:protocol && vp run test:terminal:unit` | byte frame/replay tests pass |
| Browser package tests | `vp test packages/yaade-rpc packages/yaade-host-client packages/yaade-workspace packages/ghostty-core packages/ghostty-react packages/yaade-ui` | all tests pass |
| Typecheck/lint | `vp run typecheck && vp run lint && vp run lint:server:rust` | exit 0 |
| Compatibility E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts` | exact-byte/Unicode/query cases pass |
| Multiplexer E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts` | attach/reconnect/replay cases pass |
| Bench | `vp run test:bench` | existing budgets pass; byte counters are printed |
| Shared builds | `vp run build:server && vp run build:web && vp run build:desktop` | all build |

## Suggested executor toolkit

- Use `effect-ts` for the replay byte schema and route decoding. Prefer one
  logical `Uint8Array` model with `Schema.Uint8ArrayFromBase64` at the JSON seam.
- Use `perfguy` for allocation/bytes-moved counters and matched benchmark runs.
- Use `frontend-performance` for `ArrayBuffer` ownership and worker-transfer
  profiling.
- Use `playwright-best-practices` and `webapp-verification` for real PTY byte
  fixtures; assert parser output and replay bytes, not only browser events.

## Scope

**In scope**

- `apps/server/src/terminal.rs`
- `apps/server/src/terminal_history.rs`
- `apps/server/src/event_hub.rs`
- `apps/server/src/wire.rs`
- `apps/server/src/server.rs`
- Focused Rust tests in those modules and `apps/server/tests/server_parity.rs`
- `packages/yaade-rpc/src/terminal-ws.ts` and its tests
- `packages/yaade-rpc/src/routes.ts`, `host.ts`, and focused route tests
- `packages/yaade-host-client/src/web-transport.ts`,
  `create-yaade-api.ts`, and focused tests
- `packages/yaade-workspace/src/types.ts`
- `packages/ghostty-core/src/core.ts` and focused tests
- `packages/ghostty-react/src/worker/protocol.ts`, `worker-pool.ts`,
  `terminal-worker.ts`, `worker-terminal-core.ts`, `surface.ts`, and tests
- `packages/yaade-ui/src/panels/terminal-output-writer.ts` and tests
- `packages/yaade-ui/src/panels/TerminalPanel.tsx` only for byte callback/replay
  plumbing; no visible UI or renderer changes
- `tests/web/e2e/terminal-compatibility.web.spec.ts`
- Existing terminal benchmark fixtures/counters where needed
- `docs/architecture/terminal-runtime.md`
- `plans/README.md` and this plan's status

**Out of scope**

- Render-update buffer recycling; Plan 016 owns it.
- Socket reader/writer task separation and per-terminal subscribers; Plan 017.
- Moving history compression/IO to a background owner; Plan 018.
- Replacing `vt100` with native libghostty-vt; Plan 023.
- Removing string input for keyboard, paste, local error/status text, titles,
  cwd, URLs, or other inherently textual data.
- A new semantic terminal protocol, WebGPU, SharedArrayBuffer, or renderer work.
- Preserving the old on-disk JSON history format. The repository permits a
  history/state reset instead of migration machinery.

## Git workflow

- Do not commit, push, or open a PR unless the operator explicitly asks.
- Never reset or overwrite Plan 014, `.pi/`, or operator theme/query changes.
- Keep changes ordered so Rust byte storage/frame tests land before client type
  changes, then switch all callers in one final integration step.

## Steps

### Step 1: Add exact-byte characterization tests and counters

Before changing production types, add fixtures covering:

1. ASCII and ANSI-heavy output.
2. One UTF-8 code point split across three PTY writes/reads.
3. An invalid byte followed by valid ASCII.
4. An incomplete UTF-8 prefix at process exit.
5. OSC 7 and terminal-query sequences split at every byte boundary.
6. Attach from the in-memory ring and from reopened durable history.
7. Live output arriving while a replay page is being consumed.

The Rust assertions must compare byte slices, including invalid/incomplete
bytes. Replace the old expectation that malformed input becomes `U+FFFD` with
an exact-byte expectation only after the byte path exists. Add payload-free
counters for PTY bytes read, chunks created, replay bytes retained, frame bytes,
and history bytes accepted. In browser tests, add counters for transport payload
bytes, scheduler bytes, worker bytes posted, and UTF-8 terminal-payload
encode/decode calls. The last counter must remain zero in normal operation.

Do not use `TextDecoder` in the test to prove exactness. Search byte arrays for
ASCII markers with a byte matcher; use Ghostty-rendered text only as the separate
semantic assertion.

**Verify**:

```bash
vp run test:server
vp run test:terminal:protocol
vp test packages/yaade-host-client packages/ghostty-react packages/yaade-ui
```

Expected at this intermediate point: existing tests pass and the new invalid-byte
characterization demonstrates the old lossy behavior until Step 2 switches it.

### Step 2: Make the Rust live path immutable and byte-oriented

In `terminal.rs`:

- Replace `ReplayChunk.data: String` plus the redundant `bytes` field with
  `Bytes`; `Bytes::len()` is authoritative.
- Delete `decode_pty_utf8` and `pending_utf8` from the PTY output loop.
- Copy each successful `reader.read` region once into `Bytes` (or freeze a
  reusable `BytesMut` without retaining the 64 KiB scratch buffer indefinitely).
- Increment sequence once per non-empty PTY byte chunk.
- Clone `Bytes` handles instead of payloads into replay/history/fan-out.
- Feed the transitional `vt100::Parser` directly with `&chunk`.
- Convert OSC 7 and terminal-query scanners into bounded streaming byte
  scanners. Decode only a completed textual OSC payload after its delimiter is
  recognized. Scanner carry buffers must have explicit maximum sizes and reset
  on overflow/malformed control input.
- Queue terminal-query response bytes without converting the original output.

Add `TerminalFrame`/`HubMessage` in `wire.rs` or `event_hub.rs`. Keep metadata
`HostEvent` unchanged, but terminal output must no longer be represented as
`serde_json::Value`. `EventHub` allocates the current event sequence and
publishes `Arc<TerminalFrame>` through the same ordered broadcast message stream.
The socket filters attached/raw terminal IDs as before and calls
`encode_terminal_data_frame(..., &frame.chunk.data)` directly.

**Verify**:

```bash
vp run test:server
vp run lint:server:rust
```

Expected: invalid/split input remains byte-for-byte in replay; OSC/query tests
still pass for every split; `rg 'json!\(data\)|decode_pty_utf8|data: String' apps/server/src/terminal.rs`
returns no terminal-output matches.

### Step 3: Replace text JSON history records with a minimal binary block codec

Keep history synchronous for now; Plan 018 moves it off the reader. Change only
the representation so Plan 015 never reintroduces a terminal `String` merely to
persist it.

Define and test a versioned binary block format with fixed endianness:

```text
block header: magic, format version, record count
record:       u64 sequence, u32 payload length, payload bytes
```

Requirements:

- reject zero/duplicate/decreasing sequences and lengths above configured limits;
- detect truncation/trailing garbage as `HistoryError::Corrupt`;
- write temporary file then rename as today;
- keep the manifest metadata JSON if useful, but raw output records may not be
  JSON or JSON byte arrays;
- continue gzip temporarily so this step does not mix representation and
  scheduling/compressor decisions;
- bump the archive format version and reset/quarantine old v1 JSON archives;
  do not add a migration reader;
- make `TerminalHistoryPage.chunks` byte chunks.

`append` accepts `Bytes` or `&[u8]` and does not copy until the staging block
requires ownership. Reopened history must reproduce malformed bytes exactly.

**Verify**:

```bash
vp run test:server
```

Expected: binary codec corruption/truncation tests pass, restart replay compares
exact bytes, and `rg 'HistoryRecord|serde_json::to_vec\(&records\)|\.json\.gz' apps/server/src/terminal_history.rs`
finds no old raw-record format.

### Step 4: Decode terminal frame headers without decoding payloads

Change `decodeTerminalDataFrame` so only the ID slice is UTF-8 decoded and the
remaining slice is returned as `payload: Uint8Array<ArrayBuffer>`. Preserve v1
and v2 frame layout decoding if mixed protocol support remains required; both
return bytes. Validate header sizes before constructing views and reject unsafe
sequence values exactly as today.

In `web-transport.ts`, do not construct a generic string-shaped `HostEvent` for
terminal data. Add a typed hot-path dispatch method or event shape carrying the
byte view, sequence, and acknowledgement closure. Metadata events continue
through `acceptHostEvent`; preserve current ordering until Plan 017 changes
fan-out. Keep `socket.binaryType = "arraybuffer"`.

Document borrowing: callbacks may synchronously inspect the payload. Any module
that buffers it must retain its `ArrayBuffer`; any module that transfers it must
be the sole owner. Add tests that retain a frame across another WebSocket event
and prove the bytes are stable.

**Verify**:

```bash
vp run test:terminal:protocol
vp test packages/yaade-rpc packages/yaade-host-client
vp run typecheck
```

Expected: malformed payload bytes decode successfully as bytes; malformed IDs
or headers fail; no `TextDecoder.decode` call receives the payload slice.

### Step 5: Make attach, replay, and workspace interfaces byte-native

Use one decoded `Uint8Array` model across `@yaade/rpc`, `@yaade/host-client`, and
`@yaade/workspace`:

- `TerminalReplayChunk.data` is `Uint8Array`.
- `HostTerminal.onData` receives `Uint8Array`.
- attach `outputChunks` and replay-page `chunks` decode to byte arrays.
- the transitional checkpoint field becomes byte-oriented (for example
  `syntheticBytes`) so applying it never requires `TextEncoder`; Plan 024 owns
  the checkpoint replacement decision.
- remove the redundant attach `output: string` field if no protocol-1 caller
  needs it; otherwise encode/decode it as bytes too.

At JSON RPC seams, use `Schema.Uint8ArrayFromBase64`. On Rust responses, use a
small validated base64-byte wrapper so only cold JSON serialization sees base64
strings. Do not expose base64 to UI/worker callers and do not hand-write unsafe
casts after decode.

Change reconnect buffers and limits from chars to bytes. Preserve all replay
semantics: cumulative ACK only after parser consumption, live bytes bounded
while replay streams, gap detection on shedding, replay pages parsed in order,
and no ACK for discarded prefixes.

Update marker-oriented tests/callbacks to use byte search. Do not decode the
whole terminal stream merely to keep a diagnostic callback's old string type.

**Verify**:

```bash
vp run test:terminal:unit
vp test packages/yaade-rpc packages/yaade-host-client packages/yaade-workspace
vp run typecheck
```

Expected: reconnect/replay tests compare byte arrays, invalid bytes survive
base64 JSON replay exactly, and all configured limits are byte counts.

### Step 6: Make the output scheduler and Ghostty worker protocol byte-aware

Refactor `terminal-output-writer.ts` to queue `Uint8Array` parts and count
`byteLength`. Replace string join/slice/surrogate logic with byte range logic.
When coalescing multiple parts, allocate one exact or geometrically reusable
buffer per parser flush, copy each range once, and retain callback fences so an
ACK fires only after the final byte of its originating frame is parsed. A single
already-owned contiguous part may pass through without copying if it will not
be transferred out from under another owner.

Replace worker commands with `writeBytes`, `writeReplayBytes`, and
`resetAndWriteBytes` (names may follow local style). Worker message validation
must require `Uint8Array`, byte offsets/lengths within an `ArrayBuffer`, and the
current envelope generation. Extend `TerminalWorkerChannel.post` to accept a
transfer list. Transfer only buffers the sender exclusively owns; otherwise
copy into the scheduler-owned coalescing buffer first.

Update `TerminalCoreRuntime`, `GhosttyTerminalSurface`, and main-thread fallback
to accept bytes for host output/replay. Keep string overloads only for local UI
status/error text and keyboard/input encoding. The worker must call
`GhosttyTerminalCore.write(Uint8Array)` directly.

The output writer currently scans strings for DEC cursor visibility. Replace it
with a bounded byte subsequence scan or remove the legacy refresh hook if current
Ghostty dirty tracking makes it unnecessary; never decode the payload for this
scan.

**Verify**:

```bash
vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui
vp run typecheck
```

Expected: split/capped byte and ACK tests pass; worker protocol rejects detached
or out-of-range views; normal worker writes invoke no terminal-payload
`TextEncoder`.

### Step 7: Prove exactness and measure the complete path

Extend real PTY/server/browser coverage:

- split valid UTF-8 still renders one correct code point;
- malformed and incomplete bytes are retained exactly by live capture, ring
  replay, durable replay, and restart replay;
- ASCII/Unicode/ANSI/TUI fixtures render as before;
- query response, title, cwd, reconnect, replay-required, worker recovery, and
  main-thread fallback remain correct;
- two viewers receive independent stable byte views and ACK independently.

Add or expose allocation counters sufficient to report, per workload:

```text
pty bytes read
Rust payload allocations / Bytes clones
WebSocket payload bytes
browser payload bytes
scheduler coalescing allocations/bytes copied
worker input transfers
terminal payload TextEncoder/TextDecoder calls
```

Run three matched release benchmark sets. Keep the change only if existing p95/
p99 budgets remain green and terminal-payload encode/decode calls are zero.
Report allocation/throughput changes without claiming latency improvement when
results are within noise.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:web
vp run test:terminal:protocol
vp run test:terminal:integration
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-compatibility.web.spec.ts \
  tests/web/e2e/terminal-multiplexer.web.spec.ts
vp run test:bench
vp run build:server
vp run build:web
vp run build:desktop
```

Expected: all commands exit 0; byte exactness passes across restart; no existing
budget is loosened.

## Test plan

- `terminal.rs`: exact byte ring, invalid/incomplete UTF-8, bounded split OSC 7,
  split terminal query, query response bytes, replay eviction by byte length.
- `terminal_history.rs`: binary codec round-trip, malformed/truncated blocks,
  sequence validation, old-format reset, exact restart replay.
- `event_hub.rs`/`wire.rs`: `Arc<Bytes>` fan-out, global ordering, binary frame
  layout, ID limit, payload with every byte value.
- `terminal-ws.test.ts`: payload view, invalid UTF-8 payload, split frame header,
  v1/v2 layouts, no payload decode.
- Host client: byte buffering, byte limits, replay/live fence, multiple listeners,
  ACK after consumption, buffer ownership/detachment, resync.
- Output writer: byte coalescing, slicing, shedding, no prefix ACK, suspended-rAF
  parsing, replay bypass, contiguous fast path.
- Worker/core: transferable byte command validation, direct `Uint8Array` write,
  replay callback detach, main fallback, recovery generation.
- Real PTY E2E: rendered valid Unicode plus exact malformed-byte transport and
  durable replay assertions.

## Done criteria

- [x] Normal PTY output is represented as `Bytes` from the read loop through replay, history acceptance, and WebSocket framing.
- [x] `terminal:data` no longer stores payload bytes in `serde_json::Value` or a Rust `String`.
- [x] The browser decodes only the terminal ID; terminal payload remains a `Uint8Array`.
- [x] Host-client, workspace, replay, scheduler, surface, and worker interfaces use byte counts and byte payloads.
- [x] Ghostty WASM receives `Uint8Array` without a terminal-payload `TextEncoder` pass.
- [x] Invalid and incomplete UTF-8 survives live, ring, disk, restart, and client replay byte-for-byte.
- [x] Raw history blocks are binary records, not JSON strings/arrays.
- [x] ACK, replay-required, bounded buffering, and worker-recovery semantics remain correct.
- [x] ASCII, Unicode, ANSI, TUI, title/cwd, and terminal-query compatibility tests pass.
- [x] Plan-scoped unit, integration, E2E, build, lint, typecheck, and benchmark behavior is verified without loosened budgets.

## Completion record

Verified on committed baseline `3b64ad59` in the isolated terminal-foundation
worktree. Server, terminal protocol/unit, scoped package, typecheck, Rust lint,
web, compatibility E2E, and multiplexer E2E gates passed. Three benchmark runs
were recorded on Apple M4 / 24 GiB / macOS 27.0; the operator explicitly waived
the pre-existing repository-wide anti-slop lint baseline and the unrelated Plan
014 renderer-submission benchmark instability (`sceneCompactions` 0/3/3). No
budget was changed and no latency improvement is claimed.

## STOP conditions

- A proposed transfer can detach an `ArrayBuffer` still retained by reconnect
  buffering, another listener, or an ACK fence.
- Exact durable replay would require keeping the old lossy UTF-8 decoder.
- JSON route decoding would expose base64 strings beyond the RPC seam instead
  of decoded `Uint8Array` values.
- A scanner needs an unbounded carry buffer or decodes every PTY chunk to text.
- The implementation changes host input strings/keyboard encoding when only
  output bytes need migration.
- Socket task separation, subscriber routing, history background ownership,
  native Ghostty FFI, or WebGL code becomes necessary; those belong to later
  plans.
- Tests cannot distinguish exact transport bytes from Ghostty's visual
  replacement policy for malformed input.
- The change breaks protocol-1 support in a way not covered by an explicit
  product decision and compatibility test.

## Maintenance notes

Treat terminal output as opaque ordered bytes at every generic transport and
storage seam. Decode only inside a protocol parser that owns streaming
boundaries. Future listeners must state whether they borrow, retain, copy, or
transfer a payload buffer. Reviewers should scrutinize buffer lifetime, byte
versus UTF-16 length, replay ACK fences, scanner bounds, and cold base64 not
leaking into hot interfaces. Plan 017 will replace the temporary global
`TerminalFrame` broadcast; keep the byte frame model independent from
`HostEvent` so that move is mechanical.
