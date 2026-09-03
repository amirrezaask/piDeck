# Plan 045: Keep inspected scrollback anchored and surface unseen output

> **Executor instructions**: Follow this plan step by step. Preserve all
> pre-existing working-tree changes. Read `packages/yaade-ui/AGENTS.md` before
> visible UI work. PTY output must not enter React state. Run each verification
> gate before continuing; if a STOP condition occurs, report it rather than
> improvising. When complete, update this plan and its row in
> `plans/README.md` to `DONE`.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 0739eacf..HEAD -- \
>   packages/ghostty-{core,react}/src \
>   packages/yaade-ui/src/panels packages/yaade-ui/src/styles \
>   packages/yaade-app/src/{commands,keybindings.ts,mux} \
>   tests/web/e2e
> git diff --stat -- \
>   packages/ghostty-{core,react}/src \
>   packages/yaade-ui/src/panels packages/yaade-ui/src/styles \
>   packages/yaade-app/src/{commands,keybindings.ts,mux} \
>   tests/web/e2e
> ```
>
> Reconcile the live command seam with Plan 035 before editing. If Plan 035 is
> not complete, implement the terminal viewport module and tests first, then
> stop before command registration rather than creating a second registry.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 035 for command registration; the viewport module may land independently
- **Category**: terminal UX / interaction correctness
- **Planned at**: commit `0739eacf`, 2026-08-31
- **Source finding**: heavy-terminal workflow review: scroll inspection loses context when output continues

## Why this matters

Heavy terminal users routinely scroll back while builds, tests, and agents keep
writing. The viewport must remain anchored to what they are reading, never jump
to live output, and make accumulated output obvious without covering terminal
content. Returning live should be one deterministic action on desktop and
mobile.

## Current state

- `packages/ghostty-react/src/surface.ts:1348-1358` exposes
  `scrollToBottom()`, `isAtBottom()`, `getViewportY()`, and `scrollLines()`.
- The worker state already reports `scrollbar` and `viewportActive`; main and
  worker runtimes therefore have the facts needed for one shared policy.
- `packages/yaade-ui/src/panels/TerminalPanel.tsx` owns the visible terminal
  mount, but has no unseen-output affordance.
- `packages/yaade-app/src/keybindings.ts` has one catalog and a
  `terminal.jump` command, while Plan 035 replaces split command metadata with a
  typed registry. Do not add component-local chords.
- Plan 034 will add cold rows above Ghostty. The interface introduced here must
  describe viewport activity without exposing whether rows are hot or cold.
- Any new `@yaade/app` unit test file must be listed in
  `packages/yaade-app/package.json`, per repository convention.

## Target module and interface

Add one deep viewport-activity module below React. Its small interface should be
conceptually equivalent to:

```ts
type TerminalViewportActivity = {
  readonly mode: "live" | "inspecting" | "paused"
  readonly unseenRows: number | null
}

subscribeViewportActivity(listener): () => void
jumpToLive(): void
togglePause(): void
```

The implementation owns live/inspection transitions, total-row baselines,
coalescing, anchor restoration, worker/main parity, and count saturation. Callers
must not calculate deltas from raw scrollbar snapshots. `null` means “new
output” when an exact row count is unavailable; never report a false exact
number.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Terminal units | `vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui` | viewport policy and surface tests pass |
| App units | `vp test packages/yaade-app` | command and focus tests pass |
| Type/lint | `vp run typecheck && vp run lint` | exit 0 |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-scrollback.web.spec.ts` | real PTY anchor/jump cases pass |

## Scope

**In scope**

- A renderer/runtime-neutral viewport activity policy and subscription seam
- Stable inspection anchoring while live output arrives
- Explicit pause/resume inspection mode
- Imperatively updated, accessible **Jump to live** affordance with unseen count
- Command-registry action, mobile behavior, tests, and diagnostics without content

**Out of scope**

- Terminal search or cold-row storage; Plan 034 owns those
- Mirroring rows or PTY bytes into React/DOM
- Pausing the PTY, parser, ACKs, history, or agent process
- Notifications/activity badges; Plan 036 owns those
- User-editable shortcuts; Plan 047 owns those

## Steps

### Step 1: Characterize current anchoring

Add deterministic tests around main and worker runtime scrollbar behavior:
scroll up, append rows, rewrite the active screen without appending, resize,
trim scrollback, alternate-screen enter/leave, and jump live. Record whether
Ghostty preserves the viewed rows or only a numeric offset.

**Verify**: `vp test packages/ghostty-core packages/ghostty-react` → all new
characterization cases pass on both runtime paths.

### Step 2: Introduce the viewport-activity module

Create a pure state machine, tested without DOM, that accepts content-free
facts such as viewport active, total rows, offset, generation, and retention
floor. Coalesce listener publication to the terminal presentation clock. Enter
`inspecting` after user scroll leaves live; establish a baseline; increase
`unseenRows` only for appended stable rows. Retention or reflow that invalidates
an exact baseline changes the count to `null` without moving the viewport.

Keep this module internal to `@yaade/ghostty-react`; expose only subscription,
`jumpToLive`, and `togglePause` through `GhosttyTerminalSurface`.

**Verify**: `vp test packages/ghostty-react` → transition, saturation, reflow,
retention, and unsubscribe tests pass.

### Step 3: Preserve a stable viewport anchor

