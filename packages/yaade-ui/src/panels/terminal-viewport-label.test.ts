import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { terminalViewportActivityLabels } from "./terminal-viewport-label.js"

describe("terminal viewport activity labels", () => {
  it("labels zero, one, many, and unknown unseen rows", () => {
    assert.deepEqual(terminalViewportActivityLabels(0), {
      visual: "Jump to live",
      accessible: "Jump to live",
    })
    assert.deepEqual(terminalViewportActivityLabels(1), {
      visual: "1 new row",
      accessible: "1 new row. Jump to live",
    })
    assert.deepEqual(terminalViewportActivityLabels(42), {
      visual: "42 new rows",
      accessible: "42 new rows. Jump to live",
    })
    assert.deepEqual(terminalViewportActivityLabels(null), {
      visual: "New output",
      accessible: "New output. Jump to live",
    })
  })

  it("caps visual and unreasonable accessible counts", () => {
    assert.deepEqual(terminalViewportActivityLabels(1_000), {
      visual: "999+ new rows",
      accessible: "1000 new rows. Jump to live",
    })
    assert.deepEqual(terminalViewportActivityLabels(1_000_000), {
      visual: "999+ new rows",
      accessible: "More than 999,999 new rows. Jump to live",
    })
  })
})
