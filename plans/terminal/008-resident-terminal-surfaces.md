# Plan 008: Keep terminal runtimes resident across pane zoom and responsive layout changes

> **Executor instructions**: Preserve all active Plan 004–007 work. Implement
> this as a shared browser/Tauri client capability, not a desktop-only fix.
> Update `plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat f21fcdf4..HEAD -- packages/yaade-app/src/mux packages/yaade-ui/src/panels packages/ghostty-react tests/web/e2e tests/bench`
> Confirm Plans 004, 005, and 007 are DONE. If their runtime, ACK, or lifecycle
ownership differs from this plan's notes, stop and reconcile the seam first.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 004, 005, and 007
- **Category**: perf / architecture / correctness
- **Planned at**: commit `f21fcdf4`, 2026-08-30

## Why this matters

The supplied recording is dominated by lifecycle churn, not only shader speed.
Browser zoom changes the CSS viewport and can cross the 767 px mobile media
query. `TerminalMultiplexer` then swaps the entire desktop workspace for
`MobileTerminalView`. Pane zoom similarly swaps `PanelDockInDnd` for a separate
zoom tree. React keys cannot preserve a terminal component when its parent tree
is replaced, so `TerminalPanel` tears down its surface, parser/worker, GPU
context, subscription, and transport writer, then initializes and reattaches a
new surface.

Visible evidence matches that path: the terminal goes blank, its title falls
back from `btop` to `fish`, mobile controls appear, and the TUI receives
intermediate dimensions before repainting. A layout change must move or reveal
an existing terminal surface; it must not reconstruct terminal state from replay.

## Current state

- `packages/yaade-ui/src/hooks/use-mobile.ts` uses
  `matchMedia("(max-width: 767px)")`; browser zoom can cross that CSS breakpoint.
- `TerminalMultiplexer.tsx` conditionally renders either `MobileTerminalView` or
  the desktop shell.
- `TerminalTilingWorkspace.tsx` conditionally renders either a hand-built
  zoomed leaf or `PanelDockInDnd`.
- `TerminalPanel.tsx` owns surface creation, PTY attach/subscription, input and
  output writers in one mount effect. Cleanup flushes, unsubscribes, disposes
  the surface, core/worker, and renderer.
- `MobileTerminalView.tsx` retains up to six mobile terminals only inside the
  mobile tree; crossing back to desktop still destroys that tree.
- Architecture invariants require one shared client implementation, PTY bytes
  outside React state, and browser disconnect/unmount not killing the PTY.

## Target design

Split terminal **runtime residency** from terminal **placement**:

- A `TerminalSurfaceSession` keyed by stable terminal ID owns the Ghostty
  runtime/worker, renderer controller, DOM terminal mount, transport attach,
  writers, registry entry, and lifecycle diagnostics.
- A React provider/registry at the stable Session-shell level owns bounded
  resident sessions. It is mounted above the mobile/desktop conditional.
- Desktop leaves, mobile detail/retained slots, and pane zoom acquire a placement
  lease and reparent the existing terminal mount into the current slot without
  recreating its session.
- Exactly one visible placement may own focus/input for a terminal. Hidden
  placements render no duplicate canvas and call `setVisible(false)`.
- Residency bounds preserve the existing mobile cap and define a desktop policy;
  eviction may dispose a hidden client runtime but must never dispose the PTY.

