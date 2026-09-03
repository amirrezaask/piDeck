# Plan 002: Add WebGL2 as the preferred terminal renderer

> **Executor instructions**: Execute in order, preserve local changes, run every
> gate, and update `plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 717ed49f..HEAD -- packages/ghostty-react packages/yaade-ui/src/panels/TerminalPanel.tsx tests/bench tests/web/e2e`
> Confirm Plan 001 is DONE and its packed update and renderer interfaces exist.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/001-terminal-render-frame-seam.md`
- **Category**: perf
- **Planned at**: commit `717ed49f`, 2026-08-30

## Why this matters

The current Canvas adapter executes many CPU-side text and rectangle operations.
WebGL2 can retain a glyph atlas and batch cell backgrounds, glyphs, decorations,
selection, and cursor geometry into a small number of GPU draw calls while
keeping Ghostty as the parser. WebGL2 is available across substantially more of
YAADE's supported system WebViews than WebGPU, making it the appropriate
accelerated default.

## Current state

After Plan 001, `GhosttyTerminalSurface` must use a `TerminalRenderer` adapter,
Canvas must remain behaviorally complete, and packed updates must be the only
backend input. Before Plan 001, the equivalent code is
`packages/ghostty-react/src/renderer.ts`, which uses `fillRect`, `fillText`, and
`strokeRect`. `TerminalPanel.tsx` currently reports the provider as `ghostty`;
keep that and add a separate backend attribute.

Reference implementation—not a dependency:
`@xterm/addon-webgl` uses a WebGL2 glyph-atlas renderer and explicitly handles
context loss. Do not import xterm.js or copy code with incompatible licensing.

## Target design

Add:

- `src/renderers/webgl2/webgl2-renderer.ts` — adapter implementation;
- `src/renderers/webgl2/program.ts` — shader compile/link and typed errors;
- `src/renderers/webgl2/glyph-atlas.ts` — bounded bitmap atlas with eviction;
- `src/renderers/webgl2/batches.ts` — reusable instance buffers;
- `src/renderers/create-renderer.ts` — capability selection and explicit
  `auto | canvas2d | webgl2` preference;
- focused tests beside each module.

Use bitmap glyphs rasterized through an offscreen Canvas 2D context. Do not use
SDF/MSDF text. Preserve browser font fallback, emoji color pixels, font styles,
and cell clipping. Upload glyph pixels into one or more bounded textures and
render foreground/background/decorations with instanced quads.

## Commands

| Purpose | Command | Expected result |
|---|---|---|
| Unit | `vp test packages/ghostty-react` | all pass |
| Typecheck/lint | `vp run typecheck && vp run lint` | exit 0 |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts tests/web/e2e/terminal-multiplexer.web.spec.ts` | pass |
| Bench | `vp run test:bench` | pass and comparison recorded |

## Scope

**In scope**

- `packages/ghostty-react/src/renderers/**`
- `packages/ghostty-react/src/surface.ts`
- `packages/ghostty-react/src/index.ts`
- `packages/ghostty-react/src/styles.css` only if canvas stacking changes
- `packages/yaade-ui/src/panels/TerminalPanel.tsx`
- `tests/bench/terminal-throughput.bench.ts`
- `tests/bench/budgets.json` only to tighten a proven budget, never loosen one
- `tests/web/e2e/terminal-compatibility.web.spec.ts`
- `tests/web/e2e/terminal-multiplexer.web.spec.ts`

**Out of scope**

- Workers, WebGPU, xterm.js, server/protocol changes, native desktop code.
- Removing Canvas or changing the terminal parser.
- Decorative GPU effects, blur, CRT simulation, ligature invention, or UI work.

## Steps

### Step 1: Define backend selection and observability

Implement `createTerminalRenderer()` with deterministic policy:

1. explicit test/operator preference;
2. WebGL2 when creation and a minimal self-test succeed;
3. Canvas 2D otherwise.

Expose provider and backend separately:

- preserve `data-yaade-terminal-renderer="ghostty"`;
- set `data-yaade-terminal-render-backend="webgl2|canvas2d"`;
- set `data-ghostty-terminal-render-backend` on the terminal mount/canvas.

Do not choose based only on the existence of `WebGL2RenderingContext`; context
creation and shader self-test are authoritative.

**Verify**: factory tests cover forced Canvas, successful WebGL2, null context,
shader failure, and deterministic fallback.

### Step 2: Implement shader/program infrastructure

Create minimal shaders for opaque rectangles and textured glyph quads. Compile
and link once per adapter. Bind stable attribute locations, reuse VAOs/buffers,
and return typed initialization failures to the factory. No shader compilation
may occur during a normal frame.

