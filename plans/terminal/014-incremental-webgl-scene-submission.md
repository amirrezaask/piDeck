# Plan 014: Make retained WebGL scene submission incremental

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
>   packages/ghostty-react/src/renderers/terminal-renderer.ts \
>   packages/ghostty-react/src/renderers/renderer-controller.ts \
>   packages/ghostty-react/src/renderers/webgl2 \
>   packages/ghostty-react/src/surface.ts \
>   packages/ghostty-react/src/index.ts \
>   packages/yaade-app/src/test-bridge.ts \
>   tests/bench tests/web/e2e docs/terminal-renderers.md
> git diff --stat -- \
>   packages/ghostty-react/src/renderers/terminal-renderer.ts \
>   packages/ghostty-react/src/renderers/renderer-controller.ts \
>   packages/ghostty-react/src/renderers/webgl2 \
>   packages/ghostty-react/src/surface.ts \
>   packages/ghostty-react/src/index.ts \
>   packages/yaade-app/src/test-bridge.ts \
>   tests/bench tests/web/e2e docs/terminal-renderers.md
> ```
>
> At plan creation, the WebGL renderer files are clean at `7276f526`. That
> commit includes recent operator work in server theme/query handling,
> host-client/RPC, `TerminalPanel.tsx`, workspace types, and the existing
> terminal compatibility E2E. The working tree also has unrelated untracked
> `.pi/` output. Preserve all of it. This plan creates new benchmark/E2E files
> and must not edit `TerminalPanel.tsx` or
> `terminal-compatibility.web.spec.ts`. If the WebGL scene code differs
> materially from the excerpts below, stop and reconcile the plan.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 007, 009, 010, and 011
- **Category**: perf / robustness / architecture
- **Planned at**: commit `7276f526`, 2026-08-30

## Why this matters

The WebGL renderer retains per-row CPU batches, but a dirty frame still copies
all rows into three global batches and uploads the complete scene to GPU
buffers. Worse, `updateRows()` invalidates the scene even when there are no
dirty rows, so a focused cursor blink uploads the unchanged terminal scene.
This defeats most of the value of dirty-row extraction and makes cost scale with
the whole viewport rather than the changed rows.

The target is a retained GPU scene with explicit submission outcomes: no scene
work for cursor-only frames, byte-range patches for stable-topology dirty rows,
and a full compaction only for real barriers or row instance-count changes. The
renderer must continue clearing and drawing the complete GPU-resident scene on
every presented frame because production uses `preserveDrawingBuffer: false`.
This plan removes CPU copying and GPU transfer waste; it does not reintroduce
swap-buffer retention or change terminal visual semantics.

## Measured baseline and cost model

A method probe at commit `4341fd51` wrapped
`WebGL2RenderingContext.bufferSubData` after renderer initialization, then used a
real PTY and the shipped WebGL backend:

- A static, focused 180×44 terminal made two 163,176-byte retained-scene uploads
  plus one 32-byte cursor upload in 1.25 seconds: 326,384 bytes moved while the
  terminal model was unchanged.
- Ten fixed-width carriage-return updates to one row coalesced into five
  presents. Each present uploaded a 170,612–171,132-byte complete scene:
  855,140 retained-scene bytes total, plus five 32-byte cursor uploads.
- Current glyph instances contain 13 floats (52 bytes); rectangle instances
  contain 8 floats (32 bytes). A dense viewport therefore moves hundreds of
  kilobytes per present even when one row or only the cursor changed.

These are characterization numbers, not final benchmark budgets. Step 1 must
codify them with renderer-owned counters so future tests do not monkey-patch
WebGL methods.

## Current state

### Empty dirty sets invalidate the scene

`packages/ghostty-react/src/renderers/webgl2/webgl2-renderer.ts:229-269`:

```ts
const full = overlays.forceFull || update?.full === true || overlayChanged ||
  this.rows.length !== model.rows || this.sceneGeneration !== model.currentGeneration;
const dirty = full
  ? Array.from({ length: model.rows }, (_, row) => row)
  : [...(overlays.dirtyRows ?? model.dirtyRows)];

