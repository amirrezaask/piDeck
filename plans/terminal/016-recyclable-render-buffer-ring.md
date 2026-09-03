# Plan 016: Recycle a bounded three-slot render-update buffer ring

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
>   packages/ghostty-core/src/render-update.ts \
>   packages/ghostty-core/src/core.ts \
>   packages/ghostty-react/src/worker \
>   packages/ghostty-react/src/surface.ts \
>   packages/ghostty-react/src/scheduler \
>   packages/yaade-app/src/test-bridge.ts tests/bench tests/web/e2e
> git diff --stat -- \
>   packages/ghostty-core/src/render-update.ts \
>   packages/ghostty-core/src/core.ts \
>   packages/ghostty-react/src/worker \
>   packages/ghostty-react/src/surface.ts \
>   packages/ghostty-react/src/scheduler \
>   packages/yaade-app/src/test-bridge.ts tests/bench tests/web/e2e
> ```
>
> Plan 014 owns retained WebGL submission and may also touch `surface.ts`, the
> test bridge, and benchmarks. Plan 015 changes worker write payloads to bytes.
> Execute this plan after Plan 015 and do not execute it concurrently with Plan
> 014 in one working tree. Reconcile their current interfaces before editing;
> do not restore the string worker protocol or alter WebGL scene code.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 015
- **Category**: perf / robustness / architecture
- **Planned at**: commit `7276f526`, 2026-08-30
- **Source finding**: SolPro Ghostty review P0-2

## Why this matters

`GhosttyRenderUpdateBuilder` looks pooled, but the normal worker path transfers
all eight typed-array buffers to the main thread, detaching them in the worker.
The worker immediately marks the originating slot free. On the next frame every
`ensureU*` check sees a detached zero-byte buffer and allocates replacement
arrays. The main-thread `releaseRenderUpdate()` is a no-op, so buffers never
return.

The target is an ownership ring: the worker owns free slots, the main thread owns
in-flight slots, and releasing an applied update transfers all buffers back to
the worker. Three slots bound memory and let parsing continue while two frames
are pending/in presentation. If all slots are in flight, parsing and ACK continue,
Ghostty dirty state accumulates, and one newest update is emitted when a slot
returns. The worker must not allocate slot four.

## Current state

`packages/ghostty-core/src/render-update.ts:105-120` treats detached buffers as
unusable:

```ts
function ensureU8(value: Uint8Array, required: number): Uint8Array {
  return value.buffer.byteLength > 0 && value.length >= required
    ? value
    : new Uint8Array(nextCapacity(required));
}
```

The builder starts with one slot and grows without a hard maximum whenever all
slots are busy:

```ts
const slot = this.slots.find(candidate => !candidate.busy) ?? createSlot();
if (!this.slots.includes(slot)) this.slots.push(slot);
```

`packages/ghostty-react/src/worker/terminal-worker.ts:56-59` transfers then
releases the detached worker-side update:

```ts
const update = core.renderUpdate(true, forceFull);
post({ ...envelope(command), type: "packedUpdate", update, state: state(core) },
  terminalRenderUpdateTransferList(update));
core.releaseRenderUpdate(update);
```

`worker-terminal-core.ts:280-282` receives updates but does nothing on release:

```ts
drainRenderUpdates(): readonly GhosttyRenderUpdate[] { return this.updates.splice(0); }
releaseRenderUpdate(): void {}
```

It also drops the oldest update with `shift()` if more than eight arrive, which
would strand transferred buffers once recycling exists.

The applicable ownership pattern is already present on the main-thread path:
`surface.ts` releases every consumed update in a `finally` block. This plan makes
that interface real for worker-backed updates instead of adding a second
lifecycle callback in React/UI code.

## Target design

```text
Worker slot FREE
  -> build update lease (slotId + typed-array views)
  -> transfer eight ArrayBuffers
Worker slot IN_FLIGHT / main owns buffers
  -> validate + apply to retained viewport
  -> releaseRenderUpdate(update)
  -> transfer slotId + eight ArrayBuffers back
Worker validates return, reconstructs capacity views, marks slot FREE
  -> emit one coalesced pending update if needed
```

Use exactly three slots per worker terminal runtime. Keep slot identity outside
`GhosttyRenderUpdate` so the renderer-neutral packed update format does not gain
worker ownership metadata. A worker event/command can carry `slotId` alongside
the update/recycle payload.

The core/builder interface must permit a no-slot result **before** dirty state is
consumed. An interface equivalent to this is acceptable:

```ts
type GhosttyRenderUpdateLease = {
  readonly slotId: number
  readonly update: GhosttyRenderUpdate
}

tryRenderUpdate(consumeDirty?: boolean, forceFull?: boolean):
  GhosttyRenderUpdateLease | null

