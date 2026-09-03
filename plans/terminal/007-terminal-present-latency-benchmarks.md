# Plan 007: Measure terminal presentation latency for resize, zoom, and complex TUIs

> **Executor instructions**: Follow every step and gate. Preserve the active
> Plan 004–006 work in the working tree. Update `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat f21fcdf4..HEAD -- packages/ghostty-react packages/yaade-app/src/test-bridge.ts packages/yaade-app/src/basic-test-bridge.ts tests/bench tests/web/e2e`
> Confirm Plans 004 and 005 are DONE. Extend their scheduler stage vocabulary;
do not create a second scheduler or competing presentation clock.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: Plans 004 and 005
- **Category**: perf / tests
- **Planned at**: commit `f21fcdf4`, 2026-08-30

## Why this matters

The current benchmark suite can pass without measuring the lag in the supplied
resize recording. Stream throughput stops when the browser transport receives a
marker, and typing-under-flood dispatches a synthetic input event and waits for
one `requestAnimationFrame`; neither proves that the marker or echo reached the
GPU-backed canvas. Before changing residency, atlas, model, or resize policy,
YAADE needs one presented-frame clock and workloads that reproduce browser zoom,
responsive breakpoints, pane zoom, resize storms, and full-screen TUI redraws.

The recording is evidence of the symptom, not a stable benchmark: it shows blank
terminal intervals around the layout switch, intermediate `102×20` and `69×11`
TUI states, and delayed partial redraws. Its H.264 stream declares 60 fps but
contains variable frame timestamps, so do not derive an automated frame budget
from the recording itself.

## Current state

- `tests/bench/terminal-throughput.bench.ts` resolves the stream test from
  `terminal.onData`, before parsing or painting.
- Its typing-under-flood test dispatches `InputEvent`, waits one rAF, and never
  waits for an echoed byte or renderer frame.
- `window.__yaadeTest.getTerminalText()` reads the retained viewport model. It
  establishes parse/model progress, not GPU submission or browser presentation.
- Plan 005 defines `received → posted-to-worker → parsed → presented`. Extend
  that vocabulary for trustworthy benchmark endpoints.
- `GhosttyTerminalSurface.renderFrame()` is the single renderer submission seam.
- Performance tests use Playwright through `vp run test:bench`; functional TUI
  behavior belongs in the existing web E2E projects.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Focused unit | `vp test packages/ghostty-react packages/yaade-app` | all pass |
