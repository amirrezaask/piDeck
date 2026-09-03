# Plan 035: Centralize commands and ship a searchable command/session palette

> **Executor instructions**: This is shared client work. Preserve all pre-existing
> working-tree changes. Read
> `packages/yaade-ui/AGENTS.md` and use the `impeccable`, `react-patterns`, and
> `webapp-verification` workflows if available. Do not introduce banned direct
> shortcuts documented in `packages/yaade-app/src/keybindings.ts`; preserve
> terminal key passthrough. Every visible change requires Playwright evidence.
> Update this plan and `plans/README.md` to `DONE` after completion.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat a0bb3fc9..HEAD -- \
>   packages/yaade-app/src/{keybindings.ts,mux} \
>   packages/yaade-ui/src/components/palette \
>   packages/yaade-ui/src/components/WhichKeyPanel.tsx \
>   packages/yaade-ui/src/lister tests/web/e2e
> git diff --stat -- \
>   packages/yaade-app/src/{keybindings.ts,mux} \
>   packages/yaade-ui/src/components/palette \
>   packages/yaade-ui/src/components/WhichKeyPanel.tsx \
>   packages/yaade-ui/src/lister tests/web/e2e
> ```

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: product UX / architecture / accessibility
- **Planned at**: commit `a0bb3fc9`, 2026-08-30
- **Source finding**: Superlogical command discovery and filter-or-create parity

## Why this matters

YAADE has keyboard command IDs and a reusable `PaletteShell`, but command
metadata and execution live in a large component switch, most prefix tables are
empty, and there is no global action palette. The Session switcher is an
unfiltered popover; it cannot find a session across many hosts or create the
typed name. A typed command registry makes keyboard, menus, palette, which-key,
and future native menus consume one source of truth.

## Current state

- `packages/yaade-app/src/keybindings.ts` defines `MuxSessionCommand`, but
  `MUX_SESSION_PREFIX_BINDINGS` and groups are empty. The only direct bindings
  are split right/down, sidebar, and settings.
- `resolveMuxSessionKeydown` currently checks direct bindings only, despite the
  prefix state and comments.
- `TerminalMultiplexer.tsx::runMuxSessionCommand` is one switch containing
  command availability and side effects.
- `TerminalSwitcher.tsx` already uses `PaletteShell` and fuzzy values.
- `SessionSwitcher.tsx` uses a `Popover`, maps every session, and always shows a
  fixed **New session** footer. It computes `count` but does not render it.
- `keybindings.ts` explicitly says not to reintroduce direct `Mod-k`, prefix `p`,
  or `Mod-Shift-p`. Keep that decision unless a separate reviewed keymap change
  updates the catalog and tests.
- UI imports must use `@yaade/ui/primitives`/public entry points, semantic tokens,
  and reduced-motion behavior.

## Target design

A command descriptor contains a stable ID, title, category, search aliases,
icon key, availability/disabled reason, repeat policy, and optional binding ID.
It does **not** close over the whole application store. A scoped command runtime
maps IDs to handlers and current context. The registry feeds:

- global command palette;
- keyboard resolver and which-key HUD;
- context menus/tooltips;
- Tauri native menus in Plan 043;
- tests that prove every visible shortcut has one command.

Any new `@yaade/app` unit test file must also be listed in
`packages/yaade-app/package.json`, per repository convention.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Unit | `vp test packages/yaade-app packages/yaade-ui` | registry/keymap/lister tests pass |
| Type/lint | `vp run typecheck && vp run lint` | exit 0 |
| UI E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts tests/web/e2e/command-palette.web.spec.ts` | keyboard/palette/session cases pass |
| Visual runtime | headed focused Playwright run | desktop and mobile screenshots retained as evidence |

## Scope

**In scope**

- Typed command descriptors/runtime in `packages/yaade-app/src/`
- Keybinding resolver and which-key data generated from the registry/catalog
- Global command palette using `@yaade/ui` `PaletteShell`
- Searchable filter-or-create Session palette across hosts
- Unit and Playwright keyboard/accessibility/responsive tests

- Test manifests/scripts required by this plan, including
  `packages/yaade-app/package.json`

**Out of scope**

- User-editable keybindings or plugin commands
- A file/repository search palette
- Reintroducing shortcuts listed as removed in `keybindings.ts`
- Desktop-native menus; Plan 043 consumes this registry
- Terminal scrollback search; Plan 034

## Steps

### Step 1: Characterize command and keyboard behavior

Add tests that enumerate every `MuxSessionCommand`, current direct binding,
button/menu command invocation, and editable/terminal/overlay focus behavior.
Assert current prefix tables are empty and show that command metadata is split.
Record conflicts with browser and terminal chords.

**Verify**:

```bash
vp test packages/yaade-app
```

Expected: characterization passes and deliberate duplicate IDs/bindings fail in
focused self-tests.

### Step 2: Introduce a typed command registry and scoped runtime

Create small modules such as `commands/catalog.ts`, `commands/runtime.ts`, and
`commands/context.ts`. Keep descriptors static/serializable and handlers in the
runtime. Model availability as enabled or disabled-with-reason; absent commands
must not appear as mysteriously inert rows.

Migrate `runMuxSessionCommand` one category at a time while preserving existing
callbacks and Effect host errors. Avoid a global mutable singleton and avoid
passing dozens of boolean props to palette rows. Registry/context updates may
enter React state; PTY output may not.

**Verify**:

```bash
vp test packages/yaade-app
vp run typecheck
```

Expected: every command ID resolves exactly once, handlers receive minimal typed
context, and command behavior tests remain green.