reclaimRenderUpdate(slotId: number, buffers: RenderUpdateBuffers): boolean
```

Do not call `snapshot(true)` and then discover no slot; that would acknowledge
dirty rows without delivering them. Main-thread rendering may retain its simple
`renderUpdate()` wrapper because it builds/applies/releases synchronously.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Core/worker unit | `vp test packages/ghostty-core packages/ghostty-react` | all tests pass |
| UI integration unit | `vp test packages/yaade-ui` | output/surface tests pass |
| Typecheck/lint | `vp run typecheck && vp run lint` | exit 0 |
| Compatibility E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts` | worker/main and renderer cases pass |
| Multiplexer E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts` | resident/recovery cases pass |
| Bench | `vp run test:bench` | buffer-allocation gate and existing budgets pass |
| Shared builds | `vp run build:web && vp run build:desktop` | both build |

## Suggested executor toolkit

- Use `frontend-performance` for transferable ownership, allocation profiling,
  and worker/main-thread scheduling.
- Use `perfguy` for bounded memory, steady-state allocation counters, and
  high-water behavior.
- Use `codebase-design` to keep lease/reclaim complexity behind the render-update
  builder and `TerminalCoreRuntime.releaseRenderUpdate` interface.
- Use `playwright-best-practices` for worker recovery and hidden/resident terminal
  tests.

## Scope

**In scope**

- `packages/ghostty-core/src/render-update.ts`
- `packages/ghostty-core/src/render-update.test.ts`
- `packages/ghostty-core/src/core.ts`
- Focused `ghostty-core` runtime tests
- `packages/ghostty-react/src/worker/protocol.ts`
- `packages/ghostty-react/src/worker/protocol.test.ts`
- `packages/ghostty-react/src/worker/worker-pool.ts`
- `packages/ghostty-react/src/worker/terminal-worker.ts`
- `packages/ghostty-react/src/worker/worker-terminal-core.ts`
- Focused worker/pool tests or a new deterministic worker harness
- `packages/ghostty-react/src/surface.ts` only if release/disposal diagnostics
  need plumbing; preserve Plan 014 changes
- `packages/ghostty-react/src/scheduler/terminal-frame-scheduler.ts` only for
  allocation/in-flight metrics
- `packages/yaade-app/src/test-bridge.ts` only for mirrored diagnostics
- Focused terminal E2E/bench additions
- `docs/terminal-renderers.md`
- `plans/README.md` and this plan's status

**Out of scope**

- Worker input byte migration (Plan 015), synchronized-output/visibility worker
  scheduling (Plan 025), or changing the worker pool size/hash policy.
- WebGL retained scene, VBO upload, atlas, Canvas, or renderer semantics (Plan 014).
- SharedArrayBuffer/cross-origin isolation.
- More than three normal in-flight slots, an unbounded emergency pool, or
  parsing backpressure tied to paint completion.
- Eliminating all allocations during startup, geometry/font growth, recovery,
  or exceptional high-water frames. The requirement is bounded startup/growth
  and zero steady-state replacement caused by transfer detachment.

## Git workflow

- Do not commit, push, or open a PR unless explicitly instructed.
- Preserve all operator and Plan 014/015 work; never use reset/checkout.
- Keep ESM `.js` imports and strict worker-boundary validation. Do not use `any`,
  unsafe casts, or trust a returned buffer solely because `slotId` matches.

## Steps

### Step 1: Add allocation and ownership characterization

Instrument `GhosttyRenderUpdateBuilder` with test/debug counters that distinguish:

```text
slotsCreated
backingBuffersAllocated
backingBytesAllocated
leasesBuilt
leasesReclaimed
reclaimRejected
noFreeSlot
maxInFlight
```

Counters must not retain updates or payloads. Add a deterministic transfer test
using `structuredClone(value, { transfer })` (or a real worker harness where
supported): build, transfer, confirm worker views detach, return buffers,
reclaim, and build again. Record the current failure: the second build allocates
replacement backing arrays and the worker release path sends nothing back.

Add tests for all eight buffers, duplicate release, unknown slot, wrong typed
alignment, undersized/mismatched buffers, stale generation, dispose with
in-flight slots, and recovery replacing a worker.

**Verify**:

```bash
vp test packages/ghostty-core packages/ghostty-react
```

Expected before implementation: new final recycling assertions expose the
current no-op release/allocation behavior; existing tests remain green.

### Step 2: Make render-update slots fixed, leased, and reclaimable

Change `GhosttyRenderUpdateBuilder` to create three stable slot records for the
worker path. Each slot has an explicit state (`free` or `inFlight`) and monotonically
increasing lease generation/token so a delayed return cannot free a newer lease.
Do not use object identity across worker transfer as the ownership key.

Provide a `hasFreeSlot`/`tryBuild` path. Ensure `GhosttyTerminalCore` checks slot
availability before calling the dirty-consuming `snapshot(true)`. If no slot is
free, return `null` and leave Ghostty/render-state dirty flags untouched. A
force-full request remains pending until a lease can be built.

On reclaim:

- validate slot ID and lease token/generation;
- require exactly eight `ArrayBuffer`s;
- validate non-detached lengths and element alignment for U8/U16/U32 arrays;
- reconstruct full-capacity typed arrays from returned backing buffers, not only
  the logical subarray lengths transferred in the update;
- reject duplicate/stale/malformed returns without changing slot state;
- mark the slot free exactly once.

Keep the existing main-thread `release(update)` behavior through a small wrapper
or one-slot synchronous mode. Do not expose builder internals to `surface.ts`.

**Verify**:

```bash
vp test packages/ghostty-core
```

Expected: three leases can be held, a fourth returns `null` without consuming a
dirty snapshot, valid returns restore capacities, malformed/stale returns do not
free slots, and the next same-size build allocates zero buffers.

### Step 3: Add typed worker lease and recycle messages

Extend the worker protocol with:

```ts
packedUpdate: { slotId, leaseToken, update, state }
recycleRenderUpdate: { slotId, leaseToken, buffers }
```

Names may differ, but preserve ownership. Validate both directions. A recycle
command is generation-scoped and does not advance parser sequence/ACK state.
Add helpers that produce the transfer list in one canonical order; do not repeat
the eight-field order in worker and main implementations.

Extend `TerminalWorkerChannel.post(command, transfer?)` and pass the transfer
list to `Worker.postMessage`. The pool remains a routing adapter; it must not
retain transferred buffers.

In `terminal-worker.ts`, stop calling `core.releaseRenderUpdate(update)`
immediately after posting. Mark the lease in flight and reclaim only on a valid
return. On recycle, if a pending update exists, schedule/emit it after reclaim.
Do not recursively build an unbounded chain in the message handler; use the
existing microtask/timer coalescing turn.

**Verify**:

```bash
vp test packages/ghostty-react
vp run typecheck
```

Expected: protocol tests reject malformed recycle payloads; a real/simulated
round trip transfers ownership worker→main→worker with the expected detached
side each time.

### Step 4: Return every consumed or discarded main-thread update

In `WorkerTerminalCore`, retain slot/token metadata with each received update.
Implement `releaseRenderUpdate(update)` so it is idempotent and transfers that
update's eight buffers back once. Preserve the existing `TerminalCoreRuntime`
interface used by `surface.ts`.

Audit every removal path:

- successful `viewportModel.apply` and render `finally`;
- failed validation/model apply;
- stale/out-of-order packed event;
- local queue coalescing/discard;
- force-full replacement;
- terminal dispose;
- worker failure/recovery;
- surface creation failure.

Do not call `updates.shift()` without releasing the removed update. With three
worker slots, the queue must never retain more than three leased updates. If the
worker/generation is already dead, release local references without posting to
a replacement worker; recovery may allocate a fresh bounded ring.

For `MainThreadTerminalCore`, keep direct builder release and do not attempt a
worker transfer.

**Verify**:

```bash
vp test packages/ghostty-react packages/yaade-ui
```

Expected: each accepted packed update produces exactly one reclaim or one
explicit dead-generation discard; duplicate release posts nothing; dispose does
not leave a live worker terminal with stranded slots.

### Step 5: Coalesce render state while all slots are in flight

When `tryRenderUpdate` returns no slot:

- continue processing every `writeBytes`/replay command;
- post `parsed` at the same parser-completion point so host ACK and throughput do
  not wait for rendering;
- retain one pending update descriptor per terminal;
- OR together `forceFull` requirements and retain the newest command envelope;
- do not call the dirty-consuming render extraction;
- do not allocate another slot/update array;
- emit one update after any valid slot return.

Resize, theme, selection, scroll, and explicit full-frame commands must also
coalesce safely. Operations whose synchronous result is required (selection
query/input encoding) still return their result independent of a render lease.
A resize/full barrier may supersede older pending row dirtiness but may not be
lost.

Add a stress test that holds all three updates on the main side, sends thousands
of writes and several resizes/themes, confirms every parser callback fires,
then returns one slot and verifies one newest authoritative update. Repeat until
all slots circulate.

**Verify**:

```bash
vp test packages/ghostty-core packages/ghostty-react
```

Expected: slot count remains three; `backingBuffersAllocated` is constant after
warm-up; parser completions equal writes; final viewport/generation matches a
main-thread reference runtime.

### Step 6: Add real-browser steady-state and recovery gates

Expose only cumulative counts needed by the existing lifecycle/test bridge:
render slots, in-flight high water, backing-buffer allocations, reclaim count,
reclaim rejects, and no-slot coalesces. Do not expose buffer contents.

Add a browser test with the default worker runtime that:

1. warms a dense 80×24 and 180×44 terminal until capacities stabilize;
2. runs ASCII stream, Unicode stream, one-row rewrite, and synchronized TUI
   fixtures for enough frames to circulate every slot;
3. asserts no backing-buffer allocation after warm-up;
4. deliberately delays main-thread release until all slots are in flight and
   proves parsing/ACK continues while packed updates pause;
5. releases one slot and observes one catch-up update;
6. triggers worker recovery and proves exactly one fresh bounded ring is created,
   replay completes, and steady-state allocations return to zero.

Use deterministic counters as the gate; browser heap sampling is supporting
evidence only.

**Verify**:

```bash
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-compatibility.web.spec.ts \
  tests/web/e2e/terminal-multiplexer.web.spec.ts
