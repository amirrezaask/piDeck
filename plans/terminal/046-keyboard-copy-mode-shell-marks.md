# Plan 046: Add keyboard copy mode and shell-mark navigation

> **Executor instructions**: Complete Plans 034, 035, and the explicit semantic
> marker portion of Plan 036 before implementation. Preserve pre-existing work,
> read `packages/yaade-ui/AGENTS.md`, and keep terminal content outside React
> state. Follow every step and STOP condition. Update this plan and
> `plans/README.md` when complete.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 0739eacf..HEAD -- \
>   apps/server/src/{terminal,runtime}.rs crates/ghostty-vt \
>   packages/ghostty-{core,react}/src packages/yaade-rpc/src \
>   packages/yaade-host-client/src packages/yaade-ui/src/panels \
>   packages/yaade-app/src/{commands,mux} tests/web
> git diff --stat -- \
>   apps/server/src/{terminal,runtime}.rs crates/ghostty-vt \
>   packages/ghostty-{core,react}/src packages/yaade-rpc/src \
>   packages/yaade-host-client/src packages/yaade-ui/src/panels \
>   packages/yaade-app/src/{commands,mux} tests/web
> ```

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 034, 035, and 036 semantic markers
- **Category**: terminal UX / keyboard accessibility
- **Planned at**: commit `0739eacf`, 2026-08-31
- **Source finding**: heavy-terminal workflow review: history selection and command navigation require a mouse

## Why this matters

Heavy users need to search, navigate, select, and copy old terminal output while
keeping their hands on the keyboard. Shell integration can also identify prompt
and command boundaries without scraping arbitrary terminal text. One explicit
copy mode should compose those capabilities and guarantee that navigation keys
never reach the PTY.

## Current state

- `GhosttyTerminalSurface` already exposes selection text/positions, line/word
  selection, scrolling, and clipboard copy behavior in
  `packages/ghostty-react/src/surface.ts`.
- Worker commands include selection and scrolling but no keyboard copy-mode
  state machine.
- Plan 034 adds bounded hot/cold rows, stable row IDs, terminal-local find, and
  reveal. Reuse those modules rather than building another history/search model.
- Plan 036 accepts only explicit validated shell/task markers; arbitrary output
  scraping is prohibited.
- Plan 035 supplies stable command IDs and one command runtime.
- Any new `@yaade/app` unit test file must be listed in
  `packages/yaade-app/package.json`, per repository convention.

## Target module and interface

Create one `TerminalCopyModeController` below React. Its interface accepts a
small set of semantic actions: enter, exit, move, extend, search, next/previous
match, next/previous mark, copy, and jump live. It exposes content-free mode
status plus selection through the existing surface interface. It owns key
interpretation, stable row anchors, cold-page requests, cancellation, selection,
and focus restoration.

Shell marks are typed metadata bound to terminal epoch, source sequence, stable
row ID, and one of a closed set such as `prompt`, `commandStart`, `commandEnd`,
`commandFailed`. They never contain command text, output text, CWD, or arbitrary
OSC fields.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Server/protocol | `vp run test:server && vp run test:terminal:protocol` | marker validation and paging pass |
| Terminal units | `vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui packages/yaade-app` | copy-mode and selection tests pass |
| Type/lint | `vp run typecheck && vp run lint` | exit 0 |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-copy-mode.web.spec.ts` | real PTY keyboard/copy cases pass |

## Scope

**In scope**

- Renderer-neutral keyboard copy-mode controller
- Vi-like default navigation through Plan 035's command/keymap system
- Search and hot/cold reveal through Plan 034
- Explicit shell prompt/command marks and next/previous navigation
- Selection/copy across loaded page boundaries
- Compact mode status/help, desktop/mobile commands, and tests

**Out of scope**

- Shell command-history storage or a command palette populated from transcript
- Parsing visible rows to infer prompts, commands, success, or failure
- Editing terminal content
- A second search index or unbounded DOM terminal
- User-editable keymaps; Plan 047 owns overrides

## Steps

### Step 1: Freeze copy-mode and mark semantics

Write a transition/key table before implementation. Recommended defaults while
mode is active: `h/j/k/l` and arrows move, `w/b` move by word, `v` toggles cell
selection, `V` line selection, `y` copies/exits, `/` opens Plan 034 find,
`n/N` navigate results, `[`/`]` navigate marks, `g/G` oldest/live, and `q` or
Escape exits. All are commands, not hard-coded component handlers.