Moving a live canvas DOM node between slots is acceptable only after tests prove
WebGL context, textarea focus, pointer capture cleanup, ResizeObserver, and
accessibility ownership survive. Do not render duplicate `TerminalPanel`
instances for the same terminal.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Unit/app | `vp test packages/ghostty-react packages/yaade-ui packages/yaade-app` | all pass |
| Typecheck/lint | `vp run typecheck && vp run lint` | exit 0 |
| Web E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts tests/web/e2e/terminal-compatibility.web.spec.ts` | pass |
| Platform E2E | `vp exec playwright test --project=platform-e2e` | terminal cases pass |
| Bench | `vp run test:bench` | lifecycle and latency budgets pass |

## Scope

**In scope**

- New residency/session modules under `packages/yaade-ui/src/panels/` or a
  narrower shared terminal package location that preserves package acyclicity.
- `TerminalPanel.tsx`, terminal registry integration, and focused tests.
- `TerminalMultiplexer.tsx`, `TerminalTilingWorkspace.tsx`, and
  `MobileTerminalView.tsx` placement integration.
- Terminal multiplexer/compatibility E2E and Plan 007 benchmarks.

**Out of scope**

- Server PTY ownership changes, detached supervisors, desktop-native renderers,
  keeping every terminal resident without a bound, or PTY output in React state.
- Visual redesign of mobile/desktop chrome.

## Steps

### Step 1: Characterize current remount behavior

Using Plan 007 IDs/counters, add failing tests for pane zoom and viewport
767→768→767 transitions. Capture surface instance, runtime generation, renderer
generation, PTY ID, attach count, parsed model frame, and terminal title before
the transition.

**Verify**: the tests demonstrate current surface recreation/reattach while PTY
ID remains stable. Commit these tests before changing ownership.

### Step 2: Extract a non-visual terminal session controller

Move the mount effect's long-lived responsibilities into a typed controller:
surface/runtime creation, attach/replay, transport subscription, input/output
writers, PTY resize callback, title callback, registry registration, visibility,
and disposal. Keep callback/state boundaries narrow; status overlays can remain
React state subscribed at low frequency.

The controller must not import application mux state or React. External values
continue through existing typed host APIs. Preserve Plans 004/005 parsed/replay
ACK semantics exactly.

**Verify**: controller tests cover acquire, attach once, detach placement,
reattach placement, hidden output, input ordering, error, eviction, and dispose.

### Step 3: Add a bounded stable residency provider

Mount one provider above the `isMobile ? ... : ...` branch. It creates or reuses
controllers by terminal ID and reference-counts placement leases. Define bounds
and LRU eviction for hidden sessions; visible sessions are never evicted.

A discarded client session unsubscribes and disposes browser resources only.
It must not call terminal dispose/close. Reacquisition may replay because of
actual eviction; mere layout movement may not.

**Verify**: switching layouts 50 times keeps one session/controller and one
subscription; opening more hidden terminals than the bound evicts only the
least-recently-used hidden client session.

### Step 4: Preserve pane zoom without replacing the dock tree

Keep `PanelDockInDnd` mounted. Present the zoomed leaf by layout/CSS state or a
placement lease while hiding non-zoomed leaves; do not branch to a second copy
of `renderContent`. Hidden siblings remain resident and call `setVisible(false)`.
Honor reduced motion and keep the action immediate.

**Verify**: zoom in/out preserves every terminal surface ID, scrollback,
selection, worker/runtime generation, renderer generation, title, focus target,
and PTY ID. No attach or replay occurs.

### Step 5: Move the active session between desktop and mobile slots

Desktop and mobile chrome acquire placement leases from the same stable
controller. On media-query change, transfer the mount once in a layout effect,
then fit it to the destination. The old slot becomes inert/hidden before the new
slot receives focus. Preserve mobile accessory-key routing and desktop pane
focus.

**Verify**: cross 767 px repeatedly while a deterministic TUI runs. Assert one
canvas and one hidden textarea for the terminal, no blank replacement overlay,
no title reset, no reattach, no lost keyboard/IME input, and complete final text.

### Step 6: Harden move, recovery, and teardown races

Cover move during output, synchronized output, worker update, renderer recovery,
font/DPR update, pointer selection, and session close. Placement generations
must reject stale layout-effect completions. A close disposes the client session
once; a move never does.

**Verify**: race tests assert one owner, no duplicate listeners/subscriptions,
no post-dispose callback, and no renderer context loss caused by DOM reparenting.

### Step 7: Benchmark the supplied interaction class

Run Plan 007's pane zoom and responsive breakpoint workloads three times for
WebGL and forced Canvas. Require zero surface recreation,
zero attach/replay, zero PTY ID/title reset, and zero renderer recovery. Record
transition→next-painted-frame p50/p95/p99 and long tasks.

**Verify**: `vp run test:bench` passes without loosening existing budgets.

## Test plan

- Controller unit tests use fake host APIs and renderer/runtime adapters.
- E2E uses real PTY output and checks DOM count, IDs, title, focus, dimensions,
  text, and connection state.
- Test pane zoom, responsive crossing, mobile list/detail, six retained mobile
  terminals, eviction, and browser reload (reload is allowed to reattach).
- Verify both normal and reduced-motion settings.

## Done criteria

- [ ] Pane zoom and mobile/desktop switching do not recreate or reattach a resident terminal.
- [ ] One terminal has exactly one runtime, renderer, canvas, textarea, subscription, and active placement.
- [ ] Residency is bounded and eviction never kills a PTY.
- [ ] PTY bytes remain outside React state.
- [ ] Keyboard, IME, selection, links, scrollback, title, and focus survive movement.
- [ ] Browser and Tauri use the same implementation.
- [ ] Unit, typecheck, lint, E2E, and benchmark gates pass.

## STOP conditions

- Plan 004/005 ownership cannot be extracted without changing parse ACK meaning.
- Moving the canvas reliably loses WebGL state in a supported WebView and no
  stable session/placement alternative preserves one renderer.
- The design creates duplicate active terminal instances or unbounded residency.
- A layout change requires PTY replay or PTY recreation.
- Package placement introduces a React import into a lower non-React layer.

## Maintenance notes

Treat a terminal ID as the identity of one resident client session, not one
layout slot. New views must acquire placement leases rather than instantiate
`TerminalPanel` independently. Review future responsive or zoom changes with the
lifecycle benchmark; a stable PTY ID alone is insufficient if the client parser,
GPU context, or transport subscription was rebuilt.
