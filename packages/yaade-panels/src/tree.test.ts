import { describe, it } from "vite-plus/test"
import assert from "node:assert/strict"
import { PanelTree, type PanelNode, type PanelTreeOptions } from "./tree.js"

type TestView = { kind: "empty" } | { kind: "text"; value: string }

const options: PanelTreeOptions<TestView> = {
  emptyView: () => ({ kind: "empty" }),
  isEmpty: v => v.kind === "empty",
}

function countLeaves<TView>(tree: PanelTree<TView>): number {
  let count = 0
  const walk = (node: PanelNode<TView>) => {
    if (node.kind === "leaf") count++
    else node.split.children.forEach(walk)
  }
  walk(tree.root)
  return count
}

function leafIds<TView>(tree: PanelTree<TView>): number[] {
  const ids: number[] = []
  tree.visitLeaves(n => ids.push(n.panelId.id))
  return ids
}

function rootLeafId<TView>(tree: PanelTree<TView>): { id: number } {
  if (tree.root.kind !== "leaf") throw new Error("expected leaf root")
  return tree.root.panelId
}

describe("PanelTree — construction", () => {
  it("initial tree has one leaf with emptyView", () => {
    const tree = new PanelTree(options)
    assert.equal(countLeaves(tree), 1)
    assert.equal(tree.getView(rootLeafId(tree))?.kind, "empty")
  })

  it("allocPanelId hands out unique increasing ids", () => {
    const tree = new PanelTree(options)
    const a = tree.allocPanelId()
    const b = tree.allocPanelId()
    assert.notEqual(a.id, b.id)
    assert.equal(b.id, a.id + 1)
  })
})

describe("PanelTree — setView / getView / findPanelWithView", () => {
  it("setView + getView round-trip", () => {
    const tree = new PanelTree(options)
    const id = rootLeafId(tree)
    tree.setView(id, { kind: "text", value: "hi" })
    assert.deepEqual(tree.getView(id), { kind: "text", value: "hi" })
  })

  it("getView on unknown panel returns null", () => {
    const tree = new PanelTree(options)
    assert.equal(tree.getView({ id: 99 }), null)
  })

  it("findPanelWithView locates matching leaf across splits", () => {
    const tree = new PanelTree(options)
    const rootId = rootLeafId(tree)
    const right = tree.splitAtEdge(rootId, "right")
    tree.setView(right, { kind: "text", value: "found" })
    const found = tree.findPanelWithView(v => v.kind === "text" && v.value === "found")
    assert.equal(found?.id, right.id)
  })

  it("findPanelWithView returns null when no match", () => {
    const tree = new PanelTree(options)
    assert.equal(tree.findPanelWithView(v => v.kind === "text"), null)
  })
})

describe("PanelTree — splitAtEdge", () => {
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    it(`splitAtEdge ${edge} adds one leaf`, () => {
      const tree = new PanelTree(options)
      const id = rootLeafId(tree)
      const next = tree.splitAtEdge(id, edge)
      assert.equal(countLeaves(tree), 2)
      assert.notEqual(next.id, id.id)
      assert.equal(tree.getView(next)?.kind, "empty")
    })
  }

  it("horizontal edges create row parent", () => {
    const tree = new PanelTree(options)
    tree.splitAtEdge(rootLeafId(tree), "right")
    assert.equal(tree.root.kind, "row")
  })

  it("vertical edges create column parent", () => {
    const tree = new PanelTree(options)
    tree.splitAtEdge(rootLeafId(tree), "bottom")
    assert.equal(tree.root.kind, "column")
  })

  it("right/bottom put new leaf second", () => {
    const tree = new PanelTree(options)
    const src = rootLeafId(tree)
    const next = tree.splitAtEdge(src, "right")
    if (tree.root.kind !== "row") throw new Error("expected row")
    const [first, second] = tree.root.split.children
    if (first?.kind !== "leaf" || second?.kind !== "leaf") throw new Error("expected leaves")
    assert.equal(first.panelId.id, src.id)
    assert.equal(second.panelId.id, next.id)
  })

  it("left/top put new leaf first", () => {
    const tree = new PanelTree(options)
    const src = rootLeafId(tree)
    const next = tree.splitAtEdge(src, "left")
    if (tree.root.kind !== "row") throw new Error("expected row")
    const [first, second] = tree.root.split.children
    if (first?.kind !== "leaf" || second?.kind !== "leaf") throw new Error("expected leaves")
    assert.equal(first.panelId.id, next.id)
    assert.equal(second.panelId.id, src.id)
  })
})

describe("PanelTree — attachAtViewportEdge", () => {
  it("attach left produces row with sidebar first", () => {
    const tree = new PanelTree(options)
    const sidebar = tree.attachAtViewportEdge("left")
    if (tree.root.kind !== "row") throw new Error("expected row")
    const [first] = tree.root.split.children
    assert.equal(first?.kind, "leaf")
    if (first?.kind === "leaf") assert.equal(first.panelId.id, sidebar.id)
    assert.equal(tree.root.split.ratios[0]! < 0.5, true)
  })
})

