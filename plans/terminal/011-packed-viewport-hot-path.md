# Plan 011: Keep terminal viewport data packed through the renderer hot path

> **Executor instructions**: Execute only after the worker/scheduler and retained
> GPU scene have stabilized. Preserve synchronous inspection APIs without
> rebuilding compatibility objects every frame. Update `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat f21fcdf4..HEAD -- packages/ghostty-core packages/ghostty-react/src/worker packages/ghostty-react/src/renderers packages/ghostty-react/src/surface.ts packages/yaade-ui/src/panels/terminal-instance-registry.ts tests`
> Compare the landed Plan 004 protocol and Plan 010 scene interface with this
> plan. Any mismatch is a STOP condition; do not improvise a second model.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 004, 005, and 010
- **Category**: perf / architecture
- **Planned at**: commit `f21fcdf4`, 2026-08-30

## Why this matters

Plan 004 moves Ghostty parsing to a worker, but the render pipeline still pays
for repeated representation changes. `GhosttyTerminalCore.snapshot()` reads
WASM state into mutable JS row/cell objects. `GhosttyRenderUpdateBuilder` walks
those objects, UTF-8 encodes every cell, and transfers typed arrays. On the main
thread, `GhosttyViewportModel.apply()` validates, slices, UTF-8 decodes every
cell, mutates another JS object graph, rebuilds row strings, and then the GPU
renderer traverses those objects again to construct instance buffers.

Worker parsing removes WASM work from the UI thread but not this decode/object
allocation/traversal cost. A packed retained viewport can apply dirty row slabs,
feed Canvas/GPU scene builders directly, and materialize strings only on atlas
misses or explicit inspection/link reads.

## Current state

- `core.ts::snapshot()` performs per-cell WASM calls and fills mutable JS cells.
- `render-update.ts::GhosttyRenderUpdateBuilder.build()` walks dirty cells,
  computes UTF-8 capacity, calls `TextEncoder.encodeInto`, and writes parallel
  typed arrays.
- The in-progress worker protocol transfers those buffers.
- `viewport-model.ts::apply()` calls `TextDecoder.decode` per cell, unpacks two
  colors into objects, mutates booleans, and concatenates `rowText`.
- `surface.ts::renderFrame()` calls `viewportModel.snapshot()` every terminal
  update; renderers consume object cells.
- Registry/test APIs require synchronous text, dimensions, cursor, links, and
  hit testing. They do not require a permanently expanded object per cell.

## Target design

Create a versioned `PackedGhosttyViewport` with retained row-major typed slabs
for style, foreground/background, grapheme offsets/lengths, row flags, and
metadata. Applying an update copies or swaps validated dirty-row ranges into
owned storage; it never retains transferred buffers after release.

Provide two access layers:

1. **Hot renderer access**: numeric typed arrays plus lazy grapheme materialization
   cached by cell/row version.
2. **Cold inspection compatibility**: decode a requested row/range or build a
   compatibility snapshot only on explicit inspection, with bounded caches
   invalidated by row generation.

