# Plan 003: Make terminal renderer failure and recovery explicit

> **Executor instructions**: Preserve local work, execute every gate, and update
> `plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 717ed49f..HEAD -- packages/ghostty-react packages/yaade-ui/src/panels/TerminalPanel.tsx tests/web/e2e tests/bench`
> Confirm Plans 001 and 002 are DONE.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 001 and 002
- **Category**: correctness / perf
- **Planned at**: commit `717ed49f`, 2026-08-30

## Why this matters

GPU contexts can disappear after sleep, memory pressure, driver reset, monitor
changes, or browser intervention. A renderer failure must be recoverable without
losing terminal state, acknowledging unparsed output, reconnecting, or killing
the PTY. Recovery should be one deep module rather than scattered catches in
surface event handlers.

## Current state

Before Plan 002, `GhosttyTerminalSurface.create()` throws if Canvas 2D is
unavailable and `TerminalPanel.tsx` displays a failed terminal. Plan 002 adds
WebGL selection but only initialization fallback. xterm's WebGL adapter also
treats context loss as expected; YAADE needs stronger behavior because terminal
state and PTY lifetime are independent of the renderer.

## Target design

Add `src/renderers/renderer-controller.ts`. It owns the active adapter,
generation, failure counters, replacement, and recovery state. Its interface to
`GhosttyTerminalSurface` should be limited to initialize, render, resize,
setFont, backend identity, requestRecovery, and dispose.

Recovery ladder:

```text
active WebGL2
  → restore same context once when the browser restores it
  → create a fresh WebGL2 adapter and full repaint
  → Canvas 2D adapter and full repaint
  → renderer-unavailable UI while parser/model/PTY remain alive
```

A later WebGPU adapter inserts before WebGL2. Recovery uses the retained model
from Plan 001 to force an authoritative full repaint.

## Commands

- `vp test packages/ghostty-react packages/yaade-ui` → pass
- `vp run typecheck && vp run lint` → exit 0
- `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts` → pass
- `vp run test:bench` → pass without material regression

## Scope

**In scope**

- `packages/ghostty-react/src/renderers/renderer-controller.ts` (new)
- corresponding tests
- `packages/ghostty-react/src/renderers/create-renderer.ts`
- `packages/ghostty-react/src/renderers/webgl2/**`
- `packages/ghostty-react/src/surface.ts`
- `packages/ghostty-react/src/GhosttyTerminal.tsx`
- `packages/yaade-ui/src/panels/TerminalPanel.tsx`
- focused E2E and benchmark files

**Out of scope**

- Worker failures, server reconnect/replay changes, React redesign, toast spam,
  telemetry vendors, native desktop implementation.

## Steps

### Step 1: Define the recovery state machine

Use explicit states: `initializing`, `ready`, `recovering`, `fallback`,
`unavailable`, `disposed`. Every async completion carries a controller
generation and is ignored when stale. Recovery is single-flight and bounded:
one restore attempt, one fresh adapter attempt, then fallback. Add exponential
cooldown before retrying an accelerated backend after repeated failures.

**Verify**: deterministic unit tests cover every transition, stale completion,
concurrent failures, repeated loss, and dispose during recovery.

### Step 2: Handle WebGL context loss correctly

Listen for `webglcontextlost`, call `preventDefault()`, stop submissions, and
retain parser/model state. On `webglcontextrestored`, recreate programs,
textures, VAOs, buffers, and atlas; never reuse stale GPU handles. Increment the
renderer generation and request one full repaint.

**Verify**: browser test dispatches/induces loss, confirms no draws while lost,
restores/replaces the adapter, and sees the pre-loss terminal text afterward.

### Step 3: Recover from non-context failures

Wrap adapter initialization, resize, font update, and render submission at the
controller seam. Classify failures as recoverable or permanent for that
backend. Do not catch programming defects silently in development/tests: record
the original error and fail the test bridge while production falls back.

**Verify**: injected failures in initialize/render/resize/font each choose the
expected ladder step and dispose old resources exactly once.

### Step 4: Preserve terminal and PTY state during fallback

The core/model continues parsing while the renderer is recovering. Do not
recreate `GhosttyTerminalCore`, call host attach, resize the PTY, or reset the
terminal. Once a backend is ready, apply current geometry and font, then full
repaint from the retained model. Input/IME remains live unless no renderer has
ever initialized; in that case keep input available and expose a scoped status.

**Verify**: E2E runs continuous PTY output through forced WebGL loss, observes a
Canvas fallback marker, and asserts no connection indicator, PTY ID change, or
missing final output.

### Step 5: Add scoped diagnostics

Expose backend, controller state, generation, recovery count, last error class,
and fallback reason through data attributes/test bridge—not React state and not
raw unvalidated errors. The user-visible failure state should be scoped to the
terminal pane and must not imply the agent process stopped.

**Verify**: scoped DOM assertions distinguish `webgl2 ready`, `canvas2d
fallback`, and `unavailable`; no global error appears for successful fallback.

### Step 6: Test lifecycle hazards

Cover hidden panes, zoom/DPR change during recovery, font load completion after
adapter replacement, document visibility changes, repeated sleep-like loss,
and disposal with queued animation frames. Ensure all listeners, timers, GPU
resources, and async callbacks are released.

**Verify**: unit tests assert no post-dispose draw/callback and E2E opens/closes
six terminals without increasing active contexts/listeners after cleanup.

### Step 7: Measure recovery overhead

Normal healthy frames should incur only one state check and no Promise/catch
allocation per frame. Compare benchmarks against Plan 002; median may not
regress more than 2% and p95/p99 more than 5%.

## Test plan

Use dependency-injected fake adapters for state-machine tests and real browser
WebGL for context-loss E2E. Add a PTY continuity test that emits monotonically
numbered lines during loss and asserts the final sequence after fallback.

## Done criteria

- [ ] Context loss is an expected tested event.
- [ ] Recovery never recreates, disconnects, resets, or kills a PTY.
- [ ] Old GPU objects and stale async completions cannot be reused.
- [ ] Canvas fallback fully repaints current retained state.
- [ ] Repeated failures are bounded and do not loop.
- [ ] Diagnostics are scoped and PTY bytes remain outside React state.
- [ ] Unit, E2E, typecheck, lint, and benchmark gates pass.

## STOP conditions

- Recovery requires terminal replay or PTY reattachment rather than repainting
the retained model.
- Context-loss simulation is impossible in the supported Playwright browser and
no deterministic adapter-injection test can cover it.
- Fallback changes terminal dimensions or sends a resize without a real layout
change.
- Repeated loss leaks a context, listener, timer, or retained atlas.

## Maintenance notes

Every future backend must declare initialization, recoverable failures,
resource-disposal behavior, and full-repaint semantics to the controller.
Reviewers should reject backend-specific fallback logic outside this module.