vp run test:bench
```

Expected: all functional tests pass; after warm-up
`worker_render_buffer_allocations` has zero delta in every steady workload;
existing p95/p99 budgets are not loosened.

### Step 7: Run the shared-client integration gate

Document the ownership ring and counters in `docs/terminal-renderers.md`. Record
before/after allocation counts and matched benchmark context; do not claim a
latency win unless measurements support it.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:web
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-compatibility.web.spec.ts \
  tests/web/e2e/terminal-multiplexer.web.spec.ts
vp run test:bench
vp run build:web
vp run build:desktop
vp run test:desktop
```

Expected: all commands exit 0 and `git status --short` shows only intentional
Plan 016 changes plus preserved pre-existing work.

## Test plan

- Builder unit: fixed slot count, no-slot before dirty consumption, capacity
  reconstruction, eight-buffer validation, duplicate/stale return, high-water
  growth, main-thread synchronous wrapper.
- Worker protocol: packed lease and recycle validation/transfer order,
  generation mismatch, malformed/unaligned/detached buffers.
- Worker runtime: three in flight, parse while stalled, force-full/resize/theme
  coalescing, one catch-up update, dispose/recovery cleanup.
- Surface integration: every successful/failed/discarded update reaches release
  exactly once.
- Browser E2E: steady ASCII/Unicode/TUI zero-allocation delta, delayed release,
  hidden/resident terminals, worker recovery, main-thread fallback.
