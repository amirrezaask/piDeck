# Plan 001: Introduce a packed terminal render-frame seam

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Do not
> reset pre-existing working-tree changes. When done, update this plan's status
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 717ed49f..HEAD -- packages/ghostty-core packages/ghostty-react packages/yaade-ui/src/panels/terminal-instance-registry.ts tests/bench`
> Also run `git status --short`; relevant files had local changes when this plan
> was authored. If live behavior differs from “Current state,” stop and report.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: perf / tech-debt
- **Planned at**: commit `717ed49f`, 2026-08-30

## Why this matters

Canvas rendering, future WebGL/WebGPU adapters, worker transfer, inspection, and
hit-testing currently converge on `GhosttySnapshot`, a graph of mutable JS row
and cell objects. Adding GPU or worker implementations directly against that
shape would duplicate traversal and couple every backend to Ghostty's current
WASM-reading implementation. This plan creates one deep renderer module: a
small packed-update interface with enough behavior behind it to support all
later adapters and tests.

This plan is intentionally Canvas-only. Its success criterion is exact behavior
parity plus a stable seam—not an immediate speedup.

## Current state

- `packages/ghostty-core/src/core.ts:117` exports `GhosttySnapshot` with
  `dirtyRows` and `rowData`.
- `GhosttyTerminalCore.snapshot()` updates Ghostty render state, mutates a cached
  row/cell graph, and returns that graph. Consumers must finish reading before
  another snapshot.
- `packages/ghostty-react/src/renderer.ts:145` accepts a
  `CanvasRenderingContext2D` and `GhosttySnapshot` directly.
- `packages/ghostty-react/src/surface.ts` owns both the core and Canvas context;
  `renderFrame()` calls `core.snapshot()` then `renderGhosttySnapshot()`.
- `packages/yaade-ui/src/panels/terminal-instance-registry.ts` synchronously
  inspects snapshots for dimensions, cursor state, text, and E2E hit testing.
- Current local work reuses core row/cell objects and avoids unnecessary
  snapshots for cursor-only frames. Preserve those optimizations.

Applicable invariants from `AGENTS.md` and `packages/yaade-ui/AGENTS.md`:
PTY bytes stay out of React state, browser and desktop share one client, and
visible changes require Playwright verification.

## Target design

Create these modules:

- `packages/ghostty-core/src/render-update.ts` — versioned packed update types,
  style-bit constants, color packing helpers, validation, and a reusable builder
  that converts the current Ghostty render state into updates.
- `packages/ghostty-core/src/viewport-model.ts` — retained visible-grid model
  that applies updates and provides row/cell/text/cursor inspection without
  exposing update-buffer lifetimes.
- `packages/ghostty-react/src/renderers/terminal-renderer.ts` — the renderer
  interface and shared geometry/overlay types.
- `packages/ghostty-react/src/renderers/canvas2d-renderer.ts` — Canvas adapter
  moved behind the interface.

Use a versioned `GhosttyRenderUpdate` with these required semantics:

- monotonically increasing `frameId` and `generation`;
- `cols`, `rows`, `full`, global foreground/background/cursor colors;
- cursor position, visibility, blinking, and style;
- sorted unique dirty-row indices;
- row wrap flags for every included row;
- packed cells for each included row: grapheme offset/length, foreground RGB,
  background RGB, and style bits for width, bold, italic, invisible,
  strikethrough, overline, underline style, and selection;
- graphemes in one UTF-8 or UTF-32 payload with offsets—never one object per
  transferred cell;
- buffers owned by the update until the consumer returns them to the builder;
- validation that rejects wrong versions, lengths, row order, or out-of-range
  offsets before any renderer consumes external/worker data.

The `TerminalRenderer` interface must remain small:

```ts
interface TerminalRenderer {
  readonly kind: "canvas2d" | "webgl2" | "webgpu"
  resize(viewport: TerminalRenderViewport): void
  setFont(font: TerminalRenderFont): Promise<GhosttyCellMetrics>
  render(model: GhosttyViewportModel, update: GhosttyRenderUpdate | null,
         overlays: TerminalRenderOverlays): void
  capturePixels?(): Promise<ImageData>
  dispose(): void
}
```

Do not expose WebGL/WebGPU objects through this interface. Backend-specific
context-loss hooks belong to the adapter factory introduced in Plan 002/003.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Focused unit tests | `vp test packages/ghostty-core packages/ghostty-react` | all pass |
| UI tests | `vp test packages/yaade-ui` | all pass |
| Typecheck | `vp run typecheck` | exit 0 |
| Lint | `vp run lint` | exit 0 |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts` | all applicable tests pass |
| Benchmark | `vp run test:bench` | budgets pass; results recorded |

