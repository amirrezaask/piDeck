import { describe, it } from "vite-plus/test"
import assert from "node:assert/strict"
import { fuzzyFilter, fuzzyScore } from "./fuzzy.js"

describe("lister fuzzy", () => {
  it("empty query keeps order", () => {
    const items = [{ searchText: "b" }, { searchText: "a" }]
    assert.deepEqual(
      fuzzyFilter("", items).map(i => i.searchText),
      ["b", "a"],
    )
  })

  it("ranks exact / prefix ahead of subsequence", () => {
    const items = [
      { searchText: "open file" },
      { searchText: "terminal.open" },
      { searchText: "foo" },
    ]
    const out = fuzzyFilter("open", items).map(i => i.searchText)
    assert.equal(out[0], "open file")
    assert.ok(out.includes("terminal.open"))
    assert.ok(!out.includes("foo"))
  })

  it("requires all tokens", () => {
    assert.equal(fuzzyScore("open file", "open folder"), null)
    assert.ok(fuzzyScore("open file", "open file dialog") !== null)
  })

  it("matches subsequence", () => {
    assert.ok(fuzzyScore("top", "terminal.open") !== null)
  })

  for (const size of [1, 100, 5_000]) {
    it(`filters a ${size}-row palette deterministically`, () => {
      const items = Array.from({ length: size }, (_, index) => ({
        searchText: `Session ${index} host-${index % 4} idle`,
        index,
      }))
      const result = fuzzyFilter(`Session ${size - 1}`, items)
      assert.equal(result[0]?.index, size - 1)
      assert.equal(items.length, size)
    })
  }
})