Define behavior for wrapped/wide rows, alternate screen, reflow, retention gaps,
new live output, search overlays, observer mode, and disconnected/read-only
terminals.

**Verify**: `vp test packages/yaade-app packages/ghostty-react` → exhaustive
transition fixtures compile and pass before side effects exist.

### Step 2: Persist and page content-free shell marks

Extend the typed semantic/history contracts with bounded mark pages keyed by
terminal ID/epoch and row/index generation. The host parser accepts only marker
kinds exposed by the authoritative parser from Plans 023/036. Validate field
sizes and ordering; discard free-form command payloads. Retention deletes stale
marks atomically with their rows.

**Verify**: `vp run test:server && vp run test:terminal:protocol` → valid marks
survive restart; malformed, spoofed, stale-epoch, and retention-trimmed marks do
not produce navigation targets or content leaks.

### Step 3: Add the copy-mode controller at the surface seam

Implement the controller in `packages/ghostty-react/src/` and route actions to
existing selection/viewport interfaces. Keep cursor/anchor IDs in the controller,
not React. Fetch at most the bounded Plan 034 page window, cancel stale moves,
and preserve a stable screen anchor while output arrives.

Add worker commands only for primitive operations that truly belong in the
runtime; do not mirror the whole controller into worker protocol messages.

**Verify**: `vp test packages/ghostty-core packages/ghostty-react` → movement,
extension, Unicode, wrapped rows, page crossing, cancellation, and runtime parity
pass.

### Step 4: Integrate command dispatch and PTY key suppression

Register `terminal.copyMode`, movement, selection, mark, search, copy, and exit
commands through Plan 035. While copy mode owns focus, its recognized keys are
prevented before `GhosttyTerminalSurface.encodeKey`; unrecognized keys either do
nothing with an accessible explanation or exit according to the frozen table.
No key may both mutate copy mode and reach the PTY.

On exit restore the prior terminal focus and inspection state. Copy uses the
ordinary user-initiated clipboard path from Plan 039 when that plan is present.

**Verify**: `vp test packages/yaade-app packages/yaade-ui` → every mode key maps
once, overlays restore focus, and PTY passthrough resumes only after exit.

### Step 5: Add restrained mode chrome

Show a compact, semantic-token status treatment with mode name, active search or
mark position, and a discoverable help action. Do not cover selected rows or
turn every key into an animated toast. Mobile exposes explicit previous/next,
select, copy, and exit controls with safe-area spacing.

**Verify**: headed Playwright captures desktop, mobile, search, selection,
read-only, and retention-gap states with reduced motion and high contrast.

### Step 6: Prove behavior with a real shell

Create `terminal-copy-mode.web.spec.ts`. Emit known prompt markers and output,
enter copy mode, navigate old/cold rows, select and copy exact Unicode/wrapped
text, jump between marks, and exit. Assert PTY output proves navigation keys were
not sent; then send one key after exit and assert it is received exactly once.
Cover reconnect and output arriving during selection.

**Verify**: run the E2E command three times → all runs pass without timer sleeps.

## Test plan

- Marker protocol: epoch/order/bounds, restart, retention, no content fields.
- Controller: state table, movement, selection, search, marks, page cancellation.
- Compatibility: wide/combining/wrapped rows, alternate screen, resize/reflow.
- E2E: exact clipboard value, zero PTY leakage in mode, one PTY event after exit.

## Done criteria

- [ ] Copy/search/mark navigation works without a mouse across hot and cold rows.
- [ ] No copy-mode key reaches the PTY.
- [ ] Marks come only from explicit validated semantics and contain no transcript.
- [ ] Selection and mode state stay below React and remain bounded.
- [ ] Exit restores focus and normal terminal input exactly once.
- [ ] Server, protocol, unit, type, lint, visual, and real-PTY E2E gates pass.

## STOP conditions

- Prompt/command navigation requires scraping terminal text.
- Copy mode needs full history in DOM, React, or one browser allocation.
- Plan 034 lacks stable row IDs across the required selection operation.
- A key can reach both copy mode and the PTY in one gesture.
- Clipboard integration bypasses Plan 039 policy or changes selected bytes.

## Maintenance notes

Copy mode consumes the row/search/mark interfaces; it must not know their
storage implementation. New movement styles belong behind command IDs so Plan
047 can remap them without changing selection or terminal semantics.
