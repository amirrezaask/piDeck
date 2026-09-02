export const DEFAULT_UI_FONT_FAMILY =
  '"Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif'

/** Bundled default monospace face (also listed in the settings picker). */
export const DEFAULT_MONO_FONT_NAME = "Geist Mono Variable"

/**
 * Bundled symbols-only Nerd Font. Used as a fallback so PUA/icon glyphs
 * (starship, p10k, eza, neovim) render without a patched coding font.
 */
export const NERD_FONT_FAMILY = "Symbols Nerd Font Mono"

const NERD_FONT_STACK_ITEM = `"${NERD_FONT_FAMILY}"`

/** A PUA glyph this face actually contains. */
const NERD_FONT_PROBE = "\uE725"

const GENERIC_MONO_TAIL =
  /,?\s*(?:ui-monospace|monospace)(?:\s*,\s*(?:ui-monospace|monospace))*\s*$/i

/** Generic CSS fallbacks always appended after the chosen face. */
export const MONO_FONT_FALLBACKS = `${NERD_FONT_STACK_ITEM}, ui-monospace, monospace`

export const DEFAULT_MONO_FONT_FAMILY = `"${DEFAULT_MONO_FONT_NAME}", ${MONO_FONT_FALLBACKS}`

function stackHasNerdFont(stack: string): boolean {
  return stack.includes(NERD_FONT_FAMILY)
}

/** Put Symbols Nerd Font Mono before generic families so PUA icons don't tofu. */
export function withNerdFontFallback(stack: string): string {
  const trimmed = stack.trim()
  if (!trimmed) return DEFAULT_MONO_FONT_FAMILY
  if (stackHasNerdFont(trimmed)) return trimmed
  if (GENERIC_MONO_TAIL.test(trimmed)) {
    return trimmed.replace(GENERIC_MONO_TAIL, `, ${MONO_FONT_FALLBACKS}`)
  }
  return `${trimmed}, ${MONO_FONT_FALLBACKS}`
}

/**
 * Build a CSS `font-family` stack from a primary face name.
 * If `family` already looks like a stack (contains a comma), Nerd Font
 * fallback is still inserted before generic families.
 */
export function buildMonoFontStack(family: string): string {
  const trimmed = family.trim()
  if (!trimmed) return DEFAULT_MONO_FONT_FAMILY
  if (trimmed.includes(",")) return withNerdFontFallback(trimmed)
  const quoted =
    trimmed.startsWith('"') || trimmed.startsWith("'")
      ? trimmed
      : `"${trimmed.replaceAll('"', '\\"')}"`
  return withNerdFontFallback(quoted)
}

/** Kick off the symbols webfont so the terminal canvas isn't measured against tofu. */
export function preloadNerdFont(): void {
  if (typeof document === "undefined" || !document.fonts?.load) return
  void document.fonts
    .load(`16px ${NERD_FONT_STACK_ITEM}`, NERD_FONT_PROBE)
    .catch(() => {})
}

/**
 * Common monospace faces checked when Local Font Access is unavailable
 * or returns an empty set. Only faces the browser can resolve are shown.
 */
export const CURATED_MONO_FONT_NAMES: readonly string[] = [
  DEFAULT_MONO_FONT_NAME,
  "SF Mono",
  "Menlo",
  "Monaco",
  "Cascadia Code",
  "Cascadia Mono",
  "Consolas",
  "Courier New",
  "DejaVu Sans Mono",
  "Fira Code",
  "Fira Mono",
  "Hack",
  "IBM Plex Mono",
  "Inconsolata",
  "JetBrains Mono",
  "Lucida Console",
  "Source Code Pro",
  "Ubuntu Mono",
]
