# Plan 034: Deliver current-screen-first reattach with progressive million-line scrollback and search

> **Executor instructions**: Complete Plans 018, 023, 027, and 033. Preserve all
> pre-existing working-tree changes. Plan 024 must
> have reached a documented Outcome A, B, or C; this plan must work with that
> decision and may not invent private Ghostty restore. Keep PTY output out of
> React state. Build an indexed cold-row provider behind the terminal surface,
> not a standalone search application. Update this plan and its README row to
> `DONE` when every quality gate passes.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat a0bb3fc9..HEAD -- \
>   apps/server/src/{terminal,terminal_history,runtime}.rs \
>   crates/ghostty-vt packages/ghostty-core/src packages/ghostty-react/src \
>   packages/yaade-rpc/src packages/yaade-host-client/src \
>   packages/yaade-ui/src/panels packages/yaade-app/src/mux \
>   tests/{bench,runtime,web/e2e,web/durability}
> git diff --stat -- \
>   apps/server/src/{terminal,terminal_history,runtime}.rs \
>   crates/ghostty-vt packages/ghostty-core/src packages/ghostty-react/src \
>   packages/yaade-rpc/src packages/yaade-host-client/src \
>   packages/yaade-ui/src/panels packages/yaade-app/src/mux \
>   tests/{bench,runtime,web/e2e,web/durability}
> ```

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 018, 023, 024 (decision), 027, and 033
- **Category**: terminal UX / performance / history
- **Planned at**: commit `a0bb3fc9`, 2026-08-30
- **Source finding**: Superlogical current-screen-first and million-line history parity

## Why this matters

The browser currently requests `replay: "full"` and streams archive pages from
sequence zero before it reaches the newest state. Large history can therefore
delay a trustworthy interactive screen even though the host already has a
semantic current snapshot. Browser Ghostty is also configured with
`MAX_SCROLLBACK_ROWS = 10_000`, far below the reference's million-line quality
case, and there is no terminal search UI.

The target is a hot exact terminal plus a cold indexed row store: show the newest
screen first, keep parsing/interaction ordered, and fetch/search old rows on
demand without loading them all into browser memory.

## Current state

- `TerminalPanel.tsx::attachToNewSurface` calls `terminalApi.attach(id, {
  replay: "full" })`.
- `create-yaade-api.ts::streamArchivedReplay` requests 256 KiB pages in a loop
  and yields between pages, but still starts from the oldest requested sequence.
- `packages/ghostty-core/src/core.ts` hard-codes
  `MAX_SCROLLBACK_ROWS = 10_000` when creating Ghostty.
- `GhosttyViewportModel` retains only the active viewport; it has no asynchronous
  cold-row provider.
- Plan 018 supplies exact indexed binary history. Plan 023 supplies one native
  Ghostty semantic owner. Plan 033 supplies current snapshot/patch/hash.
- Plan 024 decides whether raw parser restore is possible. Outcome C does not
  permit faking parser continuation from painted rows.

## Target architecture

```text
attach
  -> semantic current snapshot (first trustworthy paint)
  -> raw parser restore/replay in worker according to Plan 024
  -> buffer ordered live bytes behind parser fence
  -> compare canonical state hash
  -> atomic semantic-preview -> raw-live handoff

native Ghostty owner
  -> hot screen + bounded hot scrollback
  -> stable scrolled-row events
       -> append-only cold row blocks + line/search index

terminal surface viewport
  -> hot Ghostty rows around bottom
  -> async cold row pages above hot boundary
  -> virtual scrollbar with stable row IDs
  -> terminal-local search results and reveal
