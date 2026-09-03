# Plan 004: Move the Ghostty terminal runtime off the main thread

> **Executor instructions**: Preserve local changes, follow each gate, and
> update `plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 717ed49f..HEAD -- packages/ghostty-core packages/ghostty-react packages/yaade-ui/src/panels tests`
> Confirm Plans 001 and 003 are DONE.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 001 and 003
- **Category**: perf / migration
- **Planned at**: commit `717ed49f`, 2026-08-30

## Why this matters

`GhosttyTerminalCore.write()` and render-state extraction currently run
synchronously on the browser main thread. Large output can therefore compete
with IME, keyboard dispatch, pane layout, drag-and-drop, and React UI. A worker
can own the WASM terminal authority and send validated packed updates while the
main thread retains DOM input, the viewport model, and renderer adapters.

## Current state

- `GhosttyTerminalSurface` directly owns `GhosttyTerminalCore`.
- Key, paste, mouse, selection, scrolling, mode checks, title, scrollbar, and
  snapshots are synchronous core calls.
- `terminal-instance-registry.ts` requires synchronous text/dimension/cursor
  inspection; Plan 001's main-thread retained model must preserve that.
- `terminal-output-writer.ts` invokes `surface.write()` synchronously and calls
  replay acknowledgement callbacks after that parse call returns.
- The host-side core owns query responses; browser core uses
  `responsePolicy: "render-only"`. Preserve this exactly.

## Target design

Add a browser-specific worker adapter in `@yaade/ghostty-react`; keep
`@yaade/ghostty-core` environment-neutral:

- `src/worker/protocol.ts` — versioned discriminated commands/events and runtime
  validation;
- `src/worker/terminal-worker.ts` — owns one or more core instances;
- `src/worker/worker-terminal-core.ts` — main-thread proxy and lifecycle;
- `src/worker/worker-pool.ts` — bounded pool, not one OS worker per hidden
  terminal;
- focused tests and a synchronous in-process adapter for tests/fallback.

Start with parser/core in the worker and rendering on the main thread. Do **not**
move Canvas/WebGL to `OffscreenCanvas` in this plan; that is a separate optional
optimization after worker parsing is proven.

## Commands

- `vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui` → pass
- `vp run typecheck && vp run lint` → exit 0
- focused web E2E suites → pass
- `vp run build:web` and `vp run build:desktop` → worker asset resolves in both
- `vp run test:bench` → pass and main-thread latency comparison recorded

## Scope

**In scope**

- `packages/ghostty-react/src/worker/**` (new)
- `packages/ghostty-react/src/surface.ts`
- `packages/ghostty-react/src/index.ts`
- `packages/ghostty-react/src/vite-env.d.ts` only if required for worker assets
- `packages/yaade-ui/src/panels/TerminalPanel.tsx`
- `packages/yaade-ui/src/panels/terminal-output-writer.ts` and tests only for
  parse acknowledgements required by the worker protocol
- `tests/bench/terminal-throughput.bench.ts`
- focused E2E files

**Out of scope**

- `SharedArrayBuffer`, COOP/COEP changes, OffscreenCanvas rendering, server
  workers, PTY/server protocol changes, worker-per-terminal without a bound.
- Async React state for terminal bytes or viewport contents.

## Steps

### Step 1: Specify a versioned worker protocol

Commands must include protocol version, terminal ID, sequence, and generation.
Required commands: create, write, writeReplay, resetAndWrite, resize, setTheme,
setFontMetrics, key, paste, mouse, selection operations, scroll operations,
viewport query operations needed by behavior, requestFullFrame, and dispose.
Required events: ready, packedUpdate, encodedInput, title, scrollbar, mode/sync
state, parsed acknowledgement, recoverable error, fatal error, and disposed.

Validate every inbound worker event before applying it. Unknown versions,
terminal IDs, generations, or sequences are rejected. Transfer ArrayBuffers;
do not structured-clone nested cell objects.

**Verify**: protocol tests cover every message, malformed external values,
stale generations, duplicate/out-of-order updates, and transfer-list ownership.

### Step 2: Implement the worker runtime and bounded pool

The worker owns `GhosttyTerminalCore` instances in a `Map`. Use a bounded pool
sized from measured workload and hardware concurrency, capped to avoid six
visible panes producing six dedicated workers. Route each terminal consistently
to one worker. A busy terminal must not permanently starve peers; process
bounded byte slices and yield between terminals.

