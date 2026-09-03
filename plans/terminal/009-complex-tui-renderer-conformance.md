# Plan 009: Enforce Canvas and WebGL conformance for complex TUIs

> **Executor instructions**: Write characterization tests before fixes. Plan 006
> was rejected and removed after blank WKWebView output; scope this work to the
> shipped Canvas/WebGL ladder. Update `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat f21fcdf4..HEAD -- packages/ghostty-core packages/ghostty-react/src/renderers packages/ghostty-react/src/renderer.ts tests/web/e2e tests/bench`
> Confirm Plan 006 remains removed. Future adapters must adopt this same corpus,
> but this plan must not reintroduce WebGPU.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plan 003
- **Category**: correctness / tests / perf
- **Planned at**: commit `f21fcdf4`, 2026-08-30

## Why this matters

YAADE currently proves that WebGL and Canvas retain the same text and each draw
some non-background pixels. That does not prove equivalent terminal rendering.
Known differences already exist: WebGL flattens every underline style to one
straight rule, does not repaint the glyph inside a focused block cursor, and
does not share Canvas's fractional-DPR edge snapping. Complex TUIs amplify these
errors through box drawing, dense colors, alternate-screen scrolling, mouse
modes, rapid cursor movement, and resize redraws.

Canvas is the documented correctness oracle and Ghostty remains the terminal
state authority. This plan turns that statement into a deterministic semantic
and visual contract before deeper GPU/model optimizations land.

## Current state

- `renderer.ts::drawUnderline()` distinguishes single, double, curly, dotted,
  and dashed styles and redraws the cell glyph under a block cursor.
- `webgl2-renderer.ts` emits one 1 px rectangle whenever `cell.underline > 0`
  and draws a solid block cursor without an inverse glyph.
- Canvas snaps adjacent row edges using DPR; WebGL uses unsnapped CSS floats.
- `terminal-compatibility.web.spec.ts` checks retained text and only asserts that
  each backend has more than 100 pixels different from its own background. It
  never compares backend output.
- Plan 002 promised a broad differential corpus, but current tests cover only a
  small batch unit test and a semantic browser smoke test.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Core/renderer unit | `vp test packages/ghostty-core packages/ghostty-react` | all pass |