this.updateRows(model, overlays, dirty, full);
// ... atlas generation handling ...
if (!this.sceneUploaded) this.uploadRetainedScene();
this.buildCursor(model, overlays);
```

`updateRows()` at lines 367-382 always executes:

```ts
this.sceneUploaded = false;
```

This happens even when `full === false` and `rows.length === 0`. Cursor blink,
focus, and other overlay-only frames therefore call `uploadRetainedScene()`.

### Every dirty frame compacts all retained rows

`webgl2-renderer.ts:473-487`:

```ts
private uploadRetainedScene(): void {
  this.retainedBackgrounds.clear();
  this.retainedDecorations.clear();
  this.retainedGlyphs.clear();
  for (const row of this.rows) {
    if (row === undefined) continue;
    this.retainedBackgrounds.append(row.backgrounds);
    this.retainedDecorations.append(row.decorations);
    this.retainedGlyphs.append(row.glyphs);
  }
  this.upload(this.backgroundBuffer, this.retainedBackgrounds.data);
  this.upload(this.decorationBuffer, this.retainedDecorations.data);
  this.upload(this.glyphBuffer, this.retainedGlyphs.data);
  this.sceneUploaded = true;
}
```

The global typed arrays are reused, but every append copies row data and every
`upload()` passes the complete used view to `gl.bufferSubData(..., 0, data)`.
Clean rows are not rebuilt from the viewport model, but they are recopied and
re-uploaded.

### Dirty rows allocate fresh batches and per-cell temporaries

`webgl2-renderer.ts:384-429` creates three batches for every rebuilt row:

```ts
const backgrounds = new WebGlRectBatch(Math.max(8, model.cols * 2));
const decorations = new WebGlRectBatch(Math.max(8, model.cols * 8));
const glyphs = new WebGlGlyphBatch(Math.max(8, model.cols));
```

Each batch starts with a 64-instance typed array. A row therefore allocates about
7.4 KiB before growth: 2,048 bytes each for background/decoration and 3,328
bytes for glyph instances. `colorValues()` returns a new tuple for every cell's
foreground, and `terminalUnderlineRects(0, ...)` returns a new empty array for
the common no-underline path.

`packages/ghostty-react/src/renderers/webgl2/batches.ts` already writes fields
directly and reuses capacity after `clear()`. Reusing each row's existing batch
is the intended local pattern; do not replace it with per-cell object records.

### Cursor buffers are already separate

`buildCursor()` fills dedicated `cursors` and `cursorGlyphs` batches, and
`drawRects()` / `drawGlyphs()` upload those small buffers independently. The
full-scene cursor cost is accidental invalidation, not a need to redesign cursor
geometry.

### Existing diagnostics cannot guard submission

`WebGlTerminalDebugCounters` reports only the latest frame's dirty rows,
instances, atlas activity, used buffer bytes, and draw calls. It does not report
actual scene copy bytes, scene upload bytes/calls, full versus partial
submissions, row-batch allocation, or cumulative values. The counters are not
part of `TerminalRenderer`, `GhosttyTerminalLifecycleSnapshot`, or the test
bridge, so Playwright cannot assert them.

`tests/bench/terminal-throughput.bench.ts` measures end-to-end terminal
workloads. Its dashboard case reports total command duration and generations,
not renderer CPU distributions or GPU submission bytes. Passing the broad
latency ceilings does not prove dirty-row submission is incremental.

## Target design

```text
packed viewport + dirty rows
  -> rebuild only changed RetainedRow batches
  -> WebGlRetainedScene (pure CPU module)
       -> none
       -> partial ranges per primitive
       -> full compact primitive when topology/barrier requires it
  -> WebGL upload adapter
       -> no call
       -> bufferSubData(buffer, byteOffset, exact range)
       -> full used-range upload / capacity growth

cursor overlay
  -> existing small cursor buffers

present
  -> clear default framebuffer
  -> draw complete GPU-resident scene with bounded draws
  -> draw cursor overlay
