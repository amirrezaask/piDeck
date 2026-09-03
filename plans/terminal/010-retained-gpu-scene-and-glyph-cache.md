# Plan 010: Replace row-string rasterization with a retained GPU scene and stable glyph cache

> **Executor instructions**: Profile with Plan 007 first and preserve Plan 009
> semantics exactly. This is a renderer architecture change; do not mix it with
> worker protocol/model rewrites from Plan 011. Update `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat f21fcdf4..HEAD -- packages/ghostty-react/src/renderers packages/ghostty-react/src/surface.ts tests/bench tests/web/e2e`
> Confirm Plan 009 is DONE. Plan 006 was rejected and removed; implement WebGL
> behind a backend-neutral scene contract without reintroducing WebGPU.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 007 and 009
- **Category**: perf / robustness / architecture
- **Planned at**: commit `f21fcdf4`, 2026-08-30

## Why this matters

WebGL currently accelerates draw calls but performs expensive CPU work to
prepare them. It concatenates each same-style row segment into a string and keys
the atlas by the entire changing segment. A dashboard that changes one number
therefore misses the cache for most of that row, resizes a scratch canvas,
shapes/rasterizes the run, calls `getImageData`, and uploads new pixels. When the
fixed atlas fills, `clear()` invalidates UVs emitted earlier in the same frame;
the renderer throws, and the recovery controller treats normal cache pressure
as renderer failure.

The context also uses `preserveDrawingBuffer: true` because only dirty rows are
redrawn into the swap buffer. That option can inhibit browser swap/compositor
optimizations and makes correctness depend on preserved default-framebuffer
contents. Native Ghostty does not become fast merely because YAADE uses the same
parser: YAADE's renderer is this custom WebGL/Canvas pipeline, not Ghostty's
native GPU renderer.

## Current state

- `webgl2-renderer.ts` builds row strings and calls `atlas.get({ text,
  cellSpan, ... })` for each dirty style run.
- `glyph-atlas.ts` keys entries by full text and span; every miss changes the
  scratch canvas size, calls `getImageData`, and `texSubImage2D`.
- The atlas allocates one 2048×2048 RGBA texture per terminal (about 16 MiB)
  immediately and clears the entire texture when shelves fill.
- A generation change during frame construction throws
  `WebGL glyph atlas rebuilt during frame construction`, triggering recovery.
- `create-renderer.ts` creates a probe context and then a real context per
  terminal and requests `preserveDrawingBuffer: true`.
- Batch `push()` methods allocate small temporary arrays; uniform locations and
  `gl.getError()` are queried on the normal frame path.

## Target design

- Retain backend-neutral row scene records. Dirty rows update only their scene
  ranges; every presented frame composites the complete retained scene with a
  bounded number of instanced draws.
- Create WebGL with `preserveDrawingBuffer: false`. The complete scene, not prior
  swap-buffer contents, is the authority.
- Cache stable grapheme/cluster images, not whole volatile row strings. A cell's
  complete grapheme (combining/ZWJ included) and width span is the minimum unit.
  Use a separately bounded shaped-run path only for scripts/font behavior that
  Plan 009 proves cannot be rendered correctly per cluster.
- Grow atlas pages lazily under per-terminal and document-wide GPU memory
  budgets. Eviction invalidates affected scene entries and schedules repaint;
  normal cache pressure never enters renderer recovery.
- Cache programs, uniforms, VAOs, and immutable state. Write typed-array fields
  directly and keep debug validation off the production frame path.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Renderer unit | `vp test packages/ghostty-react` | all pass |
| Typecheck/lint | `vp run typecheck && vp run lint` | exit 0 |
| Conformance E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts` | pass |
| Multiplexer E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts` | pass |
| Bench | `vp run test:bench` | budgets and adoption thresholds pass |

## Scope

**In scope**

- Backend-neutral scene/cache contracts and WebGL renderer modules.
- WebGL behind one backend-neutral retained scene contract suitable for future
  adapters after they pass separate compatibility gates.
- Renderer factory/controller changes needed for context options, capability
  probe caching, memory budget, and non-fatal atlas pressure.
- Focused renderer tests, Plan 009 conformance, Plan 007 benchmarks.

**Out of scope**

- Worker protocol v2, replacing the main-thread viewport object model, native
  Metal/wgpu/Tauri code, shader visual effects, SDF/MSDF text, or removing Canvas.

## Steps

### Step 1: Record the CPU/GPU preparation profile

Run the deterministic dirty-row and full-screen dashboards for three matched
sets. Record row-run cache hit rate, raster count/time, `getImageData` time,
texture uploads/bytes, atlas clears, CPU batch time, draw time where timer
queries exist, memory per pane, recoveries, and presented latency. Capture a
production Performance trace proving the largest contributors.

**Verify**: baseline output distinguishes atlas raster/upload work from parser,
model, batching, and GPU submission.

### Step 2: Introduce a retained scene contract

Define stable per-row scene ranges for backgrounds, glyph/cluster instances,
decorations, selection, and cursor overlays. Dirty updates replace only affected
row ranges. Resize/generation/font/DPR/theme changes are explicit full-scene
barriers. Keep cursor/hover overlays separately patchable.