## Scope

**In scope**

- `packages/ghostty-core/src/core.ts`
- `packages/ghostty-core/src/index.ts`
- `packages/ghostty-core/src/render-update.ts` (new)
- `packages/ghostty-core/src/render-update.test.ts` (new)
- `packages/ghostty-core/src/viewport-model.ts` (new)
- `packages/ghostty-core/src/viewport-model.test.ts` (new)
- `packages/ghostty-react/src/renderer.ts`
- `packages/ghostty-react/src/renderer.test.ts`
- `packages/ghostty-react/src/renderers/terminal-renderer.ts` (new)
- `packages/ghostty-react/src/renderers/canvas2d-renderer.ts` (new)
- `packages/ghostty-react/src/renderers/canvas2d-renderer.test.ts` (new)
- `packages/ghostty-react/src/surface.ts`
- `packages/ghostty-react/src/index.ts`
- `packages/yaade-ui/src/panels/terminal-instance-registry.ts`
- `tests/bench/terminal-throughput.bench.ts`

**Out of scope**

- WebGL, WebGPU, workers, `SharedArrayBuffer`, or new runtime dependencies.
- Server protocol, PTY ownership, replay format, flow-control thresholds.
- React state or UI redesign.
- Removing `GhosttySnapshot` exports before all compatibility callers migrate.
- Editing vendored Ghostty WASM or its pinned version.

## Git workflow

Do not create a branch, commit, push, or discard local modifications unless the
operator asks. If asked, use branch `advisor/001-terminal-render-frame-seam` and
small imperative commits.

## Steps

### Step 1: Record the Canvas baseline

Run `vp run test:bench` three times on the same machine and release build.
Record OS, browser/WebView, CPU/GPU, viewport, refresh rate, commit, median,
p95, and p99 in a new comment block at the top of the benchmark file or an
existing benchmark-results location if one exists. Add benchmark output for
renderer backend and visible pane count.

**Verify**: `vp run test:bench` → all budgets pass and output identifies
`provider=ghostty`, `backend=canvas2d`, and pane count.

### Step 2: Define and validate the packed update

Implement `render-update.ts` and tests. Make packing deterministic and document
bit allocation and buffer ownership in the file. Reject malformed update data
without unsafe casts. Reuse allocated builders/buffers; do not allocate a fresh
cell object graph per frame.

Tests must cover full update, partial dirty rows, empty update, resize
generation, wide/spacer cells, combining graphemes, emoji, every style flag,
selection, wrapped rows, cursor metadata, malformed offsets, and stale frame
IDs.

**Verify**: `vp test packages/ghostty-core/src/render-update.test.ts` → all pass.

### Step 3: Add the retained viewport model

Implement `GhosttyViewportModel.apply(update)`. It must reject stale generations
or frame IDs, clear removed rows/cells on resize, and expose synchronous
inspection sufficient to preserve `getSnapshot()`, `getBufferText()`, cursor,
dimensions, link matching, and E2E hit testing. Return readonly views; callers
must not retain transferable update buffers.

**Verify**: `vp test packages/ghostty-core/src/viewport-model.test.ts` → all pass,
including two partial updates that reconstruct the same model as one full
update.

### Step 4: Make the core emit updates