Wire both main and worker updates into the module. While inspecting or paused,
new output continues parsing and ACKing but cannot activate the live viewport.
If numeric offset is insufficient, anchor by the stable row identity supplied by
Plan 034 when available; before Plan 034, use only behavior proven by Step 1.
Never compensate with timers or repeated scroll calls.

**Verify**: `vp test packages/ghostty-core packages/ghostty-react` → appending
1,000 rows leaves the same top visible row and `jumpToLive()` reaches current
output in one action.

### Step 4: Add the jump-to-live affordance

Render one compact control in `TerminalPanel`. Keep it mounted but update its
hidden state, label, and count imperatively from the surface subscription so
PTY-driven updates do not rerender React. Use semantic tokens and a hit target
that meets the design-system minimum. Labels are **Jump to live**, **N new
rows**, or **New output**; cap visual numbers at `999+` while retaining the
accessible exact value when known and reasonably bounded.

The control must not cover the active prompt, steal terminal focus after use, or
spam `aria-live`. On mobile place it above accessory controls and safe areas.

**Verify**: focused Playwright screenshots cover 0, 1, many, unknown, mobile,
high-contrast, and reduced-motion states.

### Step 5: Register jump-live and pause commands

After Plan 035, register stable command IDs such as `terminal.jumpLive` and
`terminal.toggleInspectionPause`. Availability comes from the focused surface;
keyboard, command palette, button, and which-key invoke the same handler. Do not
bind plain `End`, Escape, or terminal-reserved keys.

**Verify**: `vp test packages/yaade-app packages/yaade-ui` → command
availability, focus restoration, and PTY passthrough tests pass.

### Step 6: Add real-PTY E2E and performance guards

Create `tests/web/e2e/terminal-scrollback.web.spec.ts`. Print numbered lines,
scroll to a known marker, continue output, and assert the marker remains visible,
the unseen indicator increases, jump-live reveals the newest marker, and the
PTY received no navigation keystrokes. Repeat through resize, pane switch,
reconnect, mobile, and output flood. Add a render-count assertion proving the
indicator does not trigger one React render per output chunk.

**Verify**: run the E2E command above three consecutive times → all runs pass
without arbitrary sleeps.

## Test plan

- Pure state: transition table, exact/unknown counts, reset, trim, reflow, pause.
- Runtime parity: main/worker anchoring, alternate screen, resize, hidden/show.
- UI: row count text, visibility, focus, touch size, reduced motion, a11y name.
- E2E: real numbered PTY rows, live flood, reconnect, jump and zero input leak.

## Done criteria

- [x] Reading position never moves because new output arrives.
- [x] Parser, replay, ACK, history, and PTY continue while inspection is paused.
- [x] The affordance reports exact unseen rows only when exactness is proven.
- [x] Jump-live returns to current output and terminal focus in one action.
- [x] PTY bytes/rows do not enter React state or a growing DOM.
- [x] Main/worker, desktop/mobile, unit, type, targeted lint, and Playwright gates pass.

## Implementation notes

- `TerminalViewportActivityPolicy` owns live, inspecting, and paused transitions
  from content-free scrollbar, geometry, content-generation, retention, and
  alternate-screen facts. Reflow, reconnect replay, or retention uncertainty
  reports `null` rather than a false exact count.
- `GhosttyTerminalSurface` publishes activity on the presentation path and
  exposes jump/pause operations. Characterization tests prove Ghostty preserves
  the viewed rows while output appends and through alternate-screen and resize
  transitions; browser coverage exercises both worker and main runtimes.
- `TerminalPanel` keeps one accessible jump control mounted and updates its
  label, visibility, mode, and count imperatively. The resident-surface seam
  moves that control with the canvas on mobile, where it retains a 44px target.
  PTY output is never copied into React state or DOM.
- `terminal.jumpLive` (`Mod-k g`) and
  `terminal.toggleInspectionPause` (`Mod-k Shift-G`) are static command
  descriptors with focused-surface availability and scoped runtime handlers.
  Keyboard, palette, which-key, native-menu, and pointer execution share that
  runtime. Removed prefix/direct aliases remain banned.
- `scroll-lock-unseen-output.web.spec.ts` uses real numbered PTY output to prove
  stable anchors, exact and unknown counts, one-action jump, paused inspection,
  intentional host reconnect, ordinary resize, no navigation-byte leakage,
  bounded React renders, main/worker parity, and desktop/mobile behavior.
- Verification completed with 43 unit files / 234 tests, repository typecheck,
  3 focused scroll-lock Playwright cases passing three consecutive runs, and
  the existing 22 command-palette and terminal-multiplexer cases. Targeted type-aware lint passes. Repository-
  wide `vp run lint` remains blocked by pre-existing anti-slop diagnostics in
  unrelated files.

## STOP conditions

- Stable anchoring requires polling or timer-based corrective scrolling.
- Main and worker Ghostty paths cannot expose equivalent viewport facts.
- The implementation needs terminal text in React state.
- “Pause” would stop parsing, transport ACKs, history ingest, or the PTY.
- Plan 034's cold-row seam cannot consume the same activity interface.

## Maintenance notes

Viewport activity is one module with hot and cold adapters, not separate UI
policies. Future retention, search reveal, and copy mode must explicitly choose
whether they preserve inspection, change its anchor, or jump live.
