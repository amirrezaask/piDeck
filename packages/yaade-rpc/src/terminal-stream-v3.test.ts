import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  applyTerminalSemanticPatch,
  type TerminalSemanticPatch,
  type TerminalSemanticSnapshot,
} from "./terminal-stream-v3.js"

const color = { r: 255, g: 255, b: 255 }
const modes = {
  bracketedPaste: false,
  applicationCursorKeys: false,
  focusReporting: false,
  mouseTracking: false,
  mouseSgr: false,
  mouseSgrPixels: false,
  synchronizedOutput: false,
  kittyKeyboard: false,
}

function row(rowId: string, text: string) {
  return {
    rowId,
    cells: [{
      text,
      wide: 0,
      foreground: color,
      background: { r: 0, g: 0, b: 0 },
      bold: false,
      faint: false,
      italic: false,
      blink: false,
      inverse: false,
      invisible: false,
      strikethrough: false,
      overline: false,
      underline: 0,
    }],
    isWrapContinuation: false,
    wrapsToNext: false,
  }
}

function snapshot(): TerminalSemanticSnapshot {
  return {
    schemaVersion: 1,
    cols: 80,
    rows: 2,
    activeScreen: "primary",
    revision: 4,
    cursor: { x: 1, y: 0, visible: true, blinking: true, style: 1 },
    screenRows: [row("row-1", "one"), row("row-2", "two")],
    scrollback: { firstRowId: null, lastRowId: null, rowCount: 0 },
    modes,
    title: null,
    palette: [],
    hyperlinks: [],
  }
}

test("semantic patch applies only to the matching epoch and revision", () => {
  const patch: TerminalSemanticPatch = {
    schemaVersion: 1,
    terminalEpoch: "terminal-epoch",
    baseRevision: 4,
    revision: 5,
    changedRows: [row("row-2", "updated")],
    deletedRowIds: [],
  }
  const next = applyTerminalSemanticPatch(snapshot(), "terminal-epoch", patch)
  assert.ok(next)
  assert.equal(next.revision, 5)
  assert.equal(next.screenRows[1]?.cells[0]?.text, "updated")
  assert.equal(applyTerminalSemanticPatch(snapshot(), "other-epoch", patch), null)
  assert.equal(
    applyTerminalSemanticPatch(snapshot(), "terminal-epoch", { ...patch, baseRevision: 3 }),
    null,
  )
})

test("full reset replaces screen rows and preserves semantic mode fields", () => {
  const current = snapshot()
  const patch: TerminalSemanticPatch = {
    schemaVersion: 1,
    terminalEpoch: "terminal-epoch",
    baseRevision: 4,
    revision: 5,
    changedRows: [row("alternate-1", "alternate")],
    deletedRowIds: ["row-1", "row-2"],
    activeScreen: "alternate",
    modes: { ...modes, applicationCursorKeys: true },
    fullReset: true,
  }
  const next = applyTerminalSemanticPatch(current, "terminal-epoch", patch)
  assert.ok(next)
  assert.equal(next.activeScreen, "alternate")
  assert.equal(next.modes.applicationCursorKeys, true)
  assert.deepEqual(next.screenRows.map(item => item.rowId), ["alternate-1"])
})
