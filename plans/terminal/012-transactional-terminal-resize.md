# Plan 012: Make terminal resize and DPR changes transactional and frame-bounded

> **Executor instructions**: This plan addresses the supplied resize/zoom
> symptom after residency and renderer hot-path work. Preserve all PTY/replay
> invariants and update `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat f21fcdf4..HEAD -- packages/ghostty-react/src/surface.ts packages/ghostty-react/src/renderers packages/yaade-ui/src/panels/TerminalPanel.tsx packages/yaade-host-client apps/server tests/bench tests/web/e2e`
> Confirm Plans 007, 008, 010, and 011 are DONE. If geometry stages or renderer
> resize contracts differ from this plan, stop and reconcile the plan first.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 007, 008, 010, and 011
- **Category**: perf / correctness / robustness
- **Planned at**: commit `f21fcdf4`, 2026-08-30

## Why this matters

`ResizeObserver` currently calls `ensureFitted()` immediately. `fit()` reads
layout, reallocates the canvas backing store, resizes the renderer, resizes the
Ghostty core, notifies the PTY, and synchronously builds/renders a full frame in
the observer callback. Browser zoom can also trigger the DPR media listener,
and the surface observes both its mount and parent. A single visual gesture can
therefore cause duplicate geometry work, full atlas/model invalidation, multiple
TUI `SIGWINCH` redraws, and long before-paint tasks.

`TerminalPanel` serializes resize RPCs but deliberately sends the first in-flight
size and then the latest queued size. During rapid local geometry changes a TUI
can render an obsolete intermediate grid after the browser has already moved on.
The desired behavior is native-terminal-like: the canvas tracks every display
frame, current retained content is immediately composited into the new box, and
parser/PTY geometry commits are ordered, coalesced, and guaranteed to finish on
the final size.

## Current state

- `surface.ts` observes both `mount` and `mount.parentElement`.
- `fit()` calls `rendererController.resize()` even when only an observer callback
  repeated the same geometry.
- Grid changes synchronously call `core.resize()`, `onResize`, and
  `renderFrame()` from the ResizeObserver path.
- DPR changes call `fit()` separately and WebGL clears its atlas.
- `TerminalPanel.tsx::resizePty()` allows one RPC in flight and one queued latest
  size, but has no geometry generation or latency observability.
- Plan 008 removes client-runtime remount from responsive/pane zoom; Plan 010
  makes a full retained-scene composite cheap; Plan 011 makes model application
  packed. Build on those guarantees rather than compensating for remount/replay.

## Target design

Add one `TerminalGeometryCoordinator` with explicit stages:

```text
observed CSS/DPR → local viewport committed → runtime grid committed
→ host resize requested → host resize acknowledged → matching TUI frame presented
```