```

Add a deep `WebGlRetainedScene` module at the seam between row construction and
WebGL submission. It owns row-to-global instance ranges, compact global typed
arrays, topology decisions, and merged dirty ranges. It must not know about the
WebGL context. The renderer remains the adapter that allocates GL buffers,
executes upload plans, and draws.

The first implementation should use a conservative stable-cardinality fast
path:

- Each primitive (background, decoration, glyph) tracks row offset and instance
  count independently.
- If a changed row keeps the same instance count for a primitive, overwrite its
  known global range and emit a partial byte range.
- Merge adjacent changed row ranges before submission.
- If a row's instance count changes, compact and fully upload that primitive;
  the other primitives may still patch independently.
- Full updates, dimensions/generation changes, font/DPR/theme geometry changes,
  context recovery, and atlas-generation changes are explicit full barriers.
- A zero-dirty, non-barrier frame returns `none` and performs zero retained-scene
  copying and uploading.

This keeps the current compact instance representation and bounded draw calls.
Do not switch to one buffer/draw per row, fixed worst-case empty slots, a
per-cell scene texture, or shader-generated decoration semantics in this plan.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Renderer/core unit | `vp test packages/ghostty-core packages/ghostty-react` | all tests pass |
| Typecheck | `vp run typecheck` | exit 0 |
| Lint | `vp run lint` | exit 0 |
| Focused submission E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-renderer-submission.web.spec.ts` | all cases pass on WebGL; explicit skip only when WebGL is unavailable |
| Existing conformance | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts` | existing operator-modified suite passes unchanged |
| Multiplexer lifecycle | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts` | pass |
| Bench | `vp run test:bench` | new submission guards and existing budgets pass |
| Shared builds | `vp run build:web && vp run build:desktop` | browser and Tauri bundles build |
| Desktop tests | `vp run test:desktop` | pass |

## Suggested executor toolkit

- Use `perfguy` for the bytes-moved cost model, p50/p95/p99 comparison, and
  full-versus-partial submission policy.
- Use `frontend-performance` for allocation sampling, main-thread frame cost,
  and test instrumentation that does not distort the measured frame.
- Use `codebase-design` to keep range ownership, compaction, and submission
  planning behind the `WebGlRetainedScene` interface.
- Use `playwright-best-practices` and `webapp-verification` for real PTY,
  browser-GPU, hidden/show, resize, and context-loss verification.

## Scope

**In scope**

- `packages/ghostty-react/src/renderers/terminal-renderer.ts`
- `packages/ghostty-react/src/renderers/renderer-controller.ts`
- `packages/ghostty-react/src/renderers/webgl2/batches.ts`
- `packages/ghostty-react/src/renderers/webgl2/batches.test.ts`
- `packages/ghostty-react/src/renderers/webgl2/webgl2-renderer.ts`
- `packages/ghostty-react/src/renderers/webgl2/retained-scene.ts` (new)
- `packages/ghostty-react/src/renderers/webgl2/retained-scene.test.ts` (new)
- `packages/ghostty-react/src/surface.ts` only for bounded frame/submission
  diagnostics exposed through the existing lifecycle snapshot
- `packages/ghostty-react/src/index.ts` for diagnostic type exports
- `packages/yaade-app/src/test-bridge.ts` for the mirrored lifecycle type
- `tests/web/e2e/terminal-renderer-submission.web.spec.ts` (new)
- `tests/bench/terminal-renderer-submission.bench.ts` (new)
- `tests/bench/budgets.json` only if a measured latency distribution receives a
  named budget; exact byte/counter assertions belong in the benchmark itself
- `docs/terminal-renderers.md`
- `plans/README.md` and this plan's status

**Out of scope**

- `packages/ghostty-react/src/renderers/webgl2/glyph-atlas.ts`: atlas paging,
  eviction, aggregate budgets, and color-glyph rasterization are separate work.
- `packages/ghostty-core/**` and `packages/ghostty-react/src/worker/**`: duplicate
  validation, transfer-buffer recycling, direct Ghostty extraction, and update
  coalescing belong in a later packed-pipeline plan.
