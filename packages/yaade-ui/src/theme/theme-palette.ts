import type {
  YaadeHighlightColors,
  YaadeTerminalAnsiColors,
  YaadeTerminalColors,
  YaadeSemanticTokens,
  YaadeTheme,
} from "@yaade/shared"
import { yaadeColorsFromTokens } from "@yaade/shared"
import { toSrgbColor } from "@yaade/shared"

export type ColorScheme = "dark" | "light"

type ThemeFamily = "Default"

export type PaletteThemeInput = {
  id: string
  name: string
  family: ThemeFamily
  scheme: ColorScheme
  sourceName?: string
  sourceUrl?: string
  license?: string
  tokens: YaadeSemanticTokens
  highlights: YaadeHighlightColors
  terminalAnsi: YaadeTerminalAnsiColors
  terminal?: YaadeTerminalColors
}

function swatches(theme: Pick<PaletteThemeInput, "tokens" | "highlights" | "terminalAnsi">): string[] {
  return [
    theme.tokens.background,
    theme.tokens.card,
    theme.tokens.foreground,
    theme.tokens.primary,
    theme.highlights.keyword,
    theme.highlights.function,
    theme.highlights.string,
    theme.terminalAnsi.yellow,
    theme.terminalAnsi.cyan,
    theme.tokens.destructive,
  ]
}

export function makeTheme(input: PaletteThemeInput): YaadeTheme {
  return {
    ...input,
    highlights: mapCompatibilityColors(input.highlights),
    terminalAnsi: mapCompatibilityColors(input.terminalAnsi),
    colors: yaadeColorsFromTokens(input.tokens),
    previewSwatches: swatches(input),
  }
}

function mapCompatibilityColors<T extends { [K in keyof T]: string }>(colors: T): T {
  return Object.fromEntries(
    Object.entries(colors as Record<string, string>).map(([key, value]) => [
      key,
      toSrgbColor(value),
    ]),
  ) as T
}

export function paletteHighlights(input: {
  keyword: string
  controlKeyword?: string
  function: string
  type: string
  string: string
  number: string
  boolean?: string
  comment: string
  operator: string
  variable: string
  attribute?: string
  constant?: string
  field?: string
  module?: string
  label?: string
}): YaadeHighlightColors {
  return {
    keyword: input.keyword,
    controlKeyword: input.controlKeyword ?? input.keyword,
    function: input.function,
    type: input.type,
    string: input.string,
    number: input.number,
    boolean: input.boolean ?? input.number,
    comment: input.comment,
    operator: input.operator,
    variable: input.variable,
    attribute: input.attribute ?? input.function,
    constant: input.constant ?? input.type,
    field: input.field ?? input.type,
    module: input.module ?? input.type,
    label: input.label ?? input.keyword,
  }
}

export function paletteAnsi(input: {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}): YaadeTerminalAnsiColors {
  return {
    ...input,
    brightBlack: input.brightBlack ?? input.black,
    brightRed: input.brightRed ?? input.red,
    brightGreen: input.brightGreen ?? input.green,
    brightYellow: input.brightYellow ?? input.yellow,
    brightBlue: input.brightBlue ?? input.blue,
    brightMagenta: input.brightMagenta ?? input.magenta,
    brightCyan: input.brightCyan ?? input.cyan,
    brightWhite: input.brightWhite ?? input.white,
  }
}