**Verify**: browser-backed test creates the adapter and renders a known 2×2
pattern; `gl.getError()` remains `NO_ERROR`.

### Step 3: Implement a bounded glyph atlas

Key entries by resolved font family, size, weight, style, DPR, grapheme, and
color/emoji mode. Rasterize with browser Canvas text APIs so shaping and font
fallback match the current platform. Include padding to prevent texture
bleeding. Use a documented maximum texture/memory budget, LRU eviction, and
whole-atlas rebuild fallback when fragmentation prevents insertion.

Atlas invalidation must occur on font load, selected font, size, DPR, zoom, and
WebGL context generation changes. Empty cells and spacer tails must not occupy
atlas entries.

**Verify**: tests cover cache hit, wide/combining glyph, emoji, style variants,
DPR invalidation, eviction, and atlas rebuild without stale UVs.

### Step 4: Batch packed updates into GPU instances

Maintain reusable typed instance buffers for backgrounds, glyphs, decorations,
selection, and cursor. Update only dirty rows except on full invalidation.
Preserve exact grid-column placement: wide glyphs own their spacer cell and the
following grapheme starts at its Ghostty column. Clip glyph quads to their cell
span. Keep row edges snapped to device pixels.

Track debug counters per frame: dirty rows, glyph instances, rectangle
instances, texture uploads, buffer bytes, draw calls, and atlas occupancy. Make
these available only through the existing test bridge or a non-production debug
surface; do not put them in React state.

**Verify**: unit tests produce deterministic batches for the existing Canvas
renderer corpus; browser test asserts bounded draw calls for an 80×24 full
frame and a one-row update.

### Step 5: Make WebGL2 the `auto` preference

Switch default selection to WebGL2 only after parity tests pass. Canvas remains
selectable and is used immediately when WebGL initialization fails. Hidden
panes must stop drawing and uploading while their parser/model remains live.

**Verify**: E2E asserts backend `webgl2` on the supported Playwright browser and
runs a second forced-Canvas project/test path with identical terminal text,
dimensions, cursor, selection, and link behavior.

### Step 6: Add differential visual tests

Render a deterministic corpus through Canvas and WebGL at DPR 1, 1.25, and 2.
Compare pixel output with explicit tolerances and semantic assertions. Store
small stable fixtures only; do not make cross-OS font antialiasing exact.

Corpus: ASCII styles, palette colors, backgrounds, wide glyphs, combining
marks, emoji, Nerd Font symbol, each underline style, selection, wrapped link,
each cursor shape, focused/unfocused cursor, and bottom-anchored rows.

**Verify**: differential suite passes on its supported CI platform; semantic
checks pass everywhere.

### Step 7: Benchmark and adopt only on evidence

Run three baseline and three WebGL benchmark sets on the same machine. Add a
six-pane flood benchmark if absent. WebGL becomes default only if:

- no functional or visual parity regression;
- typing median/p95 does not regress by more than 5%;
- flood/stream median improves by at least 15% **or** CPU/frame profile shows a
  clear backend bottleneck reduction;
- p99 does not worsen by more than 10%;
- atlas memory stays bounded through repeated font/DPR changes.

If thresholds are not met, keep WebGL available but not default and report the
profile; do not manufacture a win by loosening budgets.

## Test plan

Model unit-test style on `renderer.test.ts`; model browser behavior on
`terminal-compatibility.web.spec.ts`; model performance on
`terminal-throughput.bench.ts`. Add factory fallback, shader failure, atlas,
batch, DPR, hidden-pane, forced backend, six-pane, and visual differential
coverage.

## Done criteria

- [ ] WebGL2 is an adapter over the Plan 001 interface, not Ghostty internals.
- [ ] Canvas remains complete and selectable.
- [ ] Glyph atlas and all GPU buffers are bounded and reused.
- [ ] No shader compile or unbounded texture upload occurs during normal frames.
- [ ] Provider/backend observability is present without React state.
- [ ] Functional, visual, typecheck, lint, and benchmark gates pass.
- [ ] Default selection follows the evidence threshold above.

## STOP conditions

- Plan 001's renderer seam or packed updates are incomplete.
- Correct wide/combining/emoji rendering requires replacing Ghostty semantics.
- The implementation needs xterm.js internals or incompatible copied code.
- Browser text rasterization cannot produce a stable atlas for required fonts.
- WebGL exceeds target context/texture limits with six visible panes.
- Benchmarks fail the adoption threshold after one profiling-led iteration.

## Maintenance notes

Review GPU resource destruction, atlas bounds, per-frame allocations, draw-call
counts, and font/DPR invalidation. Treat context loss as expected; Plan 003 adds
full recovery orchestration. Any new terminal visual feature must first define
its packed semantics and Canvas behavior, then implement WebGL parity.