- `packages/ghostty-react/src/renderers/canvas2d-renderer.ts` and
  `render-semantics.ts`: Canvas behavior and underline/cursor geometry are the
  correctness oracle and may not change here.
- `packages/yaade-ui/src/panels/TerminalPanel.tsx`: it has operator changes and
  renderer counters can reach tests through the existing lifecycle registry.
- Existing `tests/web/e2e/terminal-compatibility.web.spec.ts`: run it, do not edit it.
- Hover/selection overlay redesign. Existing force-full behavior may remain;
  only cursor/focus overlay-only frames are mandatory in this plan.
- WebGPU, OffscreenCanvas, SharedArrayBuffer, native/Tauri-only rendering,
  framebuffer preservation, or a shader rewrite.
- One GL buffer/draw per row, unbounded multi-draw extension dependence, or a
  document-wide WebGL context/atlas resource policy.

## Git workflow

- Do not commit, push, or open a PR unless the operator explicitly asks.
- Preserve every pre-existing working-tree change. Never use reset/checkout to
  remove operator work.
- Keep existing ESM `.js` imports, semicolon style in `ghostty-react`, and strict
  types. Do not introduce `any`, unsafe casts, or unvalidated test globals.
- Keep the pure retained-scene module independent of DOM, WebGL, React, RPC, and
  host types.

## Steps

### Step 1: Expose cumulative renderer submission diagnostics and codify the baseline

Define a backend-neutral optional diagnostic interface in
`renderers/terminal-renderer.ts`, with a WebGL submission payload exported from
`webgl2-renderer.ts`. Keep its interface small. It must distinguish at least:

```text
last frame:
  dirty rows built
  scene CPU copy bytes
  scene GPU upload bytes and calls
  full primitive uploads
  partial primitive uploads
  overlay upload bytes
  draw calls

cumulative:
  frames
  row rebuilds
  scene compactions
  scene CPU copy bytes
  scene GPU upload bytes and calls
  full primitive uploads
  partial primitive uploads
  overlay upload bytes
  atlas texture uploads/resets
  current used scene bytes
  current allocated GL buffer bytes
```

Counters must represent actual typed-array bytes copied and actual byte lengths
passed to GL, not capacities guessed from instance counts. Keep last-frame and
cumulative values separate so a test cannot miss a bad frame between polls.
Counter updates are integer additions on existing hot operations; percentile
sorting or object-history growth may not run per frame.

Use the already-sampled `renderStartedAt`/`submittedAt` timestamps in
`surface.ts` to retain a payload-free fixed ring (maximum 256 samples) of
renderer CPU frame durations. Compute p50/p95/p99 only when lifecycle diagnostics
are read. Do not add another `performance.now()` call inside every row/cell.

Thread the current renderer diagnostics through `RendererController`,
`GhosttyTerminalLifecycleSnapshot`, `packages/ghostty-react/src/index.ts`, and
the mirrored `TerminalLifecycleState` in `packages/yaade-app/src/test-bridge.ts`.
Canvas may return `null` backend submission diagnostics; do not edit the Canvas
adapter merely to manufacture zero counters.

Create `terminal-renderer-submission.web.spec.ts`. Force WebGL through the
existing renderer preference, use a real PTY, and reproduce the two measured
cases. Snapshot cumulative counters before and after each measured interval.
Have the row-update fixture echo its command before the baseline, emit a
non-painting OSC title READY marker, wait briefly, perform fixed-width row
updates, and emit a non-painting OSC title DONE marker. Observe those markers on
the raw terminal transport and then wait for the model/presentation frame; do
not add visible completion text that changes row topology inside the measured
window. Avoid polling `getTerminalText()` on every animation frame while
measuring.

Record the clean pre-change baseline in `docs/terminal-renderers.md`, including
runtime/backend, viewport dimensions, hardware/browser context, scene bytes,
frame CPU distribution, and the fact that the cursor-only target currently
fails.

**Verify**:

```bash
vp test packages/ghostty-core packages/ghostty-react
vp run typecheck
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-renderer-submission.web.spec.ts
```