describe("PanelTree — closePanel", () => {
  it("closing one of two leaves collapses to sibling", () => {
    const tree = new PanelTree(options)
    const src = rootLeafId(tree)
    const right = tree.splitAtEdge(src, "right")
    tree.closePanel(right)
    assert.equal(countLeaves(tree), 1)
    assert.equal(tree.root.kind, "leaf")
    if (tree.root.kind === "leaf") assert.equal(tree.root.panelId.id, src.id)
  })

  it("closing the only leaf yields a fresh empty leaf", () => {
    const tree = new PanelTree(options)
    const only = rootLeafId(tree)
    tree.closePanel(only)
    assert.equal(countLeaves(tree), 1)
    assert.notEqual(leafIds(tree)[0], only.id)
  })

  it("closing rebalances sibling ratios", () => {
    const tree = new PanelTree(options)
    const src = rootLeafId(tree)
    const b = tree.splitAtEdge(src, "right")
    const c = tree.splitAtEdge(b, "right")
    tree.closePanel(c)
    if (tree.root.kind !== "row") throw new Error("expected row")
    assert.equal(tree.root.split.ratios.length, 2)
    for (const r of tree.root.split.ratios) assert.ok(r > 0 && r < 1)
  })
})

describe("PanelTree — setSplitRatios", () => {
  it("valid ratios normalize and apply", () => {
    const tree = new PanelTree(options)
    tree.splitAtEdge(rootLeafId(tree), "right")
    const changed = tree.setSplitRatios([], [1, 3])
    assert.equal(changed, true)
    if (tree.root.kind !== "row") throw new Error("expected row")
    const sum = tree.root.split.ratios.reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1) < 1e-6)
    assert.ok(Math.abs(tree.root.split.ratios[0]! - 0.25) < 1e-6)
  })

  it("wrong-length ratios rejected", () => {
    const tree = new PanelTree(options)
    tree.splitAtEdge(rootLeafId(tree), "right")
    assert.equal(tree.setSplitRatios([], [1, 2, 3]), false)
  })

  it("no-op ratios return false", () => {
    const tree = new PanelTree(options)
    tree.splitAtEdge(rootLeafId(tree), "right")
    assert.equal(tree.setSplitRatios([], [0.5, 0.5]), false)
  })

  it("rejects non-finite, negative, and all-zero ratios", () => {
    const tree = new PanelTree(options)
    tree.splitAtEdge(rootLeafId(tree), "right")
    assert.equal(tree.setSplitRatios([], [Number.NaN, 1]), false)
    assert.equal(tree.setSplitRatios([], [-1, 2]), false)
    assert.equal(tree.setSplitRatios([], [0, 1]), false)
    assert.equal(tree.setSplitRatios([], [0, 0]), false)
    if (tree.root.kind !== "row") throw new Error("expected row")
    assert.deepEqual(tree.root.split.ratios, [0.5, 0.5])
  })

  it("setSplitRatios on leaf path returns false", () => {
    const tree = new PanelTree(options)
    assert.equal(tree.setSplitRatios([], [1]), false)
  })
})

describe("PanelTree — computeRects", () => {
  it("single leaf spans viewport", () => {
    const tree = new PanelTree(options)
    const id = rootLeafId(tree)
    const rects = tree.computeRects({ x: 0, y: 0, width: 400, height: 200 })
    const rect = rects.get(id.id)!
    assert.deepEqual({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, { x: 0, y: 0, width: 400, height: 200 })
  })

  it("horizontal split divides width minus splitter", () => {
    const tree = new PanelTree(options)
    const a = rootLeafId(tree)
    const b = tree.splitAtEdge(a, "right")
    const rects = tree.computeRects({ x: 0, y: 0, width: 400, height: 100 })
    const ra = rects.get(a.id)!
    const rb = rects.get(b.id)!
    assert.equal(ra.height, 100)
    assert.equal(rb.height, 100)
    assert.ok(ra.width + rb.width < 400) // splitter subtracted
    assert.equal(ra.x, 0)
    assert.ok(rb.x > ra.width)
  })
})

describe("PanelTree — pruneEmptyLeaves", () => {
  it("keeps single empty leaf", () => {
    const tree = new PanelTree(options)
    tree.pruneEmptyLeaves()
    assert.equal(countLeaves(tree), 1)
  })

  it("collapses extra empty leaves", () => {
    const tree = new PanelTree(options)
    const a = rootLeafId(tree)
    const b = tree.splitAtEdge(a, "right")
    tree.setView(a, { kind: "text", value: "keep" })
    // b stays empty
    void b
    tree.pruneEmptyLeaves()
    assert.equal(countLeaves(tree), 1)
    assert.equal(tree.getView(a)?.kind, "text")
  })
})

describe("PanelTree — JSON round-trip", () => {
  it("toJSON + fromJSON preserves structure and next id", () => {
    const tree = new PanelTree(options)
    const a = rootLeafId(tree)
    const b = tree.splitAtEdge(a, "right")
    tree.setView(b, { kind: "text", value: "roundtrip" })
    const json = tree.toJSON()
    json.nextPanelId = 1
    const restored = PanelTree.fromJSON(options, json)
    assert.equal(countLeaves(restored), 2)
    assert.deepEqual(restored.getView(b), { kind: "text", value: "roundtrip" })
    const next = restored.allocPanelId()
    assert.ok(next.id > b.id)
  })
})
