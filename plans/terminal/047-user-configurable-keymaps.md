# Plan 047: Add validated user-configurable keymaps and leader keys

> **Executor instructions**: Complete Plan 035 first. Preserve pre-existing
> working-tree changes and the documented terminal/browser reserved-key policy.
> Read `packages/yaade-ui/AGENTS.md` before Settings UI work. Follow every gate
> and STOP condition, then update this plan and `plans/README.md`.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 0739eacf..HEAD -- \
>   packages/yaade-app/src/{commands,keybindings.ts,hooks,mux} \
>   packages/yaade-ui/src/components/SettingsOverlay.tsx \
>   packages/yaade-ui/src/components/palette packages/yaade-workspace/src \
>   tests/web/e2e
> git diff --stat -- \
>   packages/yaade-app/src/{commands,keybindings.ts,hooks,mux} \
>   packages/yaade-ui/src/components/SettingsOverlay.tsx \
>   packages/yaade-ui/src/components/palette packages/yaade-workspace/src \
>   tests/web/e2e
> ```

## Status

- **Status**: DONE
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 035
- **Category**: terminal UX / customization
- **Planned at**: commit `0739eacf`, 2026-08-31
- **Source finding**: heavy-terminal workflow review: fixed chords cannot match established tmux/editor muscle memory

## Why this matters

Terminal users already have strong keyboard habits and often need to avoid
browser, OS, editor, or remote-TUI conflicts. Customization is useful only if it
remains deterministic: every command must resolve once, terminal-reserved keys
must pass through, and users must always have a recovery path after a bad edit.

## Current state

- `packages/yaade-app/src/keybindings.ts` is the only key-assignment catalog. It
  documents removed aliases and reserved terminal behavior.
- Prefix groups/bindings are currently empty, direct chords are static, and the
  prefix literal path sends the control-byte equivalent back to the PTY.
- Plan 035 introduces serializable command descriptors and one runtime consumed
  by keyboard, palette, HUD, menus, and tests. Overrides must compile into that
  registry rather than create another dispatcher.
- Appearance settings are schema-like values loaded and persisted by
  `packages/yaade-app/src/hooks/useAppearanceSettings.ts`; keyboard settings
  need their own module because they are platform/input policy, not appearance.
- Any new `@yaade/app` unit test file must be listed in
  `packages/yaade-app/package.json`, per repository convention.

## Target module and interface

Add a versioned `KeymapProfile` value and one compiler module:

```ts
type KeymapProfile = {
  readonly version: 1
  readonly leader: string
  readonly bindings: readonly KeymapOverride[]
}

compileKeymap(defaultCatalog, profile, platform):
  | { readonly ok: true; readonly keymap: EffectiveKeymap }
  | { readonly ok: false; readonly conflicts: readonly KeymapConflict[] }
```

The compiler owns normalization, platform aliases, contexts, duplicate and
prefix ambiguity detection, reserved/risky classifications, reachability, and
fallback. Keyboard dispatch consumes only `EffectiveKeymap`.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Unit | `vp test packages/yaade-workspace packages/yaade-app packages/yaade-ui` | compiler/settings/key dispatch pass |
| Type/lint | `vp run typecheck && vp run lint` | exit 0 |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/keymap-settings.web.spec.ts` | capture/conflict/recovery/PTTY cases pass |
| Visual | headed focused Playwright | desktop/mobile Settings evidence retained |

## Scope

**In scope**

- Versioned client-local keymap profile and pure validated compiler
- Configurable leader plus command/context overrides
- Settings list, key-capture control, conflict explanations, reset and defaults
- Runtime hot-swap, command labels/HUD/palette updates, import/export of data only
- Platform-aware unit and Playwright tests

**Out of scope**

- Server-synchronized keymaps or cloud profiles
- Executable macros, scripts, shell commands, or arbitrary JavaScript
- Rebinding text editing inside a terminal application
- Silently overriding browser/OS-reserved chords
- Provider-specific agent commands

## Steps

### Step 1: Freeze key grammar and risk policy

Document the normalized grammar for modifiers, key/code identity, leader
sequences, contexts, repeat, and platform aliases. Classify terminal-reserved,
widget-local, browser-risky, OS-unavailable, and safe chords. Preserve every
removed alias/reason from the existing catalog.

For version 1, restrict leader values to chords with a deterministic
send-prefix literal or require a separately reachable `terminal.sendPrefix`
command. Define Escape/recovery behavior before adding UI.

**Verify**: `vp test packages/yaade-workspace packages/yaade-app` → grammar,
normalization, platform, reserved, ambiguity, and literal tests pass.

### Step 2: Build the pure profile decoder and compiler

Use Effect Schema at the storage/import boundary. Reject unknown command IDs,
unknown contexts, duplicates, direct-vs-prefix ambiguity, unreachable palette
or reset actions, and profiles above strict binding/byte limits. Return typed
conflicts with actionable descriptions; do not partially apply an invalid
profile.

Defaults remain static and immutable. A missing/corrupt/newer profile falls back
to defaults and records a content-free diagnostic, never a startup failure.

