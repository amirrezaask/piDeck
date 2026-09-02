import {
  CURATED_MONO_FONT_NAMES,
  DEFAULT_MONO_FONT_NAME,
} from "./appearance-defaults.js"

type LocalFontData = {
  family: string
  fullName?: string
  postscriptName?: string
  style?: string
}

type QueryLocalFonts = (options?: {
  postscriptNames?: string[]
}) => Promise<LocalFontData[]>

function queryLocalFontsFn(): QueryLocalFonts | null {
  const fn = (
    window as Window & {
      queryLocalFonts?: QueryLocalFonts
    }
  ).queryLocalFonts
  return typeof fn === "function" ? fn.bind(window) : null
}

/** True when `i` and `M` share advance width under `family` (monospace). */
export function isMonospaceFontFamily(family: string): boolean {
  if (typeof document === "undefined") return false
  const canvas = document.createElement("canvas")
  const ctx = canvas.getContext("2d")
  if (!ctx) return false
  const face = family.includes(",")
    ? family
    : `"${family.replaceAll('"', '\\"')}"`
  ctx.font = `32px ${face}`
  const narrow = ctx.measureText("iiii").width
  const wide = ctx.measureText("MMMM").width
  if (!(narrow > 0) || !(wide > 0)) return false
  return Math.abs(narrow - wide) < 0.75
}

function fontAvailable(family: string): boolean {
  if (typeof document === "undefined") return false
  try {
    if (document.fonts?.check(`12px "${family.replaceAll('"', '\\"')}"`)) {
      return true
    }
  } catch {
    /* ignore */
  }
  // Bundled @fontsource face may not report via check until used — keep default.
  if (family === DEFAULT_MONO_FONT_NAME) return true
  return isMonospaceFontFamily(family)
}

async function familiesFromLocalFonts(): Promise<string[] | null> {
  const query = queryLocalFontsFn()
  if (!query) return null
  try {
    const fonts = await query()
    const families = new Set<string>()
    for (const font of fonts) {
      const family = font.family?.trim()
      if (!family || families.has(family)) continue
      if (isMonospaceFontFamily(family)) families.add(family)
    }
    return [...families]
  } catch {
    // Permission denied / unsupported — caller falls back to curated list.
    return null
  }
}

function familiesFromCurated(): string[] {
  return CURATED_MONO_FONT_NAMES.filter(fontAvailable)
}

/**
 * System monospace faces for the appearance picker.
 * Prefers Local Font Access (`queryLocalFonts`); otherwise curated + available.
 * Always includes the bundled Geist Mono default.
 */
export async function listSystemMonoFonts(): Promise<string[]> {
  const fromLocal = await familiesFromLocalFonts()
  const families = new Set<string>(
    fromLocal && fromLocal.length > 0 ? fromLocal : familiesFromCurated(),
  )
  families.add(DEFAULT_MONO_FONT_NAME)
  return [...families].sort((a, b) => a.localeCompare(b))
}