Expected at this intermediate step: diagnostic unit/type checks pass; the new
final target assertions demonstrate the current full-scene uploads on
cursor-only and stable one-row frames. Do not weaken those assertions to make
the baseline green.

### Step 2: Add a pure retained-scene planner

Create `webgl2/retained-scene.ts`. It owns compact global data and row ranges for
background, decoration, and glyph primitives. It accepts row batches and returns
an upload plan; it never calls WebGL. Use the existing `WEBGL_RECT_FLOATS` and
`WEBGL_GLYPH_FLOATS` constants rather than duplicating stride numbers.

The interface should be equivalent in depth to:

```ts
type ScenePrimitivePlan =
  | { readonly kind: "none" }
  | { readonly kind: "partial"; readonly ranges: readonly SceneFloatRange[] }
  | { readonly kind: "full"; readonly data: Float32Array }

type SceneSubmissionPlan = {
  readonly backgrounds: ScenePrimitivePlan
  readonly decorations: ScenePrimitivePlan
  readonly glyphs: ScenePrimitivePlan
}

class WebGlRetainedScene {
  replaceAll(rows: readonly RetainedRowBatches[]): SceneSubmissionPlan
  updateRows(changes: readonly RetainedRowChange[]): SceneSubmissionPlan
  clear(): void
  // read-only instance counts/used bytes for drawing and diagnostics
}
```

Names may match repository style, but preserve these invariants:

- The module owns the global typed arrays and row range metadata.
- `updateRows([])` returns `none` for every primitive and copies zero bytes.
- A same-count row update overwrites exactly its known primitive ranges.
- Adjacent dirty ranges are merged; sparse ranges remain separate.
- A primitive count change compacts that primitive once and returns `full` for
  it. It does not force unrelated primitives to compact.
- Full replacement, row-count/dimension change, and explicit invalidation are
  full barriers.
- Instance counts and byte offsets use checked integer arithmetic and cannot
  exceed batch bounds.
- The planner never exposes mutable backing capacity beyond an exact used/range
  view, and callers may not retain a range after the next mutation.
- Applying a sequence of partial/topology-changing updates produces typed arrays
  bit-for-bit equal to rebuilding from the final rows.

Use `retained-scene.test.ts` for the interface test surface. Cover empty scene,
initial full replacement, empty update, one-row same-cardinality patch, adjacent
range merging, sparse ranges, primitive-specific topology changes, row
shrink/growth, full barrier, clear/recreate, and a mixed randomized deterministic
sequence compared with fresh full compaction.

**Verify**:

```bash
vp test packages/ghostty-react
```

Expected: all retained-scene tests pass without constructing a DOM or WebGL
context; `retained-scene.ts` imports only batch/constants and local types.

### Step 3: Execute no-op, partial, and full upload plans in WebGL

Replace `sceneUploaded` and unconditional `uploadRetainedScene()` with the pure
planner. `WebGl2TerminalRenderer.render()` must classify every frame:

1. **No scene change**: do not rebuild rows, compact arrays, bind scene buffers
   for upload, or call scene `bufferSubData`. Continue clearing and drawing the
   already resident scene, then update/draw the cursor buffers.
2. **Partial scene change**: build only dirty rows, copy their same-cardinality
   ranges into retained global arrays, merge adjacent ranges, and call
   `gl.bufferSubData` with the exact destination byte offset and exact source
   view for each planned range.
3. **Full primitive change**: compact/upload only primitives whose topology or
   barrier requires it. Grow the corresponding GL buffer with `bufferData` only
   when the used bytes exceed capacity; otherwise upload only its used view.

Centralize GL buffer operations as `uploadFull` and `uploadRange` (or equivalent)
so diagnostics cannot diverge from actual calls. `BufferState.capacity` must
continue tracking allocated bytes. A smaller full scene may reuse capacity but
must draw only its current instance count.