- Bench: allocation, max in-flight, no-slot, reclaim latency, parse/present
  throughput, and existing user-facing budgets.

## Done criteria

- [x] The worker runtime has exactly three normal render-update slots.
- [x] Transferred buffers return main→worker through `releaseRenderUpdate`.
- [x] Valid returned buffers restore full capacities and are reused.
- [x] A fourth in-flight frame is coalesced, never allocated.
- [x] Dirty state is not consumed when no slot is available.
- [x] Parsing and cumulative ACK do not wait for render-slot return.
- [x] Every apply, reject, discard, dispose, and recovery path has explicit ownership cleanup.
- [x] `worker_render_buffer_allocations` has zero steady-state delta after warm-up.
- [x] Final model state matches the reference path after slot starvation/coalescing.
- [x] Worker recovery creates at most one new bounded ring and returns to reuse.
- [x] Plan-scoped unit, E2E, build, lint, typecheck, and benchmark behavior is verified without loosened budgets.

## Completion record

The committed implementation reserves one of three slots before consuming dirty
state, validates all eight returned buffers with a generation-scoped lease token,
recycles through `releaseRenderUpdate`, and coalesces a pending update while all
slots are in flight. Core/worker/UI tests (144), typecheck, web and desktop
builds, desktop tests, and the shared browser E2E suites passed. The operator's
Plan 015 waiver also applies to the unchanged repository-wide lint baseline and
unrelated Plan 014 benchmark instability.

## STOP conditions

- Slot availability can only be checked after consuming Ghostty dirty state.
- A returned buffer cannot be associated with a generation-scoped slot without
  trusting object identity across structured clone.
- Main-thread code would transfer a buffer still referenced by the viewport
  model, renderer, another update, or Plan 014 diagnostics.
- Correctness requires parsing to wait for paint or buffer return.
- Resize/theme/full-frame requests can be lost while all slots are in flight.
- The implementation adds an emergency fourth slot, unbounded queue, or
  SharedArrayBuffer requirement.
- Plan 014/015 interfaces have drifted and resolving them would require changing
  WebGL submission or restoring string writes.

## Maintenance notes

A transferred buffer has exactly one owner. Keep lease state explicit and make
release idempotent; garbage collection is not an ownership protocol. Any future
render-update field must be added to the canonical buffer bundle, transfer list,
return validator, capacity reconstruction, and tests together. Reviewers should
watch for hidden drop paths (`shift`, stale event, recovery, dispose), dirty
consumption before slot reservation, and allocation counters that omit capacity
growth.
