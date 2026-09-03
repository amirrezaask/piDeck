# Plan 050: Make terminal switching MRU-first with truthful status previews

> **Executor instructions**: Complete Plan 035 first. Preserve working-tree
> changes and terminal focus/passthrough behavior. Read
> `packages/yaade-ui/AGENTS.md` before visible changes. Run each gate and STOP on
> drift or lifecycle ambiguity. Update this plan and `plans/README.md` when done.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 0739eacf..HEAD -- \
>   packages/yaade-app/src/{commands,mux} packages/yaade-ui/src/components/palette \
>   packages/yaade-rpc/src/mux-session.ts packages/yaade-shared/src \
>   tests/web/e2e
> git diff --stat -- \
>   packages/yaade-app/src/{commands,mux} packages/yaade-ui/src/components/palette \
>   packages/yaade-rpc/src/mux-session.ts packages/yaade-shared/src \
>   tests/web/e2e
> ```

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: Plan 035
- **Category**: terminal UX / navigation
- **Planned at**: commit `0739eacf`, 2026-08-31
- **Source finding**: heavy-terminal workflow review: frequent terminal switching requires search or spatial navigation

## Why this matters

With many Sessions, Windows, and panes, the terminal a user wants is usually one
of the last few they focused. MRU navigation makes the common switch immediate
while retaining search for larger jumps. Status previews should help choose the
right terminal without rendering transcript thumbnails or deriving state from
terminal content.

## Current state

- `packages/yaade-app/src/mux/TerminalSwitcher.tsx` already uses `PaletteShell`
  and searches terminal/session titles, but iterates map order rather than user
  focus history.
- Rows show current/kind only. `MuxTerminal` already carries typed
  `processState`, `activityState`, status, exit code, timestamps, and session ID.
- Terminal selection/routes are server-qualified in the shared app; MRU entries
  must not assume IDs are globally unique across hosts.
- Resident surfaces and route tests can prove navigation does not reattach PTYs.
- Plan 035 supplies stable `terminal.switch` and related command descriptors.
- Any new `@yaade/app` unit test file must be listed in
  `packages/yaade-app/package.json`, per repository convention.

## Target module and interface

Create a pure bounded `TerminalFocusHistory` module keyed by server identity,
Session ID, Window ID, terminal ID, and terminal generation. It exposes:

```ts
recordFocus(identity): void
previous(current, available): identity | null
rank(available): readonly identity[]
prune(available): void
```

It records only explicit successful user focus, never output activity. The
switcher consumes a derived ordered list: current/previous context, MRU, then
stable fallback order. Query ranking remains fuzzy and deterministic.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Unit | `vp test packages/yaade-app packages/yaade-ui` | MRU/ranking/palette/focus tests pass |
| Type/lint | `vp run typecheck && vp run lint` | exit 0 |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-mru-switching.web.spec.ts` | quick toggle/search/residency pass |
| Multi-host | `vp exec playwright test --project=web-e2e tests/web/e2e/server-connections.web.spec.ts` | qualified identity behavior passes |

## Scope

**In scope**

- Bounded client-local explicit focus history
- Immediate **Switch to previous terminal** command
- MRU-first terminal palette with typed process/activity status
- Pruning across close/archive/restart/generation/multi-host events
- Keyboard, pointer, mobile, accessibility, residency, and E2E tests

**Out of scope**

- Transcript/canvas thumbnails or terminal-content previews
- Server-side reordering based on one client's focus
- Treating output activity as focus or attention
- Automatic switching when a process exits/fails
- Cross-device MRU synchronization

## Steps

### Step 1: Define focus-history identity and ordering

Specify server-qualified identity and generation handling. Record only after a
route/selection is authoritative and its terminal surface has focused. Repeated
focus moves the entry to the front; current terminal is omitted from
`previous`; closed/archived/missing/generation-mismatched entries are pruned.
Cap history by count and encoded bytes.

Define stable fallback order: current Session/Window first, then server/session
position and terminal position. Never reorder while keyboard navigation is
actively moving through an open palette; apply new status/MRU order on next open.

**Verify**: `vp test packages/yaade-app` → deterministic table tests pass for
single/multi-host, close, archive, restart, generation, duplicate, and cap cases.

### Step 2: Add bounded client-local persistence

Persist identities only: no titles, CWD, command, output, or timestamps beyond
what ordering requires. Use versioned Effect Schema decoding and qualify by
stable host identity. Storage denial/corruption/newer version falls back to an
empty history. Prune against every authoritative snapshot before use.

Prefer session-local persistence if product review considers cross-reload focus
history surprising; whichever policy is selected must be explicit and tested.

**Verify**: unit tests cover reload, storage denial, corruption, host removal,
server epoch change with stable server identity, and bounded size.

### Step 3: Register immediate previous-terminal switching

Through Plan 035 add `terminal.switchPrevious`. Invoke `history.previous` and
route through the existing terminal-selection command; do not focus a surface
before the route/Window placement is ready. Repeated invocation toggles between
the two most recent valid terminals predictably.

The binding must not use browser/terminal-reserved chords without Plan 047 risk
validation. Button/palette invocation remains available without a shortcut.