Treat model generation/dimensions, force-full, font, DPR, viewport-origin
geometry, renderer recovery, and atlas-generation reset as barriers. Preserve
current atlas retry behavior. If `buildCursor()` itself changes atlas generation,
do not draw stale retained glyph UVs: force one bounded glyph-scene rebuild
before submission or stop under the atlas STOP condition below.

Keep production `preserveDrawingBuffer: false`, `gl.clear`, and complete scene
draws. The expected steady-state draw-call ceiling remains five: backgrounds,
glyphs, decorations, cursor rectangles, and cursor glyph. Incremental upload may
not become one draw call per row.

Add planner/renderer tests for byte-offset conversion and diagnostics accounting.
Use a small internal upload-sink seam if necessary; do not build a broad fake
`WebGL2RenderingContext`.

**Verify**:

```bash
vp test packages/ghostty-react
vp run typecheck
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-renderer-submission.web.spec.ts
```

Expected: cursor-only measured frames report zero retained-scene copy/upload
bytes and zero compactions; the stable one-row workload reports partial uploads
and no full primitive upload after its ready marker; final pixels/text remain
present and renderer recovery count remains zero.

### Step 4: Remove warm-frame row-batch and common per-cell allocations

Change `buildRow()` to refill existing `RetainedRow` batches when a row already
exists. Call `clear()` and reuse typed-array capacity; allocate a new row/batch
only for first construction, row-count growth, or capacity growth. Keep old
counts long enough for the retained-scene planner to classify topology before
mutation makes them unavailable.

Deepen `batches.ts` with only the operations needed to avoid hot temporaries:

- exact used/allocated byte getters for diagnostics;
- direct append/copy-at-range operations used by the scene planner;
- packed-color push helpers, or equivalent direct channel writes, so row
  construction does not allocate `colorValues()` tuples per cell;
- explicit success handling when a maximum instance bound is reached. Never
  silently truncate a row because a boolean `push()`/`append()` result was ignored.

Do not change `terminalUnderlineRects()` geometry. Skip calling it when the
resolved underline style is zero, eliminating the common empty-array allocation;
nonzero styles may continue using its backend-neutral rectangles.

Add allocation/capacity tests to `batches.test.ts` and diagnostics assertions to
the browser test. After a dense scene is warm, repeated same-shape row updates
must not increment row-batch allocation counters or grow allocated batch bytes.
Use browser allocation sampling for confirmation, but keep deterministic
capacity counters as the regression guard.

**Verify**:

```bash
vp test packages/ghostty-react
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-renderer-submission.web.spec.ts
```

Expected: typed-array identities remain stable across same-capacity row rebuilds;
common unstyled cells create no color tuple/empty underline array in the hot
loop; no batch operation silently drops an instance.

### Step 5: Add deterministic submission and renderer-CPU benchmarks

Create `tests/bench/terminal-renderer-submission.bench.ts`. Use release browser
assets, the real worker runtime, real PTYs, and forced WebGL. Keep command/setup,
text inspection, and warm-up outside measured windows. Record deltas from
cumulative counters for:

1. a dense static focused terminal across at least two cursor half-cycles;
2. ten fixed-width updates to one row between non-painting OSC title READY/DONE
   transport markers, after the echoed command and setup frame;
3. the existing 30 Hz synchronized dashboard workload;
4. one full-frame repaint barrier;
5. hide/show and resize/DPR full barriers;
6. six visible panes with one changing row each if the existing fixture can set
   this up without adding unrelated mux behavior.

Print viewport dimensions, backend/runtime, frame count, row rebuilds,
compactions, full/partial primitive uploads, scene copy/upload bytes and calls,
overlay bytes, used/allocated buffer bytes, draw calls, atlas activity, and
renderer CPU p50/p95/p99.

Use exact counter gates:

- Cursor-only interval: `sceneCopyBytes === 0`, `sceneUploadBytes === 0`, and
  `sceneCompactions === 0`; overlay uploads remain at cursor-batch scale.
- Stable one-row interval: at least one partial upload, zero full primitive
  uploads after ready, and average scene upload bytes per submitted model frame
  at most 15% of the warmed full-scene used bytes.