| Typecheck/lint | `vp run typecheck && vp run lint` | exit 0 |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts tests/web/e2e/terminal-multiplexer.web.spec.ts` | pass |
| Bench | `vp run test:bench` | all budgets pass; new metrics printed |

## Scope

**In scope**

- The Plan 005 terminal scheduler/telemetry module.
- `packages/ghostty-react/src/surface.ts` and renderer diagnostics only for
  frame IDs and bounded timestamps.
- `packages/yaade-app/src/test-bridge.ts` and
  `packages/yaade-app/src/basic-test-bridge.ts` for test-only numeric reads.
- `tests/bench/terminal-throughput.bench.ts`, `tests/bench/budgets.json`, and
  new focused benchmark helpers/fixtures under `tests/bench/`.
- Focused terminal E2E files for geometry/lifecycle assertions.

**Out of scope**

- Fixing terminal residency, glyph caching, packed models, or resize policy.
- PTY payloads in metrics, production analytics, React state, benchmark budget
  loosening, or using screenshot recording timestamps as pass/fail data.

## Steps

### Step 1: Define one bounded presentation record

Extend Plan 005 telemetry with terminal ID, runtime generation, renderer
generation, input/server sequence where applicable, model frame ID, geometry
generation, and timestamps for parsed, model-applied, render-start, submitted,
and next-paint-observed. Keep fixed-size rings and aggregate counters; never
retain terminal strings or ANSI bytes.

For accelerated backends, submission means the draw call was issued. GPU timer queries
may be diagnostic when available but must not block with `finish`, synchronous
readback, or polling in normal frames. “Next paint observed” should use the same
bounded post-submission mechanism for every backend and be named honestly; the
browser does not expose physical scan-out time.

**Verify**: unit tests prove monotonic stages, generation isolation, bounded
retention, and absence of payload fields.

### Step 2: Expose test-only lifecycle and frame counters

Add typed test-bridge reads for surface instance ID, runtime kind/generation,
renderer backend/generation, attach count, resize count, last submitted model
frame, and last next-paint-observed frame. Keep these imperative reads out of
React state and production UI.

**Verify**: a focused test reads the values, writes one unique marker, and sees
`parsed <= model-applied <= submitted <= next-paint-observed` for its sequence.

### Step 3: Correct existing benchmark end points

Change stream throughput to stop on the marker's presented frame, not
`terminal.onData`. Change idle and under-flood typing to send a unique character
or marker through the real terminal input path and stop only when its echoed
model frame has been submitted and observed after paint. Keep transport arrival
as a separate diagnostic duration.

Do not simulate typing only by dispatching `input`; use Playwright keyboard input
and assert PTY output as required by repository rules.

**Verify**: inject a test renderer delay after parse; parsed metrics advance but
presentation benchmarks remain blocked until the delayed frame is released.

### Step 4: Add deterministic TUI and geometry workloads

Add a small PTY-driven fixture that paints a fixed alternate-screen dashboard
with cursor addressing, erases, colors, box drawing, wide/combining/emoji cells,
and synchronized-output on/off variants at controlled 10/30/60 Hz rates. Avoid
depending on locally installed `btop`, `nvim`, or network downloads.

Add benchmark scenarios for:

1. 30 Hz dirty-row dashboard updates for 10 seconds;
2. full-screen redraws at 30 Hz;
3. pane zoom in/out 20 times;
4. viewport widths crossing 767 px in both directions 20 times;
5. a 120-step drag resize with one flooded and one quiet terminal;
6. DPR/browser-zoom changes where the Playwright engine supports them.

Record p50/p95/p99 for received→parsed, parsed→submitted,
received→next-paint-observed, frame delay, long-task duration/count, surface
creates/disposes, attaches, renderer recoveries, and resize requests.

**Verify**: every scenario asserts final text, final dimensions, stable PTY ID,
and no unbounded queue/memory counter.

### Step 5: Establish evidence-based budgets

Run three matched production-build samples on recorded hardware. Add budgets
only after variance is known. Set an alert line at 80% of the accepted ceiling.
Keep existing budgets unchanged unless they can be tightened.

At minimum, fail on any lifecycle regression during pure layout changes:
zero PTY ID changes, zero renderer recoveries, and—after Plan 008—zero surface
recreation/reattach. Latency budgets must use measured p95/p99, not a single
best run.

**Verify**: `vp run test:bench` prints backend, runtime, pane count, hardware
context, all stage percentiles, and exits nonzero when a test-only delay exceeds
a budget.

## Test plan

- Unit-test ring bounds, stage order, stale generations, and no payload retention.
- Use the real PTY and real keyboard in benchmarks.
- Run geometry cases with WebGL and forced Canvas. The removed WebGPU experiment
  is out of scope.
- Model E2E setup on `terminal-compatibility.web.spec.ts` and benchmark reporting
  on `tests/bench/_bench.ts`.

## Done criteria

- [ ] Renderer benchmarks stop on a presented-frame signal, not transport/model progress.
- [ ] Typing-under-flood waits for a real PTY echo.
- [ ] Resize, pane zoom, responsive breakpoint, and deterministic TUI workloads exist.
- [ ] Metrics are bounded, generation-aware, and payload-free.
- [ ] Three-run baselines and p50/p95/p99 are recorded with hardware/backend/runtime.
- [ ] Functional, typecheck, lint, E2E, and benchmark gates pass.

## STOP conditions

- Plan 005 does not expose one scheduler stage model that can be extended.
- Presentation measurement requires synchronous GPU readback or `gl.finish()`.
- A proposed bridge exposes PTY contents beyond existing terminal inspection.
- Results cannot distinguish parse/model progress from renderer submission.
- The benchmark can pass while an injected renderer delay is active.

## Maintenance notes

Every new terminal queue or backend must report into the same stage vocabulary.
Review benchmark changes for endpoints that quietly regress to transport arrival,
model inspection, or one arbitrary rAF. Record raw samples and hardware context
when changing a budget; never loosen a ceiling simply to land a renderer change.
