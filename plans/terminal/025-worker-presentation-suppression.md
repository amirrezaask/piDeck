# Plan 025: Suppress hidden and synchronized worker frame preparation

> **Executor instructions**: Complete Plans 014, 015, and 016 first. Preserve
> current renderer work and run each verification step. This plan may suppress
> render updates, never parser writes or parsed acknowledgements. Stop if worker
> suppression changes terminal byte ordering. Mark this plan and its README row
> `DONE` after browser and Tauri verification.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 8bbcd017..HEAD -- \
>   packages/ghostty-react/src/surface.ts \
>   packages/ghostty-react/src/worker \
>   packages/yaade-ui/src/panels/TerminalPanel.tsx \
>   packages/yaade-app/src/test-bridge.ts tests/web/e2e \
>   docs/terminal-renderers.md
> git diff --stat -- \
>   packages/ghostty-react/src/surface.ts \
>   packages/ghostty-react/src/worker \
>   packages/yaade-ui/src/panels/TerminalPanel.tsx \
>   packages/yaade-app/src/test-bridge.ts tests/web/e2e \
>   docs/terminal-renderers.md
> ```
>
> Plan 016 must provide its bounded recyclable slot API. Do not allocate a fourth
> slot or restore string writes when adding suppression.

## Status

- **Status**: DONE
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 014, 015, and 016
- **Category**: frontend performance / worker scheduling / correctness
- **Planned at**: commit `8bbcd017`, 2026-08-30
- **Source findings**: SolPro P1-9 and P1-10

## Why this matters

The surface currently skips paint while hidden or while DEC private mode 2026
is active. The worker has already parsed, extracted, packed, and transferred a
render update by then. Hidden panes and synchronized TUI transactions pay most
frame-preparation cost for frames users cannot see.

The worker should keep Ghostty state current and preserve ACK/query behavior,
then build one catch-up update when visibility returns or synchronized output
ends.

## Current state

`surface.ts::setVisible` cancels main-thread animation work and requests a full
frame when shown, but it does not send visibility to the worker.

`surface.ts::afterTerminalWrite` checks mode 2026 after a worker update arrives.
`terminal-worker.ts` writes bytes, schedules `core.renderUpdate()`, and posts
`parsed` for each command. The worker can inspect `core.isModeEnabled(2026)`, but
currently does so only while building runtime state for an update.

## Target state machine

```text
visibility = hidden | visible
sync       = inactive | suppressing(deadline) | timedOut
pending    = none | dirty | full

hidden                         parse + ACK, pending full, no extraction
visible + suppressing          parse + ACK, pending dirty/full, no extraction
visible + inactive/timedOut    use Plan 016 slot or retain pending state
show / sync close              one authoritative catch-up
sync deadline                  resume updates while stuck mode remains active
```

Hidden visibility overrides synchronized timeout presentation. A `parsed` event
must not wait for visibility, mode exit, a render slot, rAF, or GPU work.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Worker unit | `vp test packages/ghostty-core packages/ghostty-react` | state-machine/slot tests pass |
| UI integration | `vp test packages/yaade-ui packages/yaade-app` | visibility/focus integration passes |
| E2E | focused compatibility and multiplexer Playwright commands | hidden/sync behavior passes |
| Desktop | `vp run test:desktop` | shared Tauri runtime passes |
| Type/lint/build | `vp run typecheck && vp run lint && vp run build:web` | exit 0 |

## Scope

**In scope**

- `packages/ghostty-react/src/surface.ts`
- `packages/ghostty-react/src/worker/protocol.ts`
- `packages/ghostty-react/src/worker/terminal-worker.ts`
- `packages/ghostty-react/src/worker/worker-terminal-core.ts`
- Focused unit tests for the worker presentation state machine
- `TerminalPanel.tsx` only to propagate explicit visible/focused input
- Payload-free diagnostic counters through the existing test bridge
- Terminal compatibility/multiplexer E2E and Tauri tests
- `docs/terminal-renderers.md` and `plans/README.md`

**Out of scope**

- Cross-terminal priority/fairness: Plan 026.
- Benchmark framework/budgets: Plan 027.
- Render scene or slot implementation changes from Plans 014/016.
- Server transport/history/parser changes.
- New visible controls, colors, motion, or terminal chrome.

## Steps

### Step 1: Characterize frame work that the surface discards

Add payload-free counters at existing coarse boundaries:

```text
worker writes/bytes/parsed
render update builds/transfers
suppressed hidden
suppressed synchronized
full catch-ups
sync safety timeouts
pending state and slots in flight
```

Mirror counters through the test bridge without terminal payloads. Add test
fixtures for a hidden terminal flood, a mode-2026 dashboard, and a mode left open
past one second. Establish that current code builds/transfers updates despite no
paint. Keep final zero-build assertions disabled until Steps 3–4 implement them;
do not leave failing tests between steps.

**Verify**:

```bash
vp test packages/ghostty-react packages/yaade-ui
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts
```

Expected: baseline counters identify discarded work and current semantics pass.

### Step 2: Send generation-scoped presentation state to the worker

Add a validated command such as:

```ts
{ type: "setPresentationState", visible: boolean, focused: boolean }
```

This plan uses `visible`; Plan 026 consumes `focused`. Extend the runtime port
with one deduplicating method. Carry initial state in the create command so a
hidden runtime cannot emit its initial frame before a follow-up state message.
Update later state from explicit panel/resident-surface visibility and input
focus/blur, not `getBoundingClientRect` guesses.

Ignore stale generations. Hide cancels pending extraction, show requests one full
catch-up, and dispose removes all state/timers. Main-thread fallback stores the
same state and retains equivalent behavior.

**Verify**:

```bash
vp test packages/ghostty-react packages/yaade-ui
vp run typecheck
```

Expected: create/hide/show/focus/blur/dedup/stale-generation/dispose tests pass.

### Step 3: Skip render extraction while hidden

For hidden runtimes:

- parse every byte/replay/reset command;
- apply resize/theme/control mutations;
- post `parsed` at the existing semantic point;
- update title/modes/effects needed for correctness;
- mark a full catch-up pending;
- do not call `renderUpdate`, lease a slot, pack/transfer arrays, apply viewport
  data, upload WebGL state, or request paint.

On show, wait for a returned slot if necessary and emit exactly one full update
from current Ghostty state. A hide/show/hide race must not emit an invisible
frame. A terminal hidden while busy remains parsed and query-capable.

**Verify**:

```bash
vp test packages/ghostty-react
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts
```

Expected: hidden flood reaches final parse/ACK with zero update builds/transfers;
show emits one full frame with final terminal contents.

### Step 4: Move DEC 2026 suppression before extraction

After each write/replay parse, inspect mode 2026 before scheduling an update.
Implement these transitions:

- inactive to suppressing: cancel pending extraction and arm one 1,000 ms timer;
- suppressing writes: accumulate dirty state, build no update;
- mode clears: cancel timer and emit one catch-up;
- deadline fires: enter `timedOut`, emit one catch-up, and allow later updates
  while the faulty mode remains open;
- mode clears after timeout: return to inactive without a duplicate frame;
- hidden state: retain pending catch-up but emit nothing.

Use fake timers for 999/1000 ms boundaries. Do not re-arm suppression after every
write and postpone the deadline forever. Align main-thread fallback semantics so
the surface does not discard the worker's timeout frame.

**Verify**:

```bash
vp test packages/ghostty-core packages/ghostty-react
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts
```

Expected: one build/present per complete synchronized transaction, no
intermediate build, and stuck mode resumes display after the safety deadline.

### Step 5: Resolve slot, resize, recovery, and visibility races

Test and implement explicit outcomes for:

- all three Plan 016 slots in flight when show/mode-exit occurs;
- resize/theme/font generation while hidden or synchronized;
- worker crash/recreate while suppression is active;
- selection/scroll/requestFullFrame while hidden;
- browser page visibility/rAF suspension;
- dispose with pending timer/update.

Control operations may require state responses, but hidden state still forbids
render extraction. Coalesce pending dirty to full when geometry/generation makes
partial rows unsafe. Recovery creates one current-generation full frame.

**Verify**:

```bash
vp test packages/ghostty-react packages/yaade-ui
vp run test:desktop
```

Expected: no stale/duplicate frame, leaked slot/timer, or lost final geometry.

### Step 6: Run visible browser verification and document the state machine

Use scoped DOM/text/dimension assertions and test-bridge counters. Verify two
visible panes, hidden resident panes, focus changes, synchronized TUI output,
show catch-up, stuck-mode timeout, resize while hidden, and Canvas fallback.
Inspect browser console and worker errors.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:web
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-compatibility.web.spec.ts \
  tests/web/e2e/terminal-multiplexer.web.spec.ts
vp run test:desktop
vp run build:web
vp run build:desktop
```