Initialization uses `browserGhosttyWasmSource()` inside the worker and preserves
`render-only` response policy. Dispose removes the core and all queued work.

**Verify**: worker tests create multiple terminals, isolate state, preserve
ordering per terminal, provide fairness under one flood, and free every core.

### Step 3: Implement the main-thread proxy

The proxy presents terminal operations to `GhosttyTerminalSurface`, owns command
sequences, validates events, applies packed updates to the Plan 001 viewport
model, and emits renderer invalidations. It mirrors title, scrollbar, mode,
selection, and cursor state required for synchronous UI reads. Inspection reads
the retained model and never round-trips to the worker.

Key/paste/mouse encoding becomes asynchronous: DOM handlers enqueue commands;
`encodedInput` calls the existing `onData`. Preserve key order with a per-terminal
sequence and never reorder paste relative to key events.

**Verify**: proxy tests cover ordered input, synchronous model inspection,
stale event rejection, dispose, and worker crash.

### Step 4: Preserve parsed/replay acknowledgement semantics

A live/replay chunk is acknowledged only after the worker confirms Ghostty
parsed the complete command sequence—not when `postMessage` succeeds and not
when a frame paints. Replay keeps the PTY callback detached for the entire
batch, matching current `writeReplay`. A worker crash leaves unacknowledged bytes
eligible for authoritative host replay.

Update `terminal-output-writer` only as needed to accept asynchronous parsed
completion while maintaining its queue cap, surrogate-safe slicing, and
cumulative ACK suppression after shedding.

**Verify**: unit and E2E flow-control tests prove no early ACK, replay after
worker failure, and no duplicate query response.

### Step 5: Integrate the worker without changing the surface interface

Keep `GhosttyTerminalSurface` public methods and registry reads compatible.
DOM/IME, pointer capture, links, ResizeObserver, focus, virtual modifiers, and
renderer controller remain on the main thread. Add `runtime=worker|main` data
observability separate from provider/backend.

Retain the in-process main-thread adapter as automatic fallback when Worker or
worker-WASM initialization fails. Do not silently bounce between runtimes after
a terminal has parsed live bytes; failure must request host replay into a fresh
runtime generation before resuming ACKs.

**Verify**: E2E runs worker and forced-main runtime variants through input,
UTF-8 split, selection, links, zoom, reload, replay, and six panes.

### Step 6: Add crash and lifecycle recovery

On worker error/messageerror/termination, stop ACKs, invalidate that generation,
create a fresh runtime through a single-flight recovery path, request
server-authoritative replay from the last parsed/acknowledged frame, and full
repaint. Never kill or resize the PTY merely because the worker failed.

**Verify**: E2E terminates a worker during a numbered flood and asserts final
marker, one recovery, stable PTY ID, no connection loss, and no missing
acknowledged sequence.

### Step 7: Build and benchmark both applications

Verify Vite emits the worker and Tauri embeds it. Compare worker versus forced
main runtime across all benchmarks, adding long-task and animation-frame-delay
samples. Adopt worker by default only if typing-under-flood p95 improves by at
least 15% or long-task time materially drops, while stream throughput and idle
typing do not regress by more than 10%.

## Test plan

Add protocol validation, pool fairness, proxy ordering, parse-ACK, crash,
fallback, stale generation, disposal, and build-asset tests. E2E must exercise
real PTY output rather than only synthetic messages.

## Done criteria

- [ ] Ghostty WASM parsing/render extraction can run outside the main thread.
- [ ] Main thread retains synchronous inspection from the packed viewport model.
- [ ] Input and replay ordering are preserved.
- [ ] ACK means parsed, never merely posted or painted.
- [ ] Worker count and per-terminal queues are bounded.
- [ ] Worker failure recovers through authoritative replay without killing PTY.
- [ ] Browser and Tauri builds resolve the same worker implementation.
- [ ] Main-thread fallback and all gates pass.

## STOP conditions

- Plan 001 still requires direct synchronous access to worker-owned mutable
  snapshot objects.
- Correct input encoding cannot preserve event order asynchronously.
- Worker recovery would ACK bytes that the new core has not replayed.
- Vite/Tauri cannot package the worker without app-specific source forks.
- Benchmark adoption thresholds fail after one profiling-led iteration.

## Maintenance notes

Worker messages form an internal versioned wire interface and must be decoded as
external values. Review sequence/generation handling, transfer ownership,
fairness, worker bounds, and ACK points. OffscreenCanvas and SharedArrayBuffer
remain deferred until this architecture is stable and measured.
