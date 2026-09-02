import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { TerminalV3Store } from "./terminal-v3-store.js"
import type { TerminalPatchMessage, TerminalSnapshotMessage } from "@yaade/rpc"

function snapshot(revision: number) {
  return {
    schemaVersion: 1 as const,
    cols: 80,
    rows: 1,
    activeScreen: "primary" as const,
    revision,
    cursor: { x: 0, y: 0, visible: true, blinking: true, style: 1 },
    screenRows: [],
    scrollback: { firstRowId: null, lastRowId: null, rowCount: 0 },
    modes: {
      bracketedPaste: false,
      applicationCursorKeys: false,
      focusReporting: false,
      mouseTracking: false,
      mouseSgr: false,
      mouseSgrPixels: false,
      synchronizedOutput: false,
      kittyKeyboard: false,
    },
    title: null,
    palette: [],
    hyperlinks: [],
  }
}

test("remote terminal store rejects revision gaps and accepts matching patches", () => {
  const store = new TerminalV3Store()
  const initial: TerminalSnapshotMessage = {
    type: "terminal.snapshot",
    terminalId: "terminal-a",
    ownerEpoch: "owner-a",
    terminalEpoch: "epoch-a",
    revision: 1,
    snapshot: snapshot(1),
  }
  assert.equal(store.applySnapshot(initial), "applied")
  const gap: TerminalPatchMessage = {
    type: "terminal.patch",
    terminalId: "terminal-a",
    ownerEpoch: "owner-a",
    terminalEpoch: "epoch-a",
    baseRevision: 0,
    revision: 2,
    patch: {
      schemaVersion: 1,
      terminalEpoch: "epoch-a",
      baseRevision: 0,
      revision: 2,
      changedRows: [],
      deletedRowIds: [],
    },
  }
  assert.equal(store.applyPatch(gap), "resync-required")
  const patch: TerminalPatchMessage = {
    ...gap,
    baseRevision: 1,
    patch: { ...gap.patch, baseRevision: 1 },
  }
  assert.equal(store.applyPatch(patch), "applied")
  assert.equal(store.applyPatch(patch), "ignored")
  assert.equal(store.applySnapshot(initial), "ignored")
  assert.equal(store.currentRevision, 2)
})

test("a new terminal epoch replaces the old client state", () => {
  const store = new TerminalV3Store()
  const first: TerminalSnapshotMessage = {
    type: "terminal.snapshot",
    terminalId: "terminal-a",
    ownerEpoch: "owner-a",
    terminalEpoch: "epoch-a",
    revision: 3,
    snapshot: snapshot(3),
  }
  const next: TerminalSnapshotMessage = {
    ...first,
    ownerEpoch: "owner-b",
    terminalEpoch: "epoch-b",
    revision: 1,
    snapshot: snapshot(1),
  }
  assert.equal(store.applySnapshot(first), "applied")
  assert.equal(store.applySnapshot(next), "applied")
  assert.equal(store.currentTerminalEpoch, "epoch-b")
})