```

If Plan 024 Outcome C cannot meet an approved interactive handoff, keep semantic
preview visible and mark raw input unavailable until exact catch-up. Do not allow
keystrokes encoded from stale modes.

Any new `@yaade/app` unit test file must also be listed in
`packages/yaade-app/package.json`, per repository convention.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| History/server | `vp run test:server && vp run test:terminal:integration` | cold row/index tests pass |
| Terminal units | `vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui` | viewport/search tests pass |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts tests/web/durability/terminal-history.web.spec.ts` | reattach, scroll, search pass |
| Bench | `vp run test:bench` | first-screen, search, scroll, memory gates pass |

## Scope

**In scope**

- Native stable-row extraction and indexed cold-row history
- Typed paged row/search RPC and browser transport
- Terminal-surface virtualization, search overlay, result navigation/highlight
- Current-screen semantic preview and exact raw handoff
- Retention, corruption, resize/wrap, Unicode, and performance tests

- Test manifests/scripts required by this plan, including
  `packages/yaade-app/package.json`

**Out of scope**

- A general repository search surface
- Loading one million rows into React, DOM, or one Ghostty allocation
- Private Ghostty parser-state import
- Server-side shell command history semantics
- Regex features without explicit execution/complexity bounds

## Steps

### Step 1: Set measurable attach, scroll, search, and memory gates

Extend Plan 027's release benchmark with fixed 10k, 100k, and 1M logical-line
corpora: ASCII logs, ANSI rewrites, Unicode/wide/wrapped rows, and long lines.
Measure first trustworthy current screen, time until input is safe, old-row page
fetch/reveal, literal search first/all results, scroll frame p95/p99, browser/host
peak and steady memory, bytes transferred, and event-loop delay.

Use the stricter supplied reference ceilings as release targets. If a target is
not numerically specified, record a baseline and obtain an approved ceiling
before implementation; do not tune a threshold after seeing final results.

**Verify**:

```bash
vp run test:bench
```

Expected: the baseline artifact identifies current full-replay delay and 10,000
row cap; each metric has a semantic completion fence.

### Step 2: Persist stable semantic rows beside raw history

After Plan 023's native owner processes output, drain rows that have become
stable and left the bounded hot region. Persist append-only row blocks with
terminal epoch, monotonic row ID, logical/wrap relationship, text/graphemes,
styles/hyperlinks needed for display, source output sequence range, checksum,
and format version. Reuse Plan 018's owner, byte budgets, atomic publication,
retention, and shutdown barriers; do not create another unbounded writer thread.

Define resize/reflow policy explicitly. A row ID must not silently point to
different text after resize. Prefer immutable historical rows plus viewport-time
wrapping metadata over rewriting one million rows.

**Verify**:

```bash
vp run test:server
```

Expected: exact row order and source fences survive restart, rotation,
compression, Unicode, wrap, alternate screen, and corruption fixtures.

### Step 3: Add bounded row-range and search contracts

Define Effect Schema routes for row summary, range page, and search. Every query
must bind terminal ID/epoch, snapshot/index generation, direction, cursor, and
strict row/byte/result limits. Search literal text first; if regex is later
included, use a linear-time engine and input/time limits.

Build a compact normalized text index per cold block. Preserve original display
text separately; case-folding/index normalization must not alter returned
content. Incremental updates and retention deletion must atomically update the
index. No terminal content enters logs, metrics, audit events, or error strings.

**Verify**:

```bash
vp run test:terminal:protocol
vp run test:server
```

Expected: malformed cursors/epochs/bounds fail, first/next/previous search is
stable, and retained-row deletion cannot return stale hits.

### Step 4: Show current semantic screen before cold replay

On attach request `both` when supported. Paint Plan 033's current snapshot after
one hash-validated decode. In parallel, restore/catch up the raw browser parser
according to Plan 024, buffering live output with existing sequence/ACK bounds.
Swap to the raw surface only when terminal epoch, dimensions, sequence fence, and
canonical semantic hash match.

Input remains disabled or server-encoded until the parser has current modes. The
preview must visibly indicate reconnect only if interaction is unavailable; it
must not flash blank or replay old output over the newest frame.

**Verify**:

```bash
vp exec playwright test --project=web-e2e tests/web/durability/terminal-history.web.spec.ts
```

Expected: a 1M-line terminal displays the newest marker before old pages load,
then accepts input exactly once after a proven-safe handoff.

### Step 5: Add a cold-row provider to the terminal surface

Create an asynchronous row-provider seam below React. Compose cold pages above
hot Ghostty rows with stable row IDs and a virtual scrollbar whose total remains
consistent as output arrives or retention trims. Keep only a bounded page window
and prefetch margin; cancel stale requests on jump/search/epoch change.

Selection/copy can cross loaded page boundaries by fetching bounded adjacent
pages. Mouse reporting remains tied to the active screen, not cold history.
Scroll-to-bottom returns to live Ghostty instantly. Hidden terminals may not
prefetch indefinitely.

**Verify**:

```bash
vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui
```

Expected: page cache bounds, cancellation, stable anchor under new output,
selection, resize, and hot/cold boundary tests pass.

### Step 6: Add integrated terminal search

Register a terminal-local **Find in terminal** command through Plan 035. Use an
accessible compact overlay with literal query, case toggle, result count, and
next/previous controls. Searching never changes PTY focus/modes until the overlay
closes. Reveal loads the target page, anchors the row, and highlights matching
cell ranges through shared renderer overlays.

On mobile use the existing Drawer/compact overlay conventions and keep touch
targets at least the design-system minimum. Announce result count and current
result to assistive technology without reading the whole buffer.

**Verify**:

```bash
vp run test:web
vp exec playwright test --project=web-e2e tests/web/durability/terminal-history.web.spec.ts
```

Expected: keyboard and mobile tests find real old content, navigate results,
copy it, return live, and preserve PTY output/input.

### Step 7: Enforce million-line quality and degradation behavior

Run release benchmarks with throttled network/disk and six live terminals. Prove
bounded memory/cache, progressive page requests, stable scroll, current-screen
first paint, and useful errors for missing/corrupt/retention-trimmed history.
Document retention and privacy implications.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:terminal:integration
vp run test:web
vp run test:bench
vp exec playwright test --project=web-e2e tests/web/durability/terminal-history.web.spec.ts
```

Expected: all functional gates and predeclared performance/memory ceilings pass.

## Test plan

- Native row extraction: wrapping, resize, alternate screen, styles, links,
  malformed UTF-8, output sequence fences.
- Storage/index: rotation, crash, corruption, retention, restart, Unicode search.
- Transport: page/result bounds, epoch/index changes, cancellation, authorization.
- Surface: hot/cold anchor, cache eviction, cross-page selection, live arrival.
- E2E: 1M lines, current marker first, safe input handoff, find/reveal/mobile.
- Bench: first trustworthy paint, input-ready, scroll p95/p99, search, memory.

## Done criteria

- [ ] A large reattach paints the newest exact screen before cold history loads.
- [ ] Input is enabled only after current mode/state is proven safe.
- [ ] One million logical lines are navigable with bounded browser/host memory.
- [ ] Cold rows are paged/indexed and never held in React state.
- [ ] Terminal-local find navigates old results and highlights exact cells.
- [ ] Retention/corruption/degraded history is explicit and does not fake exactness.
- [ ] Functional, accessibility, durability, and predeclared performance gates pass.

## STOP conditions

- The design requires one million rows in Ghostty, DOM, or React state.
- A semantic preview is treated as parser restore or enables stale-mode input.
- Stable row extraction requires private Ghostty memory.
- Resize changes the content behind an existing row ID.
- Search logs/index diagnostics can expose terminal content.
- Bench thresholds are loosened after implementation.

## Maintenance notes

Raw history is the byte-exact replay source; semantic cold rows are the indexed
human viewport. Keep source sequence fences between them so corruption can be
detected. Recalibrate only when corpus, browser, renderer, hardware class, or
retention policy changes, and record why.
