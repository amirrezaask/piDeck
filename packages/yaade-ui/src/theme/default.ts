import type { YaadeTheme } from "@yaade/shared"
import type { ColorScheme } from "./theme-palette.js"
import {
  defaultDark,
  defaultLight,
  shadcnThemeList,
  shadcnThemes,
} from "./shadcn.js"

export type { ColorScheme } from "./theme-palette.js"
export { defaultDark, defaultLight } from "./shadcn.js"

export const defaultThemeId = defaultDark.id

export const bundledThemes = shadcnThemes satisfies Record<string, YaadeTheme>

export const bundledThemeList: YaadeTheme[] = shadcnThemeList

export function getThemeById(id: string | null | undefined): YaadeTheme {
  if (!id) return defaultDark
  return bundledThemes[id] ?? defaultDark
}

export function themePreviewSwatches(theme: YaadeTheme): string[] {
  return theme.previewSwatches?.length
    ? theme.previewSwatches
    : [theme.colors.bg, theme.colors.panel, theme.colors.text, theme.colors.accent]
}

export function defaultThemeIdForScheme(scheme: ColorScheme): string {
  return scheme === "light" ? defaultLight.id : defaultDark.id
}

export function themeForScheme(scheme: ColorScheme): YaadeTheme {
  return getThemeById(defaultThemeIdForScheme(scheme))
}

export function themeFamilyForId(id: string | null | undefined): string {
  return getThemeById(id).family ?? "Default"
}

/** Flip between dark/light siblings within the same theme family. */
export function siblingThemeForScheme(id: string, scheme: ColorScheme): YaadeTheme {
  const current = getThemeById(id)
  const family = current.family ?? "Default"
  const siblings = bundledThemeList.filter(t => (t.family ?? "Default") === family)
  const match = siblings.find(t => (t.scheme ?? "dark") === scheme)
  return match ?? current
}