| Typecheck/lint | `vp run typecheck && vp run lint` | exit 0 |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts` | pass |
| Bench | `vp run test:bench` | no material regression |

## Scope

**In scope**

- Shared renderer semantics and deterministic fixture helpers under
  `packages/ghostty-react/src/renderers/`.
- Canvas and WebGL adapters.
- `packages/ghostty-react/src/renderer.ts` when the Canvas oracle needs an
  explicitly tested correction.
- Focused unit, browser visual, semantic E2E, and benchmark fixtures.
- Small checked-in reference images only for a designated browser/OS target.

**Out of scope**

- Replacing libghostty-vt, implementing bidi policy not provided by Ghostty,
  exact cross-OS font antialiasing, xterm.js, or accepting backend-specific
  semantic differences because screenshots are difficult.

## Steps

### Step 1: Define backend-neutral render semantics

Create a compact test contract for geometry and visual primitives: cell spans,
wide spacer tails, combining graphemes, foreground/background/inverse/faint,
selection, all six underline values, overline, strikethrough, invisible text,
wrapped rows, hover underline, focused/unfocused cursor shapes, cursor glyph
inversion, row clipping, padding, bottom anchoring, and DPR snapping.

Use the packed update/viewport model as input. Expected geometry must be numeric
and backend-neutral; do not derive expected WebGL batches from Canvas calls.

**Verify**: contract tests fail when underline style, cursor inversion, or row
edge semantics are deliberately collapsed.

### Step 2: Add a deterministic terminal-state corpus

Feed fixed ANSI transcripts through real `GhosttyTerminalCore` for:

- primary/alternate screen transitions and restoration;
- insert/delete character and line, erase variants, scroll regions, and wraps;
- 16/256/truecolor, inverse, faint, invisible, and every decoration;
- ASCII, box drawing, Nerd Font symbols, CJK wide cells, combining marks,
  ZWJ/emoji sequences, and mixed fallback fonts;
- OSC 8 links, cursor styles/visibility, DEC synchronized output, and resize;
- representative dashboard/editor layouts with status bars and split borders.

Store transcripts or fixture generators, not screenshots of third-party apps.
Assert semantic cells/rows/cursor before rendering.

**Verify**: the corpus reconstructs the same retained model from one full update
and equivalent partial updates.

### Step 3: Build same-machine differential capture

Render each corpus frame through Canvas and every available GPU backend at DPR
1, 1.25, 1.5, and 2. Compare dimensions and semantic geometry exactly. Compare
pixels with explicit per-channel/perceptual tolerances and masks limited to font
antialiasing edges; structural features such as underline count/shape, cursor,
cell backgrounds, and box boundaries may not be masked.

Use backend capture APIs/test hooks rather than `preserveDrawingBuffer` as a
permanent production requirement. Normalize WebGL's bottom-left pixel origin.

**Verify**: a test mutation that removes one underline, shifts one row by one
device pixel, or hides the cursor glyph fails the comparison.

### Step 4: Close the known WebGL parity gaps

Implement distinct double/curly/dotted/dashed decoration geometry, exact shared
row-edge snapping, and block-cursor glyph inversion. Share pure geometry helpers
where useful, but keep backend resource code separate. Ensure hover underline
does not overwrite an explicit underline style.

**Verify**: focused contract and differential tests pass for all styles, cursor
shapes, fractional DPRs, selection, and wide/combining cells.

### Step 5: Add PTY-driven complex-TUI behavior tests

Run Plan 007's deterministic dashboard through a real PTY. Exercise continuous
updates, resize, pane zoom, hidden/show, context/device loss, synchronized output,
and backend fallback. Assert final model, stable PTY, no incomplete frame after
a synchronized-output close, and screenshot parity at selected stable markers.

**Verify**: WebGL→Canvas fallback preserves the same stable marker frame and
dimensions.

### Step 6: Guard performance of correctness features

Record batch counts, draw calls, atlas uploads, CPU submission time, and
received→presented latency for the corpus. Decoration correctness must remain
batched; do not add one draw call per underline or cursor glyph.

**Verify**: three matched benchmark runs stay within existing budgets and the
full dashboard frame uses a bounded backend-documented draw-call count.

## Test plan

- Pure geometry tests for every primitive and DPR.
- Real-WASM semantic transcript tests.
- Same-machine Canvas/GPU differential browser tests with stable fonts.
- Real PTY E2E for resize, synchronized output, hidden/show, and fallback.
- Run semantic tests on all platforms; run strict pixel fixtures only on their
  designated environment and keep tolerant structural checks elsewhere.

## Done criteria

- [ ] Every documented cell style and cursor shape has a backend-neutral contract.
- [ ] Complex ANSI/TUI transcripts have semantic assertions before pixels.
- [ ] Canvas and GPU backends are compared directly at multiple DPRs.
- [ ] Underline styles, cursor inversion, and fractional row edges match.
- [ ] Context/device fallback preserves the same terminal frame and PTY.
- [ ] Correctness remains batched and benchmark budgets pass.

## STOP conditions

- The work requires reintroducing the removed WebGPU adapter.
- A proposed tolerance can hide missing decorations, shifted cells, or cursor errors.
- Correctness requires changing Ghostty parser semantics without a separate finding.
- Tests rely on an unpinned third-party TUI or network-installed font.
- A backend cannot expose deterministic capture in tests without forcing a slow
  production context option.

## Maintenance notes

Every new packed style bit or visual feature lands in this order: semantic
Ghostty/model fixture, backend-neutral geometry contract, Canvas oracle, GPU
parity, PTY E2E, then benchmark. A test that only proves “some pixels changed” is
a smoke test, not conformance.
