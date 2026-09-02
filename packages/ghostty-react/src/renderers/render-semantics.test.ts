import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  terminalRowEdges,
  terminalUnderlineRects,
} from "./render-semantics.js"

test("adjacent fractional-DPR row edges are shared exactly", () => {
  for (const ratio of [1, 1.25, 1.5, 2]) {
    const first = terminalRowEdges(4, 0, 17.3, ratio)
    const second = terminalRowEdges(4, 1, 17.3, ratio)
    assert.equal(first.bottom, second.top)
  }
})

test("all Ghostty underline styles retain distinct structural geometry", () => {
  const counts = new Map<number, number>()
  for (let style = 1; style <= 5; style += 1) {
    const rects = terminalUnderlineRects(style, 0, 20, 40, 1.25)
    assert.ok(rects.length > 0)
    counts.set(style, rects.length)
  }
  assert.equal(counts.get(1), 1)
  assert.equal(counts.get(2), 2)
  assert.ok((counts.get(3) ?? 0) > 2)
  assert.ok((counts.get(4) ?? 0) > (counts.get(5) ?? 0))
})

test("underline geometry stays inside the cell span", () => {
  for (let style = 1; style <= 5; style += 1) {
    for (const rect of terminalUnderlineRects(style, 10, 20, 13, 2)) {
      assert.ok(rect.x >= 10)
      assert.ok(rect.x + rect.width <= 23)
      assert.ok(rect.height > 0)
    }
  }
})
