import type { YaadeTheme } from "@yaade/shared"
import {
  shadcnDefaultDark,
  shadcnDefaultLight,
} from "@yaade/shared"
import {
  makeTheme,
  paletteAnsi,
  paletteHighlights,
} from "./theme-palette.js"

const designSource = "https://developer.apple.com/videos/play/wwdc2025/219/"

// Syntax + ANSI stay vivid against the frost chrome — cool-blue primary
// family, kept off the glass film so code doesn't inherit material tint.
const darkHighlights = paletteHighlights({
  keyword: "oklch(0.72 0.17 25)",
  controlKeyword: "oklch(0.72 0.17 25)",
  function: "oklch(0.76 0.16 305)",
  type: "oklch(0.72 0.16 255)",
  string: "oklch(0.72 0.13 162)",
  number: "oklch(0.8 0.14 84)",
  boolean: "oklch(0.8 0.14 84)",
  comment: "oklch(0.62 0.016 250)",
  operator: "oklch(0.92 0.01 250)",
  variable: "oklch(0.92 0.01 250)",
  attribute: "oklch(0.76 0.16 305)",
  constant: "oklch(0.72 0.16 255)",
  field: "oklch(0.72 0.16 255)",
  module: "oklch(0.72 0.16 255)",
  label: "oklch(0.72 0.17 25)",
})

const lightHighlights = paletteHighlights({
  keyword: "oklch(0.55 0.2 27)",
  controlKeyword: "oklch(0.55 0.2 27)",
  function: "oklch(0.5 0.22 302)",
  type: "oklch(0.48 0.2 264)",
  string: "oklch(0.5 0.13 150)",
  number: "oklch(0.62 0.15 58)",
  boolean: "oklch(0.62 0.15 58)",
  comment: "oklch(0.55 0.01 286)",
  operator: "oklch(0.27 0.006 286)",
  variable: "oklch(0.27 0.006 286)",
  attribute: "oklch(0.5 0.22 302)",
  constant: "oklch(0.48 0.2 264)",
  field: "oklch(0.48 0.2 264)",
  module: "oklch(0.48 0.2 264)",
  label: "oklch(0.55 0.2 27)",
})

const darkAnsi = paletteAnsi({
  black: "oklch(0.125 0.012 248)",
  red: "oklch(0.72 0.17 25)",
  green: "oklch(0.72 0.13 162)",
  yellow: "oklch(0.8 0.14 84)",
  blue: "oklch(0.72 0.16 255)",
  magenta: "oklch(0.76 0.16 305)",
  cyan: "oklch(0.72 0.1 200)",
  white: "oklch(0.93 0.008 250)",
  brightBlack: "oklch(0.62 0.016 250)",
  brightRed: "oklch(0.76 0.17 25)",
  brightGreen: "oklch(0.78 0.13 162)",
  brightYellow: "oklch(0.84 0.14 84)",
  brightBlue: "oklch(0.76 0.16 255)",
  brightMagenta: "oklch(0.8 0.16 305)",
  brightCyan: "oklch(0.78 0.1 200)",
  brightWhite: "oklch(0.99 0 255)",
})

const lightAnsi = paletteAnsi({
  black: "oklch(0.27 0.006 286)",
  red: "oklch(0.55 0.2 27)",
  green: "oklch(0.5 0.13 150)",
  yellow: "oklch(0.62 0.15 58)",
  blue: "oklch(0.48 0.2 264)",
  magenta: "oklch(0.5 0.22 302)",
  cyan: "oklch(0.5 0.1 200)",
  white: "oklch(0.975 0.002 264)",
  brightBlack: "oklch(0.5 0.015 286)",
  brightRed: "oklch(0.58 0.2 27)",
  brightGreen: "oklch(0.55 0.13 150)",
  brightYellow: "oklch(0.68 0.15 58)",
  brightBlue: "oklch(0.52 0.2 264)",
  brightMagenta: "oklch(0.55 0.22 302)",
  brightCyan: "oklch(0.55 0.1 200)",
  brightWhite: "oklch(1 0 264)",
})

export const defaultDark: YaadeTheme = makeTheme({
  id: "default-dark",
  name: "Default Dark",
  family: "Default",
  scheme: "dark",
  sourceName: "YAADE Liquid Glass (dark)",
  sourceUrl: designSource,
  license: "MIT",
  tokens: shadcnDefaultDark,
  highlights: darkHighlights,
  terminalAnsi: darkAnsi,
})

export const defaultLight: YaadeTheme = makeTheme({
  id: "default-light",
  name: "Default Light",
  family: "Default",
  scheme: "light",
  sourceName: "YAADE Liquid Glass (Apple materials–inspired)",
  sourceUrl: designSource,
  license: "MIT",
  tokens: shadcnDefaultLight,
  highlights: lightHighlights,
  terminalAnsi: lightAnsi,
})

export const shadcnThemes = {
  [defaultDark.id]: defaultDark,
  [defaultLight.id]: defaultLight,
}

export const shadcnThemeList = [defaultDark, defaultLight]
