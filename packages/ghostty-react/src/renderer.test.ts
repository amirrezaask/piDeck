import { strict as assert } from "node:assert"
import { test } from "vite-plus/test"
import { GHOSTTY_CELL_WIDE } from "./render-model.js"
import type { GhosttyCell, GhosttySnapshot } from "./core.js"
import {
  ghosttyTextRunEnd,
  measureGhosttyCell,
  renderGhosttySnapshot,
  terminalGridSize,
  terminalMouseCoordinate,
} from "./renderer.js"

const color = { r: 255, g: 255, b: 255 }
const background = { r: 0, g: 0, b: 0 }

function cell(text: string, wide = GHOSTTY_CELL_WIDE.narrow): GhosttyCell {
  return {
    text,
    wide,
    foreground: color,
    background,
    bold: false,
    italic: false,
    invisible: false,
    strikethrough: false,
    overline: false,
    underline: 0,
    selected: false,
  }
}

function snapshot(cells: GhosttyCell[], cursorX = -1): GhosttySnapshot {
  return {
    cols: cells.length,
    rows: 1,
    foreground: color,
    background,
    cursor: color,
    cursorX,
    cursorY: cursorX < 0 ? -1 : 0,
    cursorVisible: cursorX >= 0,
    cursorBlinking: false,
    cursorStyle: 1,
    dirtyRows: new Set([0]),
    rowData: [
      {
        cells,
        text: cells.map((value) => value.text || " ").join(""),
        isWrapContinuation: false,
        wrapsToNext: false,
      },
    ],
  }
}

function contextWith(overrides: Record<string, unknown> = {}) {
  const context = {
    canvas: { width: 200, height: 80 },
    beginPath: () => {},
    clip: () => {},
    fillRect: (..._args: number[]) => {},
    fillText: (..._args: unknown[]) => {},
    rect: () => {},
    resetTransform: () => {},
    restore: () => {},
    save: () => {},
    strokeRect: () => {},
    set fillStyle(_value: string) {},
    set strokeStyle(_value: string) {},
    set font(_value: string) {},
    set textBaseline(_value: string) {},
    ...overrides,
  }
  return context as unknown as CanvasRenderingContext2D
}

test("terminalGridSize keeps a valid one-cell fallback", () => {
  assert.deepEqual(terminalGridSize(808, 408, { width: 10, height: 20, baseline: 15 }, 4), {
    cols: 80,
    rows: 20,
  })
  assert.deepEqual(terminalGridSize(0, 0, { width: 10, height: 20, baseline: 15 }, 4), {
    cols: 1,
    rows: 1,
  })
})

test("scales mouse coordinates into Ghostty's integer geometry", () => {
  assert.equal(terminalMouseCoordinate(84, 840, 800), 80)
  assert.equal(terminalMouseCoordinate(840, 840, 800), 800)
  assert.equal(terminalMouseCoordinate(Number.NaN, 840, 800), 0)
})

test("measureGhosttyCell uses descender-aware metrics", () => {
  const measureText = (text: string) =>
    text === "M"
      ? { width: 7.2, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 0 }
      : { width: 14.4, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 }
  const context = contextWith({ measureText })

  assert.deepEqual(measureGhosttyCell(context, 12, "monospace"), {
    width: 7.2,
    height: 16,
    baseline: 11,
  })
})

test("ghosttyTextRunEnd ends after each wide glyph spacer", () => {
  const cells = [
    cell("界", GHOSTTY_CELL_WIDE.wide),
    cell("", GHOSTTY_CELL_WIDE.spacerTail),
    cell("🙂", GHOSTTY_CELL_WIDE.wide),
    cell("", GHOSTTY_CELL_WIDE.spacerTail),
    cell(""),
  ]
  assert.equal(ghosttyTextRunEnd(cells, 0, () => true), 2)
  assert.equal(ghosttyTextRunEnd(cells, 2, () => true), 4)
})