**Verify**: `vp test packages/yaade-app` → property/table tests prove one command
per chord/context and deterministic fallback.

### Step 3: Add a narrow persistence hook

Create a keymap settings hook/module alongside, not inside, appearance settings.
Persist the bounded versioned profile client-locally. Qualify platform-specific
bindings, handle storage denial, and listen for same-origin storage changes
without replacing a newer in-memory edit.

Import/export accepts JSON data only, validates before preview/apply, and never
includes server identity, terminal content, credentials, or commands to execute.

**Verify**: `vp test packages/yaade-app` → absent, corrupt, oversized, newer
version, denied storage, import, export, and cross-tab tests pass.

### Step 4: Make every command consumer use the effective keymap

Wire Plan 035's keyboard resolver, shortcut labels, palette, which-key, tooltips,
and later native-menu descriptors to one effective keymap snapshot. Swap it
atomically only after successful compilation. A capture or Settings overlay
must suppress shell dispatch and PTY input until it closes.

**Verify**: `vp test packages/yaade-app packages/yaade-ui` → no consumer reads
the static default table directly except the compiler; hot-swap and focus tests
pass.

### Step 5: Add the Keyboard Settings experience

Add a **Keyboard** category to Settings. Show leader, searchable command rows,
default/effective binding, context, and conflict state. A capture control records
one chord/sequence, offers cancel/clear/reset, and explains risky or unavailable
bindings before an explicit second confirmation. Keep at least one pointer path
to reset defaults even if all shortcuts are invalid.

Use virtualized rows for the full catalog, semantic tokens, real key labels,
mobile-safe dialogs, and reduced-motion behavior. Do not place nested interactive
controls inside list options.

**Verify**: headed Playwright covers default, changed, conflict, risky confirm,
empty, imported, mobile, and reset states.

### Step 6: Prove terminal passthrough and recovery

In `keymap-settings.web.spec.ts`, remap leader and core actions, invoke them, and
assert PTY output receives neither capture nor command chords. Verify send-prefix
emits the expected control byte once. Test a conflict rejection, corrupt stored
profile, browser reload, multi-tab update, and pointer reset.

**Verify**: run the E2E command three times → all pass without sleeps.

## Test plan

- Compiler: uniqueness, contexts, prefixes, platform aliases, risk, reachability.
- Persistence: versions, corruption, bounds, denied storage, cross-tab ordering.
- UI: capture, conflict, reset, keyboard/pointer/mobile/accessibility.
- E2E: command invocation, PTY non-leak, send-prefix exactness, reload recovery.

## Done criteria

- [x] One effective keymap feeds every command/label/HUD consumer.
- [x] Invalid profiles are rejected atomically with a guaranteed reset path.
- [x] Terminal/browser/OS conflicts are classified and never silently stolen.
- [x] Leader literal behavior remains exact.
- [x] Profiles contain data only and remain bounded/client-local.
- [x] Unit, type, targeted lint, visual, and real-PTY E2E gates pass.

## Implementation notes

- `keymap-profile.ts` defines the v1 grammar, Effect Schema boundary, platform
  aliases, risk classes, strict 32 KiB/128-binding limits, normalization,
  conflict detection, required recovery commands, and immutable compilation.
  Missing, corrupt, oversized, newer, or conflicting profiles fall back as one
  value and expose only a content-free diagnostic.
- `keymap-storage.ts` and `useKeymapSettings.ts` persist revisioned data-only
  profiles, reject stale same-origin updates, handle denied storage, validate
  imports before apply, and install one global compiled snapshot. Dispatch,
  which-key, palettes, tooltips, Settings labels, and native-menu command
  execution resolve through that snapshot rather than a second dispatcher.
- Keyboard Settings provides platform-aware capture, default/effective/context
  labels, virtualized search results, actionable conflicts, explicit risky-chord
  confirmation, restore/clear/reset, and JSON import/export. `Mod-,` remains an
  immutable recovery chord, pointer reset remains available, and
  `keymap.reset` (`Leader Shift-R`) is a registry-backed global recovery action.
- The active leader owns exact control-byte passthrough: pressing it twice from
  a terminal sends one byte through the host terminal port. Capture and command
  sequences are suppressed while Settings or command overlays own input, and
  PTY output never enters React state or DOM.
- Verification completed with 27 package unit files / 195 tests, repository
  typecheck, targeted type-aware lint, a headed desktop/mobile Playwright run,
  3 keymap cases passing three consecutive runs (9/9), and the existing 22
  command-palette/terminal-multiplexer cases. Repository-wide `vp run lint`
  remains blocked by pre-existing anti-slop and exhaustive-deps diagnostics in
  unrelated and previously modified files.

## STOP conditions

- Plan 035 leaves multiple command dispatchers or unstable command IDs.
- A configured chord cannot be classified before interception.
- Recovery would require manually deleting browser storage.
- Import needs code evaluation or executable macro support.
- The capture control leaks keys into the PTY.

## Maintenance notes

New commands declare defaults and risk metadata in Plan 035's registry; the
compiler derives effective bindings. Never add a shortcut directly to a button,
component effect, or native menu.
