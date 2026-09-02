import { describe, it } from "vite-plus/test"
import assert from "node:assert/strict"
import { formatKeyBinding } from "./format-key.js"

describe("formatKeyBinding", () => {
  it("never leaves Mod in the label", () => {
    const label = formatKeyBinding("Mod-Shift-g")
    assert.equal(label.includes("Mod"), false)
    assert.match(label, /Ctrl|⌘/)
  })

  it("formats chords without Mod token", () => {
    const label = formatKeyBinding("Mod-n")
    assert.equal(label.includes("Mod"), false)
    assert.match(label, /N/)
  })
})