Expected: all pass; counters prove suppression occurs in the worker before
packing/transfer.

## Test plan

- Presentation command validation, ordering, dedup, generation, and disposal.
- Hidden parse/ACK, resize/theme, show catch-up, slot wait, and hide/show races.
- Sync enter/write/exit, fake timeout, continued timed-out updates, hidden
  interaction, and main-thread fallback parity.
- Recovery and stale frame rejection.
- Browser/Tauri scoped terminal text, dimensions, counters, console, and workers.

## Done criteria

- [x] Worker receives explicit generation-scoped visibility/focus state.
- [x] Hidden terminals parse and ACK with zero render build/transfer work.
- [x] Show emits one full authoritative catch-up.
- [x] Mode 2026 suppresses extraction and emits one catch-up on completion.
- [x] Stuck synchronized output resumes by the safety deadline and remains live.
- [x] Parsing/effects never wait for presentation or render slots.
- [x] Resize/recovery/dispose races leak no slots, timers, or stale frames.
- [x] Browser and Tauri tests verify visible behavior and scoped counters.

## Completion record

The baseline already carried explicit generation-scoped presentation state into
the worker and suppressed render extraction for hidden and synchronized
terminals while posting parsed acknowledgements. Completion fixes hidden-show
diagnostics so every pending authoritative full frame is counted, then extends
browser coverage to prove hidden mobile terminals parse bytes without increasing
render-build/transfer counts and emit one catch-up when shown. The synchronized
safety test now also asserts worker suppression and catch-up counters. Focused
checks passed three consecutive runs; worker/core/UI/web tests, typecheck, Tauri
tests, and browser/Tauri production builds pass. The unchanged repository-wide
lint findings and unrelated full-suite E2E flakes remain under the operator's
baseline waiver.

## STOP conditions

- Suppression remains only in the surface after worker extraction.
- Parsed ACK or query effects wait for show, mode exit, rAF, or a free slot.
- The timeout emits one frame and then suppresses later writes forever.
- Hidden/show can apply stale geometry or a pre-hide frame.
- Fixing races requires changing Plan 016 slot ownership or Plan 014 renderer
  contracts inside this plan.
- Work expands into cross-terminal priority, benchmark budgets, or visible UI.

## Maintenance notes

Each worker command should state whether it mutates parser state, needs a result,
or needs presentation. Visibility and synchronized output may coalesce frames,
not bytes. Keep the state machine centralized and use fake clocks for deadlines.
Reviewers should demand worker-side zero-build evidence rather than surface-only
paint counters.
