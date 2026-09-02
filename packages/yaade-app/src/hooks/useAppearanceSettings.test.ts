import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import {
  normalizeColorSchemeMode,
  normalizeSessionLayout,
  normalizeThemeId,
  themeIdForColorSchemeMode,
} from "./useAppearanceSettings.js"

describe("normalizeThemeId", () => {
  it("keeps only the default light and dark palettes", () => {
    assert.equal(normalizeThemeId("default-dark"), "default-dark")
    assert.equal(normalizeThemeId("default-light"), "default-light")
    assert.equal(normalizeThemeId("catppuccin-mocha"), "default-dark")
    assert.equal(normalizeThemeId("tokyonight-day", "light"), "default-light")
  })

  it("uses the stored scheme for unknown ids", () => {
    assert.equal(normalizeThemeId("removed-theme", "light"), "default-light")
    assert.equal(normalizeThemeId("removed-theme", "dark"), "default-dark")
  })
})

describe("session layout", () => {
  it("keeps supported horizontal and vertical tab layouts", () => {
    assert.equal(normalizeSessionLayout("tabs"), "tabs")
    assert.equal(normalizeSessionLayout("single-sidebar"), "single-sidebar")
  })

  it("migrates removed layouts to horizontal tabs", () => {
    assert.equal(normalizeSessionLayout("two-sidebars"), "tabs")
    assert.equal(normalizeSessionLayout("sidebar"), "tabs")
    assert.equal(normalizeSessionLayout("cards"), "tabs")
  })
})

describe("color scheme mode", () => {
  it("normalizes persisted modes", () => {
    assert.equal(normalizeColorSchemeMode("system"), "system")
    assert.equal(normalizeColorSchemeMode("light"), "light")
    assert.equal(normalizeColorSchemeMode("dark"), "dark")
    assert.equal(normalizeColorSchemeMode("removed", "light"), "light")
  })

  it("uses the system scheme only in auto mode", () => {
    assert.equal(
      themeIdForColorSchemeMode("default-dark", "system", "light"),
      "default-light",
    )
    assert.equal(
      themeIdForColorSchemeMode("default-light", "system", "dark"),
      "default-dark",
    )
    assert.equal(
      themeIdForColorSchemeMode("default-dark", "light", "dark"),
      "default-light",
    )
  })
})