Every frame clears and draws the complete retained scene with bounded draw calls;
it must not rebuild clean rows on CPU.

**Verify**: applying partial rows then drawing equals one full update for every
Plan 009 fixture. Tests cover row growth/shrink, cursor-only, hover-only, resize,
font/DPR, hidden/show, and stale generations.

### Step 3: Implement a stable cluster atlas

Key normal entries by resolved font face, size, weight, style, DPR, complete cell
grapheme, and authoritative cell span—not surrounding row text. Preserve
combining sequences, ZWJ emoji, wide cells, fallback fonts, color glyphs, and
cell clipping from Plan 009.

Use a reusable scratch canvas whose allocation grows only when required. Upload
directly from an allowed canvas/image source when supported; do not call
`getImageData` solely to pass identical RGBA bytes to WebGL. Add a bounded
fallback shaped-run cache only for conformance cases that fail cluster rendering.

**Verify**: changing one digit in a 200-column row causes at most the changed
cluster raster/upload after warm-up. Stable dashboard frames approach zero
texture uploads.

### Step 4: Make atlas allocation and eviction non-fatal

Allocate small pages lazily and grow to measured limits. Add LRU/page eviction
under explicit per-terminal and aggregate byte budgets. Eviction marks referring
scene rows dirty and completes at a frame boundary; it never throws from normal
frame construction or starts renderer recovery.

Cache the document capability result and avoid a disposable probe context for
every terminal. Track active contexts and atlas bytes. Six visible panes plus
hidden retained panes must stay under a documented aggregate budget; excess
accelerated contexts follow a tested fallback/promotion policy rather than
browser-driven eviction.

**Verify**: a tiny test budget forces repeated eviction while output continues,
with zero renderer recoveries, complete final pixels, and bounded memory.

### Step 5: Remove preserved default-framebuffer dependence

Create new WebGL contexts with `preserveDrawingBuffer: false`. Clear and submit
the full retained scene each presented frame. Add a test-only capture path using
an offscreen framebuffer/readback only when a test requests pixels; normal
production rendering must not pay for capture.

**Verify**: dirty-row updates never expose discarded/stale rows across several
compositor frames, hide/show, resize, and context restoration. Factory tests
assert `preserveDrawingBuffer` is false.

### Step 6: Remove hot-path allocation and driver synchronization

Write directly into reusable typed arrays instead of `.set([ ... ])`; replace
row arrays/`includes` scans with reusable marks/bitsets; cache uniform locations;
and remove per-frame `gl.getError()` from production. Keep explicit debug-mode
validation and error/context-loss events through the renderer controller.

**Verify**: allocation sampling after warm-up shows no per-cell temporary arrays
and bounded per-frame allocation. Normal healthy frames do not synchronously
query driver error state or pixels.

### Step 7: Re-run conformance and adopt on evidence

Run Plan 009 at all DPRs and three matched Plan 007 benchmark sets. Require:

- zero semantic/structural visual regressions;
- zero atlas-pressure recoveries;
- dynamic-dashboard texture uploads proportional to changed unique clusters,
  not dirty-row width;
- bounded aggregate context/atlas memory across six panes;
- p95/p99 presented latency or CPU frame time improves by at least 15% on the
  TUI/resize workload;
- idle typing and startup do not regress more than 5%/10% respectively.

If thresholds fail after one profile-led correction, keep the existing renderer
and mark this plan BLOCKED with traces; do not loosen budgets.

## Test plan

- Retained full-vs-partial scene equivalence and generation barriers.
- Cluster cache hit/miss, combining/ZWJ/wide/color glyph, shaped fallback, lazy
  growth, eviction, and aggregate-budget tests.
- Plan 009 differential tests with non-preserved contexts.
- Real PTY dashboard, six panes, hidden/show, resize/DPR, and context loss.
- Memory plateau after repeated terminal open/close and font/DPR changes.

## Done criteria

- [ ] GPU rendering no longer keys normal atlas entries by volatile row strings.
- [ ] Clean rows are retained and not rebuilt on CPU.
- [ ] `preserveDrawingBuffer` is false in production.
- [ ] Atlas pressure is bounded and never treated as renderer failure.
- [ ] Capability probes, contexts, atlas pages, and aggregate GPU bytes are bounded.
- [ ] Hot frames avoid per-cell arrays, synchronous readback, and driver error polling.
- [ ] Conformance and benchmark adoption thresholds pass.

## STOP conditions

- Plan 009 parity cannot be preserved for combining, ZWJ, wide, fallback-font,
  decorations, or cursor rendering.
- A shaped-run fallback becomes an unbounded row-string cache.
- Correct partial behavior still depends on preserved default-framebuffer contents.
- Atlas eviction requires renderer recovery or loses references without repaint.
- Multi-pane memory cannot be bounded without an untested browser-eviction assumption.

## Maintenance notes

Atlas misses and renderer recoveries are different failure classes. Cache
pressure is routine policy; only context/device/program/submission failures enter
the recovery controller. Review future changes for row-sized keys, full-scene CPU
rebuilds, hidden synchronous readbacks, and aggregate GPU memory—not only draw
call count.
