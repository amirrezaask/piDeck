import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import {
  DEFAULT_MONO_FONT_FAMILY,
  DEFAULT_MONO_FONT_NAME,
  NERD_FONT_FAMILY,
  buildMonoFontStack,
  withNerdFontFallback,
} from "./appearance-defaults.js"

describe("buildMonoFontStack", () => {
  it("puts Symbols Nerd Font Mono before generic families", () => {
    const stack = buildMonoFontStack(DEFAULT_MONO_FONT_NAME)
    assert.equal(
      stack,
      `"${DEFAULT_MONO_FONT_NAME}", "${NERD_FONT_FAMILY}", ui-monospace, monospace`,
    )
    const nerdAt = stack.indexOf(NERD_FONT_FAMILY)
    const monoAt = stack.indexOf("monospace")
    assert.ok(nerdAt >= 0 && nerdAt < monoAt)
  })

  it("keeps a named face and still appends the nerd fallback", () => {
    assert.equal(
      buildMonoFontStack("JetBrains Mono"),
      `"JetBrains Mono", "${NERD_FONT_FAMILY}", ui-monospace, monospace`,
    )
  })

  it("does not duplicate the nerd face", () => {
    const once = buildMonoFontStack(DEFAULT_MONO_FONT_NAME)
    assert.equal(withNerdFontFallback(once), once)
    assert.equal(buildMonoFontStack(once), once)
  })

  it("inserts the nerd face into a prebuilt stack before generics", () => {
    assert.equal(
      buildMonoFontStack(`"${DEFAULT_MONO_FONT_NAME}", ui-monospace, monospace`),
      DEFAULT_MONO_FONT_FAMILY,
    )
  })

  it("returns the default stack for empty input", () => {
    assert.equal(buildMonoFontStack("  "), DEFAULT_MONO_FONT_FAMILY)
  })
})