- Stable one-row row-batch allocations: zero after warm-up.
- Full barrier: exactly one bounded full upload per populated primitive, not one
  per row.
- Draw calls: at most five for the current scene/cursor passes.
- Atlas pressure/recovery: no new renderer recovery; atlas texture upload bytes
  remain separate from scene-buffer upload bytes.

Run three matched before/after sets on recorded hardware. Keep the implementation
only if deterministic byte/allocation gates pass and existing stream, flood,
idle typing, and typing-under-flood p95/p99 do not regress by more than 5%.
Require at least a 15% renderer CPU p95 improvement on the stable-row or dashboard
workload before claiming a latency win. If timing is below measurement noise but
the exact data-movement gates pass, report only the bytes/allocation improvement;
do not manufacture a latency claim or loosen existing budgets.

Add a named entry to `tests/bench/budgets.json` only for a repeatable duration
distribution. Keep exact scene-counter limits in the benchmark so milliseconds
cannot hide a full-upload regression.

**Verify**:

```bash
vp run test:bench
```

Expected: all exact submission gates pass; existing budgets remain unchanged or
tighter; output contains enough context to compare three matched runs.

### Step 6: Prove full/partial equivalence and lifecycle correctness

Extend pure scene tests so every mixed update sequence compares final global
primitive arrays and instance counts against a fresh full build. In the new
browser E2E, cover:

- cursor blink/focus/blur with no model dirtiness;
- same-count glyph/color changes in one row;
- glyph/background/decoration count growth and shrink, each causing only its
  primitive's full compaction;
- underline, strike, overline, selection, wide, combining, ZWJ, and color glyph
  fixtures through the existing semantic paths;
- full frame, resize, DPR, font/theme, hide/show, synchronized output, and
  context-loss recovery barriers;
- final text, dimensions, non-empty pixels, stable PTY ID, and zero unexpected
  renderer recovery.

Run the existing compatibility suite unchanged as the Canvas/WebGL semantic
gate. Run the multiplexer suite to prove renderer optimization did not alter PTY
ownership or resident placement.

**Verify**:

```bash
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-renderer-submission.web.spec.ts \
  tests/web/e2e/terminal-compatibility.web.spec.ts \
  tests/web/e2e/terminal-multiplexer.web.spec.ts
```

Expected: all tests pass; no comparison relies on `preserveDrawingBuffer`; the
the recently changed compatibility E2E file is byte-for-byte unchanged by Plan 014.

### Step 7: Document the result and run the shared-client gate

Update `docs/terminal-renderers.md` with:

- the retained-scene planner and its no-op/partial/full rules;
- which events are full barriers;
- before/after bytes, allocations, CPU distributions, browser/hardware, and
  viewport dimensions;
- the conservative topology-change fallback;
- deferred atlas/resource and packed-worker work;
- no latency claim if only exact data movement improved.

Run the complete checks and inspect the working tree. Update this plan and its
README row to `DONE` only after every gate succeeds.

**Verify**:

```bash
vp run typecheck
vp run lint
vp test packages/ghostty-core packages/ghostty-react
vp run test:web
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-renderer-submission.web.spec.ts \
  tests/web/e2e/terminal-compatibility.web.spec.ts \
  tests/web/e2e/terminal-multiplexer.web.spec.ts
vp run test:bench
vp run build:web
vp run build:desktop
vp run test:desktop
```

Expected: all commands exit 0; no existing budget is loosened; `git status
--short` contains only intentional Plan 014 files plus preserved pre-existing
operator work.

## Test plan

- `retained-scene.test.ts`: pure full/partial planning, per-primitive topology,
  range merge, byte offsets, barriers, clear, bounds, and deterministic mixed
  sequence equivalence.
- `batches.test.ts`: storage identity reuse, exact used/allocated bytes,
  copy-at-range, packed-color writes, capacity growth, and bound failure without
  truncation.
- `terminal-renderer-submission.web.spec.ts`: real WebGL/PTY cursor-only, stable
  one-row, topology changes, full barriers, styles/glyphs, context loss, and
  cumulative diagnostic deltas.
