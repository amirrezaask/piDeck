# @yaade/ui — Design System

`@yaade/ui` contains the reusable visual primitives and terminal-multiplexer chrome. The browser app is the only consumer-facing surface.

## Public surface

- `@yaade/ui/primitives` — shared shadcn primitives.
- `@yaade/ui/session` — session, sidebar, pane, palette, and glass chrome.
- `@yaade/ui/terminal` — the Ghostty-backed terminal panel.
- `@yaade/ui/terminal-registry` — terminal focus and inspection helpers for the app/test bridge.
- `@yaade/ui/appearance` and `@yaade/ui/settings` — appearance and remote-host settings.
- `@yaade/ui/styles.css` — semantic tokens and global styles.

Apps import primitives through `@yaade/ui/primitives`; do not deep-import the implementation files.

## Design tokens

`YaadeTheme.tokens` is the authored color source. `applySemanticTokens()` publishes it before React mounts, and `globals.css` maps semantic properties through Tailwind. Do not author independent color palettes in components.

Use the existing semantic roles (`background`, `foreground`, `card`, `muted`, `accent`, `destructive`, `success`, `warning`, `info`, and sidebar roles). Never hardcode color values or arbitrary Tailwind colors.

Use the existing typography scale and `--font-sans` / `--font-mono`. Do not add arbitrary pixel font sizes.

## Motion and materials

Use `yaadeMotion` and the `--yaade-motion-*` / `--yaade-ease-*` tokens for transitions. Actions must take effect immediately; motion is visual feedback only. Honor `prefers-reduced-motion` and reduced-transparency fallbacks.

Keep the liquid materials centralized in primitives and global selectors. Do not stack translucent fills over the same content or add one-off surface abstractions.

## Terminal surfaces

The terminal panel owns PTY rendering, input, resize, replay, and terminal links. Keep PTY bytes out of React state. Stable terminal IDs must be used for registry and list keys. Agent CLIs run on the server as ordinary terminal processes and use this same surface; do not add provider-specific agent chat or process controls. Session, window, pane, and terminal chrome should remain terminal-only; do not reintroduce editor, Git, search, notification, or standalone agent surfaces.

## Rules

1. Import primitives through `@yaade/ui/primitives`.
2. Use semantic tokens, not hardcoded colors or durations.
3. Use `lucide-react` for icons.
4. Keep UI work accessible and keyboard-operable.
5. Verify visible changes with Playwright and scoped DOM assertions.