**Verify**: app tests assert A→B→previous→A→previous→B, across Windows and
Sessions, with no stale closure or duplicate focus record.

### Step 4: Make TerminalSwitcher MRU-first

After Plan 035, adapt `TerminalSwitcher` to consume ranked entries rather than
build map-order rows itself. With an empty query, render **Recent** first and a
stable **Other terminals** group. With a query, fuzzy relevance leads and MRU is
only a tie-breaker. Keep the current terminal clearly marked.

Rows show runtime title, Session/Window, and a concise typed status derived from
`processState`/`activityState` such as running, waiting, failed, interrupted, or
exited. Use text plus semantic treatment, not color alone. Plan 036 attention may
later decorate these statuses but may not change MRU truth.

**Verify**: `vp test packages/yaade-app packages/yaade-ui` → grouping, search
tie-break, status labels, snapshot stability while open, and row accessibility
pass.

### Step 5: Verify responsive interaction and performance

Test 1, 100, and 5,000 synthetic terminals with bounded/virtualized rows from
`PaletteShell`. Opening, arrowing, selecting, and closing must restore terminal
focus and send no key to the PTY. Mobile rows must show enough host/session
identity to disambiguate without overflowing.

Capture desktop/mobile screenshots for no-recent, recent, query, failed,
interrupted, multi-host, and empty states.

**Verify**: headed Playwright plus `vp run test:web` → scoped DOM/content/count,
focus, responsiveness, and visual states pass.

### Step 6: Add real navigation/residency E2E

Create terminals across two Windows/Sessions and, where the fixture permits, two
hosts. Focus them in a known order, verify immediate previous toggling and MRU
palette order, close/archive/restart entries, and assert invalid entries vanish.
For every switch, compare PTY ID, surface instance ID, runtime generation,
renderer generation, and attach count; switching must not recreate or reattach a
resident terminal. Assert PTY output receives no switch chord.

**Verify**: run both E2E commands three times → all pass without arbitrary sleeps.

## Test plan

- Pure history: ordering, toggle, pruning, qualification, generations, bounds.
- Persistence: versions, corruption, denied storage, reload, host lifecycle.
- Palette: grouping, fuzzy tie-breaks, statuses, stable open order, large lists.
- E2E: cross-Window/Session/host navigation, zero PTY input, no reattach.

## Done criteria

- [x] Previous-terminal switching is one command and toggles predictably.
- [x] Empty-query switcher order is MRU-first; search remains relevance-first.
- [x] Statuses come only from typed terminal metadata, never transcript parsing.
- [x] History is bounded, server-qualified, client-local, and pruned authoritatively.
- [x] Navigation preserves resident PTY/runtime/surface identities.
- [x] Unit, type, targeted lint, visual, multi-host, and real-PTY E2E gates pass.

## Implementation notes

- `terminal-focus-history.ts` owns a versioned Effect Schema boundary and a
  session-local, content-free history capped at 128 identities and 32 KiB. An
  identity includes server, Session, Window, terminal, and process generation.
  Corrupt, denied, oversized, and newer-version storage falls back to an empty
  history. Pruning is authoritative for connected hosts while retaining
  configured hosts that are temporarily unavailable.
- `terminal-switcher-model.ts` derives stable fallback order, MRU sections,
  fuzzy-first query ranking, and metadata-only Running, Waiting, Failed,
  Interrupted, Exited, and Starting labels. `TerminalSwitcher` freezes its
  source order for each open, keeps the current terminal explicit, and includes
  host, Session, and Window context in desktop and mobile rows.
- `terminal.switchPrevious` is a registry command bound to `Leader b`. Every
  terminal selection still routes through the shared command/runtime seam. A
  pending explicit-focus token is committed only after the selected resident
  surface has been placed and focused; pointer and pane focus use the same
  history recorder.
- Resident terminal controllers now outlive Window navigation in one canonical
  host. `TerminalSurfacePlacement` moves the existing panel between desktop,
  mobile, and hidden homes, preserving the PTY, parser, surface instance,
  runtime generation, renderer generation, and attach count. Temporarily
  incomplete host metadata no longer evicts an admitted resident controller.
- Verification completed with 28 package unit files / 196 tests, repository
  typecheck, targeted type-aware lint for the Plan 050 modules, `test:web` (109
  tests), a headed desktop/mobile Playwright run, MRU E2E passing three
  consecutive runs (9/9), multi-host E2E passing three consecutive runs (3/3),
  and 37 command, keymap, scroll-lock, compatibility, and multiplexer
  regressions. Repository-wide `vp run lint` remains blocked by pre-existing
  anti-slop and exhaustive-deps diagnostics in unrelated and previously
  modified files.

## STOP conditions

- Stable server-qualified identity is unavailable after Plan 035.
- Focus can only be recorded before route/placement success.
- MRU would mutate server Session/Window/terminal positions.
- Status preview requires terminal text or a canvas thumbnail.
- Switching requires remount/reattach of resident terminals.

## Maintenance notes

MRU is navigation history, not activity or attention. Keep those modules
separate: Plan 036 may supply badges, but only successful explicit focus updates
this list.