Add a `renderUpdate(consumeDirty = true)` path to `GhosttyTerminalCore` that
fills the reusable packed builder while preserving the current dirty-flag
acknowledgement rule. Keep `snapshot()` temporarily as a compatibility adapter
backed by the retained model or current row cache. Do not perform two Ghostty
render-state traversals per paint.

Add differential tests: for a corpus of escape sequences, snapshot and packed
model must agree on every visible cell, style, row flag, global color, and
cursor field.

**Verify**: `vp test packages/ghostty-core` → all pass.

### Step 5: Introduce the renderer interface and Canvas adapter

Move Canvas-specific painting behind `Canvas2dTerminalRenderer`. Preserve
existing exported helpers when externally used. Keep geometry, overlay state,
and frame invalidation backend-neutral. The surface selects only Canvas in this
plan but reports `backend=canvas2d` through a readonly property and
`data-ghostty-terminal-render-backend`.

Preserve opaque initial background painting, glyph clipping, wide-cell
placement, fractional-DPR edge snapping, hover underline, cursor shapes,
selection, reduced motion, and hidden-pane behavior.

**Verify**: `vp test packages/ghostty-react` → all existing and new tests pass.

### Step 6: Switch inspection to the retained model

Make surface inspection methods and `terminal-instance-registry.ts` read the
retained model rather than forcing a fresh Ghostty snapshot. Keep method
signatures synchronous so the existing test bridge and callers do not change.

**Verify**: `vp test packages/yaade-ui && vp run typecheck` → exit 0.

### Step 7: Prove parity and measure seam overhead

Run focused E2E and benchmarks. The packed Canvas path must not regress any
benchmark median by more than 5% or p95/p99 by more than 10% across three runs.
If it does, profile conversion/allocation before proceeding; do not loosen
budgets.

**Verify**: focused E2E and `vp run test:bench` → pass and recorded comparison
meets the thresholds above.

## Test plan

Use `renderer.test.ts` as the Canvas geometry pattern and
`node-loader.test.ts` as the real-WASM pattern. Add:

- deterministic pack/unpack and malformed-data tests;
- full-versus-partial update equivalence;
- buffer reuse without post-return mutation;
- resize generation and stale-update rejection;
- Canvas differential command tests;
- real Ghostty corpus covering ASCII, wide glyphs, combining marks, emoji,
  color/style changes, selection, wrapping, alternate screen, and cursor modes;
- E2E input, UTF-8 split-read, flow-control replay, zoom, and reload coverage.

## Done criteria

- [ ] Canvas rendering consumes the renderer interface and retained model.
- [ ] `surface.ts` no longer passes `GhosttySnapshot` directly to Canvas paint.
- [ ] Packed updates are versioned, validated, dirty-row based, and tested.
- [ ] Synchronous test/inspection behavior is preserved.
- [ ] No WebGL/WebGPU/worker dependency was introduced.
- [ ] Focused unit, typecheck, lint, E2E, and benchmark commands pass.
- [ ] Canvas benchmark regression stays within the specified thresholds.
- [ ] Only in-scope source files plus `plans/README.md` changed.

## STOP conditions

- Current local optimization work would need to be discarded rather than
  incorporated.
- Ghostty's WASM render-state interface cannot provide a deterministic dirty-row
  update without a second full traversal.
- Packed updates require PTY bytes or terminal frames to enter React state.
- Compatibility requires making registry inspection asynchronous in this plan.
- Canvas parity fails for wide/combining glyphs, selection, or cursor modes.
- A benchmark regression exceeds thresholds after one profiling-led correction.

## Maintenance notes

Treat the packed update as an internal versioned interface, not a public wire
protocol. Change its version whenever layout or semantics change. Reviewers
should scrutinize ownership/lifetime documentation, stale-update handling,
full-versus-partial equivalence, and accidental per-frame allocations. Do not
remove the compatibility snapshot until workers and every test bridge caller
have migrated and a separate cleanup is approved.