- `terminal-renderer-submission.bench.ts`: exact scene movement/allocation gates
  plus renderer CPU distributions for cursor, one-row, dashboard, barriers, and
  multi-pane where deterministic.
- Existing compatibility/multiplexer suites: semantic parity, capture,
  resize/DPR, retained surface identity, and PTY lifecycle.

## Done criteria

- [ ] A zero-dirty non-barrier frame rebuilds zero rows, copies zero scene bytes,
      uploads zero scene bytes, and performs zero scene compactions.
- [ ] Cursor blink/focus frames upload only bounded cursor overlay data.
- [ ] A stable-cardinality one-row update patches exact GPU byte ranges and does
      not copy/upload clean rows.
- [ ] Adjacent dirty row ranges merge; sparse ranges remain bounded by the
      documented submission policy.
- [ ] A topology change fully compacts only affected primitives once.
- [ ] Full barriers upload each populated primitive once, not once per row.
- [ ] Complete GPU-resident scene drawing remains bounded to at most five calls
      and production `preserveDrawingBuffer` remains false.
- [ ] Warm same-shape row updates allocate no new row typed-array batches.
- [ ] Common unstyled cells allocate no color tuple or empty underline array in
      `buildRow()`.
- [ ] Batch capacity failure cannot silently truncate visual instances.
- [ ] Cumulative scene/overlay/atlas counters and renderer CPU percentiles are
      exposed through the lifecycle/test bridge with bounded retention.
- [ ] Pure mixed-update output equals a fresh full scene bit-for-bit.
- [ ] Exact cursor/one-row byte gates pass and existing latency p95/p99 regress
      by no more than 5% across three matched runs.
- [ ] Canvas/WebGL compatibility, multiplexer lifecycle, browser/Tauri builds,
      and desktop tests pass.
- [ ] No worker/protocol/core, atlas-policy, Canvas-semantics, or operator-owned
      files are modified.

## STOP conditions

- The live WebGL renderer no longer matches the current-state excerpts or has a
  different retained-scene implementation.
- Incremental correctness would require `preserveDrawingBuffer: true`, relying
  on prior default-framebuffer pixels, or skipping the complete scene draw.
- Stable-cardinality ranges cannot preserve the current compact instance layout
  and bounded draw calls without a shader/semantic rewrite.
- Partial offset/count math fails full-rebuild equivalence for any deterministic
  mixed sequence.
- The implementation needs one WebGL buffer/draw per row, an unbounded number of
  upload calls, or a non-portable multi-draw extension to meet the budget.
- Atlas reset during partial/cursor construction cannot be handled as a bounded
  full glyph barrier without redesigning atlas eviction; stop and propose the
  separate atlas plan rather than mixing it here.
- Correctness requires editing `render-semantics.ts`, Canvas rendering,
  Ghostty-core packed data, worker protocol, or the operator-modified
  `TerminalPanel.tsx`/compatibility E2E.
- Diagnostics require retaining PTY payloads, unbounded frame history, per-cell
  timing, or percentile sorting on every frame.
- Exact data movement improves but three matched runs show a repeatable >5%
  regression in existing typing, flood, stream, startup, or memory behavior.
- A batch bound is reachable in supported dimensions and cannot fail visibly
  without silent truncation inside this scope.

## Maintenance notes

The GPU-resident compact scene, not the default framebuffer, is authoritative.
Future primitives must participate in the retained-scene planner with explicit
row topology, full barriers, byte accounting, and full-vs-partial equivalence
tests. Reviewers should scrutinize byte/instance offset units, row-count changes,
subarray lifetime, atlas-generation invalidation, GL buffer capacity versus used
count, and whether a new overlay accidentally marks the terminal scene dirty.

This plan intentionally accepts a full per-primitive compaction when row
instance count changes. Add slack/arena allocation only if diagnostics show
those fallbacks dominate and a design can preserve bounded draws. Packed worker
buffer recycling/direct Ghostty extraction and document-wide atlas/context
budgets remain separate follow-ups so submission gains can be measured and
reverted independently.
