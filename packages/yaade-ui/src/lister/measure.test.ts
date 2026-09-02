import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import {
  measureLongestItemContentWidth,
  measureTextWidthPx,
  readListerLabelFont,
  readPaletteRowHeight,
  readPaletteSizeMinWidthPx,
  resolveCssLengthPx,
} from "./measure.js"

describe("resolveCssLengthPx", () => {
  it("scales semantic rem row heights from the UI font size", () => {
    assert.equal(resolveCssLengthPx("3.5rem", 13, 3.5), 45.5)
    assert.equal(resolveCssLengthPx("3.5rem", 24, 3.5), 84)
  })

  it("keeps explicit CSS pixel contracts and falls back for calc expressions", () => {
    assert.equal(resolveCssLengthPx("48px", 24, 3.5), 48)
    assert.equal(
      resolveCssLengthPx("calc(var(--yaade-fs-base) * 3.5)", 24, 3.5),
      84,
    )
  })

  it("keeps the single-line palette contract denser than detail rows", () => {
    assert.equal(readPaletteRowHeight("single"), 32.5)
    assert.equal(readPaletteRowHeight("detail"), 39)
    assert.equal(resolveCssLengthPx("2.5rem", 10, 2.5), 25)
    assert.equal(resolveCssLengthPx("3rem", 10, 3), 30)
    assert.equal(resolveCssLengthPx("2.5rem", 24, 2.5), 60)
    assert.equal(resolveCssLengthPx("3rem", 24, 3), 72)
  })
})

describe("measureLongestItemContentWidth", () => {
  it("reports width driven by the longest label plus chrome", () => {
    const font = readListerLabelFont({ mono: true })
    const short = measureTextWidthPx("a.ts", font)
    const long = measureTextWidthPx(
      "packages/yaade-ui/src/home/TerminalSessionModal.tsx",
      font,
    )
    assert.ok(long > short)

    const chrome = 58
    const needed = measureLongestItemContentWidth(
      ["a.ts", "packages/yaade-ui/src/home/TerminalSessionModal.tsx", "mid.ts"],
      { font, chromePx: chrome },
    )
    assert.equal(needed, long + chrome)
  })

  it("returns only chrome when there are no labels", () => {
    assert.equal(measureLongestItemContentWidth([], { chromePx: 40 }), 40)
  })

  it("keeps wide palette min wider than picker", () => {
    assert.ok(readPaletteSizeMinWidthPx("wide") > readPaletteSizeMinWidthPx("picker"))
  })
})