### Step 3: Make the key catalog executable again

Implement the existing prefix state machine from the single catalog and add
reviewed prefix bindings for core navigation/actions. Choose an available action
key for opening the command palette; do not use the explicitly removed direct
or prefix keys. Preserve send-prefix literal behavior and terminal Kitty key-up
suppression.

Generate which-key groups, tooltip labels, and palette shortcut labels from the
same binding records. Add static tests for duplicate chords, unreachable
commands, risky bindings without reasons, and descriptor/binding drift.

**Verify**:

```bash
vp test packages/yaade-app packages/yaade-ui
```

Expected: prefix start/cancel/timeout/literal/command, editable fields, overlays,
key repeat, and terminal passthrough all pass.

### Step 4: Add the global command palette

Compose `PaletteShell` with grouped command rows, shortcut labels, disabled
reasons, and fuzzy aliases. Keep one quick input, deterministic ranking, and
clear empty text. Executing a command closes before focus-changing side effects;
a failed async command uses the existing action error surface.

Opening/closing must restore terminal focus and not send the palette key to the
PTY. Escape closes; arrow/Home/End/Enter use lister semantics. Reduced motion is
instant/interruptible as required by `PaletteShell`.

**Verify**:

```bash
vp exec playwright test --project=web-e2e tests/web/e2e/command-palette.web.spec.ts
```

Expected: mouse and keyboard can discover, filter, invoke, and reject disabled
commands without PTY input leakage.

### Step 5: Replace the Session popover with filter-or-create behavior

Use the same palette/lister infrastructure for sessions from all connected
hosts. Search title, host name, activity/status, and stable ID without exposing
credentials. Render real title, host, terminal count, and current marker. Keep
rename/close actions keyboard accessible without nested interactive roles.

When no exact session title matches a non-empty query, offer **Create “query”**
on the selected/current host; never create on Enter when an existing row is
highlighted. Empty query still exposes an explicit new-session action. Preserve
server-qualified routes and conflict handling.

**Verify**:

```bash
vp exec playwright test --project=web-e2e \
  tests/web/e2e/command-palette.web.spec.ts \
  tests/web/e2e/server-connections.web.spec.ts
```

Expected: large multi-host lists filter, exact selection routes correctly, and
filter-or-create creates exactly one named session on the chosen host.

### Step 6: Verify responsive, accessibility, and performance behavior

Test 1, 100, and 5,000 synthetic command/session rows with lister virtualization.
Assert no nested controls in `role=option`, accessible names/status, focus return,
row count/content/spacing/visibility, and mobile viewport/safe-area behavior.
Capture screenshots for empty, query, disabled, multi-host, and create states.

**Verify**:

```bash
vp run test:web
vp run typecheck
vp run lint
vp exec playwright test --project=web-e2e tests/web/e2e/command-palette.web.spec.ts
```

Expected: all commands pass; interaction remains responsive and visually verified.

## Test plan

- Registry: unique IDs, descriptor completeness, availability, runtime dispatch.
- Keymap: direct/prefix conflict, timeout, literal, repeat, overlay/editable/
  terminal focus, key-up suppression.
- Palette: fuzzy ranking, disabled reason, async error, focus restoration.
- Sessions: 0/1/100/5,000 rows, multi-host identity, filter, exact match, create,
  rename/close.
- Playwright: PTY output assertion after palette opens/closes; desktop/mobile and
  reduced motion.

## Done criteria

- [x] One typed registry supplies command metadata to keyboard, palette, HUD, and UI labels.
- [x] `TerminalMultiplexer` no longer owns a monolithic command switch.
- [x] Prefix behavior works without reintroducing documented removed shortcuts.
- [x] A searchable global command palette is keyboard and pointer accessible.
- [x] Session navigation filters across hosts and supports safe filter-or-create.
- [x] PTY input/output behavior is unchanged and verified with real output.
- [x] Unit, type, targeted lint, responsive, and Playwright visual/runtime gates pass.

## Implementation notes

- Static command descriptors now live in `commands/catalog.ts`; scoped handlers,
  availability, failure reporting, keyboard dispatch, which-key, pointer triggers,
  native-menu events, and the command palette use the same typed IDs.
- The Session surface is a fuzzy, host-aware filter-or-create palette with
  status/count metadata and external keyboard-accessible rename/close controls.
- Prefix tests cover realistic modifier keydown sequences. Desktop Playwright
  also proves a doubled prefix writes exactly one byte (`11`, `^K`) to a real
  PTY, while palette interaction does not leak input.
- Fuzzy filtering is covered at 1, 100, and 5,000 synthetic rows. Desktop and
  mobile palette flows are covered by `command-palette.web.spec.ts`.
- Verification completed with 164 app/UI unit tests, repository typecheck, and
  22 desktop/mobile Playwright cases. Targeted lint for the new command,
  keymap, palette, and E2E files passes. Repository-wide `vp run lint` remains
  blocked by pre-existing anti-slop diagnostics outside this plan's changes.

## STOP conditions

- A shortcut collides with a documented removed/browser-reserved/terminal chord
  without explicit catalog review.
- Command descriptors need live PTY bytes or terminal output in React state.
- Session creation cannot identify the target host unambiguously.
- The palette requires nested buttons inside options or loses keyboard focus.
- The change forks browser and Tauri command behavior.

## Maintenance notes

Add commands descriptor first, handler second, binding third, tests last. Native
menus, context menus, and automation should consume stable command IDs rather
than calling component internals. Keep user-editable keymaps as a separate
future plan with conflict migration semantics.