test("renderGhosttySnapshot underlines every cell in a wrapped hovered link", () => {
  const fillRectCalls: number[][] = []
  const context = contextWith({
    fillRect: (...args: number[]) => fillRectCalls.push(args),
    fillText: () => {},
  })
  const rows = [0, 1].map(() => ({
    cells: [cell("a"), cell("b"), cell("c"), cell("d")],
    text: "abcd",
    isWrapContinuation: false,
    wrapsToNext: false,
  }))
  const value: GhosttySnapshot = {
    ...snapshot(rows[0]!.cells),
    cols: 4,
    rows: 2,
    dirtyRows: new Set([0, 1]),
    rowData: rows,
  }

  renderGhosttySnapshot({
    context,
    snapshot: value,
    metrics: { width: 10, height: 20, baseline: 15 },
    fontSize: 12,
    fontFamily: "monospace",
    padding: 4,
    forceFull: false,
    cursorOn: false,
    hoveredLinkRange: { start: { x: 2, y: 0 }, end: { x: 1, y: 1 } },
  })

  assert.deepEqual(fillRectCalls.filter(([, , , height]) => height === 1), [
    [24, 22, 10, 1],
    [34, 22, 10, 1],
    [4, 42, 10, 1],
    [14, 42, 10, 1],
  ])
})

test("renderGhosttySnapshot clips text and cursor glyphs to their cells", () => {
  const fillTextCalls: unknown[][] = []
  const context = contextWith({
    fillText: (...args: unknown[]) => fillTextCalls.push(args),
  })

  renderGhosttySnapshot({
    context,
    snapshot: snapshot([cell("a"), cell("b"), cell("x")], 2),
    metrics: { width: 7.2, height: 16, baseline: 11 },
    fontSize: 12,
    fontFamily: "monospace",
    padding: 4,
    forceFull: false,
    cursorOn: true,
  })

  assert.deepEqual(fillTextCalls, [
    ["abx", 4, 15],
    ["x", 18.4, 15],
  ])
})

test("renderGhosttySnapshot keeps text after a wide glyph on its grid column", () => {
  const fillTextCalls: unknown[][] = []
  const context = contextWith({
    fillText: (...args: unknown[]) => fillTextCalls.push(args),
  })

  renderGhosttySnapshot({
    context,
    snapshot: snapshot([
      cell("界", GHOSTTY_CELL_WIDE.wide),
      cell("", GHOSTTY_CELL_WIDE.spacerTail),
      cell("x"),
    ]),
    metrics: { width: 7.2, height: 16, baseline: 11 },
    fontSize: 12,
    fontFamily: "monospace",
    padding: 4,
    forceFull: false,
    cursorOn: false,
  })

  assert.deepEqual(fillTextCalls, [
    ["界", 4, 15],
    ["x", 18.4, 15],
  ])
})

test("renderGhosttySnapshot snaps fractional row origins to device pixels", () => {
  const rowTops: number[] = []
  const context = contextWith({
    fillRect: (left: number, top: number, width: number, height: number) => {
      if (left === 4 && width === 10 && height === 16) rowTops.push(top)
    },
  })

  renderGhosttySnapshot({
    context,
    snapshot: snapshot([cell("x")]),
    metrics: { width: 10, height: 16, baseline: 11 },
    fontSize: 12,
    fontFamily: "monospace",
    padding: 4,
    originY: 4.25,
    pixelRatio: 2,
    forceFull: false,
    cursorOn: false,
  })

  assert.deepEqual(rowTops, [4.5])
})

test("renderGhosttySnapshot shares snapped edges between adjacent rows", () => {
  const rowRects: number[][] = []
  const context = contextWith({
    fillRect: (left: number, top: number, width: number, height: number) => {
      if (left === 4 && width === 10) rowRects.push([top, height])
    },
  })
  const rows = [0, 1].map(() => ({
    cells: [cell("x")],
    text: "x",
    isWrapContinuation: false,
    wrapsToNext: false,
  }))
  const value: GhosttySnapshot = {
    ...snapshot(rows[0]!.cells),
    rows: 2,
    dirtyRows: new Set([0, 1]),
    rowData: rows,
  }
  const pixelRatio = 1.25

  renderGhosttySnapshot({
    context,
    snapshot: value,
    metrics: { width: 10, height: 17, baseline: 12 },
    fontSize: 12,
    fontFamily: "monospace",
    padding: 4,
    originY: 4.2,
    pixelRatio,
    forceFull: false,
    cursorOn: false,
  })

  assert.equal(rowRects.length, 2)
  const [first, second] = rowRects
  assert.ok(first)
  assert.ok(second)
  assert.equal(first[0]! + first[1]!, second[0])
  assert.ok(
    rowRects
      .flat()
      .every(value => Math.abs(value * pixelRatio - Math.round(value * pixelRatio)) < 1e-9),
  )
})