Then deepen the worker-side builder so Ghostty row traversal emits packed fields
directly rather than first constructing a complete JS cell graph. Keep the
current protocol version until direct emission semantics are proven; bump it
when layout/ownership changes.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Core/react unit | `vp test packages/ghostty-core packages/ghostty-react` | all pass |
| UI/app unit | `vp test packages/yaade-ui packages/yaade-app` | all pass |
| Typecheck/lint | `vp run typecheck && vp run lint` | exit 0 |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts tests/web/e2e/terminal-multiplexer.web.spec.ts` | pass |
| Bench | `vp run test:bench` | conformance and performance thresholds pass |

## Scope

**In scope**

- `packages/ghostty-core/src/render-update.ts`, viewport model modules, and
  `GhosttyTerminalCore` render extraction.
- Landed Plan 004 protocol/runtime modules for buffer ownership/versioning.
- Canvas/GPU scene adapters to consume packed accessors.
- `surface.ts`, terminal registry/inspection adapters, focused tests, Plan 007
  benchmarks, and Plan 009 conformance.

**Out of scope**

- Changing terminal parser semantics, SharedArrayBuffer/COOP/COEP, PTY protocol,
  React terminal state, removing Canvas, or making test inspection asynchronous.

## Steps

### Step 1: Measure conversion and allocation costs

Instrument bounded spans/counters for worker Ghostty extraction, snapshot object
population, packing/encoding, transfer bytes, main-thread validation/copy,
decode/object mutation, scene update, and inspection cache misses. Record heap
allocation/GC and p95/p99 frame time on dirty-row and full-screen dashboards.

**Verify**: baseline reports each conversion separately and retains no payload.

### Step 2: Add a packed retained viewport

Implement owned typed slabs with explicit dimensions/generation/frame ID. Apply
full updates atomically and partial updates by dirty row. Validate external
buffers once at the worker boundary and perform cheap invariant checks at the
model boundary without scanning unchanged rows. Never reference a transferred
or builder-owned buffer after acknowledgement/release.

Add row/cell version counters and lazy grapheme access. Decode a grapheme only
when a renderer cache miss, Canvas text run, link scan, selection text, or test
inspection requests it; cache it until that row changes.

**Verify**: full-vs-partial equivalence, stale generation rejection, resize
clearing, transfer detachment, malformed offsets, and buffer reuse tests pass.

### Step 3: Switch retained scene and Canvas to packed access

Make Plan 010's scene builder read numeric arrays and lazy text accessors
directly. Canvas may build bounded row runs because it needs strings, but those
runs are cached by row version and are not recreated for cursor-only frames.
Remove per-cell color objects and boolean expansion from normal rendering.

**Verify**: Plan 009 semantic/visual corpus passes; a cursor-only frame decodes
zero graphemes and rebuilds zero terminal rows.

### Step 4: Preserve synchronous cold inspection

Adapt `getSnapshot`, `getBufferText`, registry dimensions/cursor, link matching,
hit testing, and E2E APIs to cold accessors. Decode only requested rows/ranges
and cap row/string caches. Inspection must not consume Ghostty dirty state,
round-trip to the worker, or delay parser ACKs.

Keep a compatibility `GhosttySnapshot` adapter only for callers that still need
it; instrument and assert it is not called by normal render frames.

**Verify**: registry and E2E tests remain synchronous and exact for wide,
combining, wrapped, selected, scrolled, and resized content.

### Step 5: Emit packed rows directly during Ghostty traversal

Refactor worker-side extraction so one row traversal writes packed style/color,
row flags, and grapheme payload directly into reusable builder storage. Avoid
creating complete intermediate `MutableGhosttyCell`/`MutableGhosttyRow` graphs
and then re-encoding their strings.

Choose the grapheme payload representation by matched measurement: retain UTF-8
if direct codepoint→UTF-8 emission plus transfer size wins; change the internal
version only if another representation materially improves total worker→render
latency without increasing main-thread materialization. Document the measured
decision and bump the packed protocol version if layout changes.

**Verify**: differential tests compare direct packed emission against the old
snapshot adapter for the full Plan 009 corpus before deleting hot-path use.

### Step 6: Bound coalescing and ownership with Plan 005

When several worker updates arrive before presentation, apply/coalesce only
compatible dirty-row updates. Preserve barriers for resize, reset, replay,
recovery, alternate-screen generation, theme/font semantics, and synchronized
output. Parsed ACK remains independent of model decode or presentation.

**Verify**: property-style sequences for write, resize, reset, replay, recover,
hide/show, inspect, and dispose preserve final equivalence and buffer ownership.

### Step 7: Adopt only on measured end-to-end gain

Run three matched sets. Require zero Plan 009 regressions, zero hot-frame
compatibility snapshot builds, bounded caches, and at least 15% improvement in
main-thread model/scene CPU time or TUI presented p95/p99. Transfer bytes and
worker CPU may not materially regress without a larger end-to-end win. Idle
input must remain within 5%.

**Verify**: `vp run test:bench` records before/after conversion spans, allocation,
transfer bytes, and presentation percentiles.

## Test plan

- Packed ownership, detachment, malformed input, resize, and generation tests.
- Direct-emission vs compatibility-snapshot differential corpus.
- Lazy decode/cache invalidation and synchronous inspection tests.
- Canvas/WebGL Plan 009 conformance.
- Real PTY replay, flow control, selection, links, six panes, and worker recovery.
- Memory plateau through repeated resize/font/open/close cycles.

## Done criteria

- [ ] Normal frames do not expand every dirty cell into a second JS object graph.
- [ ] GPU scene updates consume packed numeric state directly.
- [ ] Grapheme strings are materialized lazily and cached by row/cell version.
- [ ] Worker extraction does not build then repack a complete snapshot graph.
- [ ] Synchronous inspection remains exact and off the hot path.
- [ ] Transfer/builder ownership and ACK semantics remain correct.
- [ ] Conformance and measured adoption thresholds pass.

## STOP conditions

- The landed worker protocol cannot transfer owned rows without ACK ambiguity.
- A packed accessor makes inspection asynchronous or forces worker round trips.
- Canvas/GPU conformance fails for wide, combining, ZWJ, fallback fonts, or styles.
- Direct extraction requires changing vendored Ghostty ABI in this plan.
- The rewrite moves CPU cost to the worker but does not improve end-to-end
  presentation or main-thread responsiveness after one profile-led iteration.

## Maintenance notes

Keep the packed model deep: validation/ownership, dirty-row application, lazy
text, and cold compatibility belong behind one interface. New renderer code must
not recreate per-cell objects for convenience. New inspection features should
use row/range accessors and keep caches bounded.