The coordinator owns one latest geometry generation, deduplicates observer/DPR
signals, commits at most once per display frame, and never lets stale async
completions become current. Local viewport presentation and PTY geometry remain
separate milestones: the renderer can immediately clear/composite retained
content into a new box while the worker/host/TUI catches up.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Unit | `vp test packages/ghostty-react packages/yaade-ui packages/yaade-host-client` | all pass |
| Server integration | `vp run test:terminal:integration` | pass |
| Typecheck/lint | `vp run typecheck && vp run lint` | exit 0 |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts tests/web/e2e/terminal-multiplexer.web.spec.ts` | pass |
| Platform | `vp exec playwright test --project=platform-e2e` | terminal cases pass |
| Bench | `vp run test:bench` | resize/TUI budgets pass |

## Scope

**In scope**

- New geometry coordinator under `packages/ghostty-react/src/` or its scheduler
  subtree and focused tests.
- `surface.ts`, renderer viewport resize contracts, and landed worker runtime
  resize integration.
- `TerminalPanel.tsx` resize adapter and typed host-client hooks needed for
  generations/telemetry.
- Server resize RPC only if evidence proves host-side latest-wins support is
  necessary; keep wire changes typed and minimal.
- Plan 007 resize benchmarks and focused terminal E2E.

**Out of scope**

- Debouncing until drag end, stretching text as the final render, PTY recreation,
  server process changes unrelated to resize, standalone responsive UI redesign,
  or raising benchmark ceilings.

## Steps

### Step 1: Characterize the geometry pipeline

Add tests and Plan 007 metrics for observer callbacks, distinct CSS/DPR samples,
local commits, runtime resize commands, host requests/acks, full scene rebuilds,
TUI resize markers, and matching presented frames. Reproduce pane drag, browser
viewport crossing 767 px, browser zoom/DPR, and rapid maximize/restore.

**Verify**: baseline identifies duplicate work and records the exact number/order
of intermediate grids for each scenario.

### Step 2: Introduce a generation-aware geometry coordinator

Accept ResizeObserver content-box/device-pixel-content-box data when available;
fall back to one batched layout read. Merge DPR media changes into the same
pending sample. Observe the smallest authoritative element and remove redundant
parent observation unless a test proves it is required.

Deduplicate identical CSS width/height/DPR/font-metric tuples. Assign a monotonic
geometry generation and commit at most one latest sample per animation frame.
Document hidden-document timer behavior where rAF is suspended.

**Verify**: deterministic fake-clock tests cover duplicate observer delivery,
DPR+size in either order, hidden/show, zero-size mounts, stale generations,
and disposal.

### Step 3: Separate local viewport presentation from terminal grid resize

On a geometry commit, update backing dimensions and renderer viewport once,
clear the full destination background, and composite the retained scene into the
new box immediately. Do not stretch stale pixels or wait for PTY output. Clip old
rows/columns and leave newly exposed cells as terminal background until a model
frame for the new grid arrives.

Send the runtime/worker grid resize as a separate ordered command. Model updates
carry geometry generation; old-grid frames may be parsed/ACKed but cannot replace
a newer presented geometry.

**Verify**: step through one resize frame at a time and assert no transparent,
stretched, or stale-size canvas, including fractional DPR and bottom anchoring.

### Step 4: Make host resize latest-wins without losing the final size

Retain one in-flight request per PTY and one latest desired grid. Tag local
requests/telemetry with geometry generation. When an old request settles, send
only the current latest grid; never replay every intermediate size. If the
existing RPC ordering already guarantees this, keep the wire unchanged and add
tests. Add a typed host generation only if stale completion/state can otherwise
win.

Do not debounce until interaction end: the first useful grid should reach the
PTY promptly, and the final grid must be sent within one display frame after
local geometry settles (plus transport latency).

**Verify**: a delayed host fake receives first+latest, not N intermediate
requests; the final server PTY dimensions equal the final local grid even after
failures/retries.

### Step 5: Define resize barriers for model and renderer caches

A committed grid/font/DPR generation invalidates only resources whose keys truly
changed. CSS size without DPR/font change must not discard glyph pixels. DPR or
font change may replace atlas pages, but old resources remain usable until the
new generation can present atomically; no half-rebuilt frame is visible.

Preserve DEC synchronized output: resize may update geometry/background, while
terminal content presentation waits for synchronized close/timeout according to
existing policy.

**Verify**: tests cover resize during synchronized output, atlas eviction,
renderer recovery, worker recovery, replay, hidden/show, and rapid reverse resize.

### Step 6: Add complex-TUI resize assertions

Extend the deterministic dashboard with a resize-reporting mode. Cycle large →
small → large, cross its minimum layout size, change DPR, and resize two/six
panes while output continues. Assert each stable presented marker matches its
reported grid, final cursor/hit testing aligns with cells, and no stale smaller
frame appears after a newer generation.

A TUI may legitimately display “too small” when the stable final grid is below
its minimum. The test should prevent obsolete transient grids from lingering;
it must not suppress correct application behavior.

**Verify**: real PTY E2E checks output and screenshots at generation markers,
not only browser events.

### Step 7: Enforce frame and resize budgets

Run three matched Plan 007 sets. Require:

- no client-runtime/surface recreation or reattach;
- at most one local geometry commit per display frame;
- no duplicate identical runtime/host resize;
- final PTY grid equals local grid;
- no stale generation presented;
- no resize long task above 50 ms and a measured p95 target derived from the new
  retained renderer baseline;
- no TUI throughput/typing regression above 5%.

**Verify**: `vp run test:bench` fails on injected duplicate resize, stale frame,
or delayed final-size delivery.

## Test plan

- Fake ResizeObserver/rAF/DPR coordinator unit tests.
- Runtime and host delayed-response latest-wins tests.
- Canvas/WebGL viewport generation and cache-barrier tests.
- Real PTY pane drag, pane zoom, responsive breakpoint, browser zoom/DPR,
  hidden/show, synchronized output, fallback, and six-pane resize E2E.
- Scoped DOM and screenshot assertions plus final PTY output/dimensions.

## Done criteria

- [ ] One coordinator owns CSS size, DPR, grid, and geometry generations.
- [ ] Identical signals are deduplicated and local commits occur at most once/frame.
- [ ] Local viewport presentation never waits for host/TUI resize completion.
- [ ] Runtime and host resize are ordered latest-wins and final size is guaranteed.
- [ ] No stale geometry generation can present over a newer one.
- [ ] Stable too-small TUI behavior remains correct; obsolete transient states do not linger.
- [ ] Functional, E2E, platform, and benchmark gates pass.

## STOP conditions

- Plans 008/010/011 are incomplete, so resize still recreates the surface or
  requires full hot-path reconstruction.
- ACK correctness would depend on presenting rather than parsing a resize update.
- Latest-wins ordering cannot guarantee the final server PTY dimensions.
- A proposed optimization stretches terminal text as the settled output.
- Browser/WebView-specific code would fork desktop and web behavior.

## Maintenance notes

Geometry has independent local, runtime, host, and presented milestones. Future
font, DPR, sidebar, dock, mobile, or renderer changes must enter this coordinator
rather than call `fit()`, `core.resize()`, or host resize independently. Review
both visual frame pacing and final PTY dimensions; one without the other is not a
correct resize implementation.
