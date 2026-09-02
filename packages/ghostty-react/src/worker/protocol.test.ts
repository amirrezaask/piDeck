import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  GHOSTTY_RENDER_UPDATE_VERSION,
  ghosttyRenderUpdateBuffers,
  type GhosttyRenderUpdate,
} from "../core.js"
import {
  TERMINAL_WORKER_PROTOCOL_VERSION,
  terminalRenderUpdateBufferTransferList,
  terminalRenderUpdateTransferList,
  validateTerminalWorkerCommand,
  validateTerminalWorkerEvent,
} from "./protocol.js"

const envelope = {
  version: TERMINAL_WORKER_PROTOCOL_VERSION,
  terminalId: "terminal-1",
  sequence: 1,
  generation: 1,
} as const

function packedUpdate(): GhosttyRenderUpdate {
  return {
    version: GHOSTTY_RENDER_UPDATE_VERSION,
    frameId: 1,
    generation: 1,
    cols: 1,
    rows: 1,
    full: true,
    foreground: 0xffffff,
    background: 0,
    cursor: 0xffffff,
    cursorX: 0,
    cursorY: 0,
    cursorVisible: true,
    cursorBlinking: false,
    cursorStyle: 1,
    dirtyRows: new Uint32Array([0]),
    rowFlags: new Uint8Array([0]),
    graphemeOffsets: new Uint32Array([0]),
    graphemeLengths: new Uint32Array([1]),
    foregrounds: new Uint32Array([0xffffff]),
    backgrounds: new Uint32Array([0]),
    styles: new Uint16Array([0]),
    graphemes: new Uint8Array([65]),
  }
}

test("validates every worker command family and rejects malformed envelopes", () => {
  const commands = [
    { ...envelope, type: "create", cols: 80, rows: 24, cellWidth: 8, cellHeight: 16, visible: true, focused: false, theme: { foreground: { r: 1, g: 2, b: 3 }, background: { r: 0, g: 0, b: 0 }, cursor: { r: 1, g: 2, b: 3 } } },
    { ...envelope, type: "writeBytes", data: new Uint8Array([120]) },
    { ...envelope, type: "writeReplayBytes", chunks: [new Uint8Array([120])] },
    { ...envelope, type: "resetAndWriteBytes", data: new Uint8Array([120]) },
    {
      ...envelope,
      type: "recycleRenderUpdate",
      slotId: 0,
      leaseToken: 1,
      buffers: {
        dirtyRows: new ArrayBuffer(4), rowFlags: new ArrayBuffer(1),
        graphemeOffsets: new ArrayBuffer(4), graphemeLengths: new ArrayBuffer(4),
        foregrounds: new ArrayBuffer(4), backgrounds: new ArrayBuffer(4),
        styles: new ArrayBuffer(2), graphemes: new ArrayBuffer(1),
      },
    },
    { ...envelope, type: "resize", cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 },
    { ...envelope, type: "setTheme", theme: {} },
    { ...envelope, type: "setPresentationState", visible: false, focused: true },
    { ...envelope, type: "setFontMetrics", cellWidth: 8, cellHeight: 16 },
    { ...envelope, type: "key", action: "press", event: {} },
    { ...envelope, type: "paste", data: "x" },
    { ...envelope, type: "text", data: "x" },
    { ...envelope, type: "mouse", input: {} },
    { ...envelope, type: "setSelection", anchor: {}, end: {} },
    { ...envelope, type: "clearSelection" },
    { ...envelope, type: "selectAll" },
    { ...envelope, type: "selectWord", col: 0, row: 0 },
    { ...envelope, type: "selectLine", col: 0, row: 0 },
    { ...envelope, type: "scroll", delta: 1 },
    { ...envelope, type: "scrollToBottom" },
    { ...envelope, type: "viewportPointToScreen", col: 0, row: 0 },
    { ...envelope, type: "screenPointToViewport", col: 0, row: 0 },
    { ...envelope, type: "requestFullFrame" },
    { ...envelope, type: "dispose" },
  ]
  for (const command of commands) assert.equal(validateTerminalWorkerCommand(command), true)
  assert.equal(validateTerminalWorkerCommand({ ...envelope, version: 99, type: "dispose" }), false)
  assert.equal(validateTerminalWorkerCommand({ ...envelope, sequence: -1, type: "dispose" }), false)
  assert.equal(validateTerminalWorkerCommand({ ...envelope, type: "writeBytes", data: "x" }), false)
  assert.equal(validateTerminalWorkerCommand({ ...envelope, type: "writeBytes", data: new Uint8Array() }), false)
  assert.equal(validateTerminalWorkerCommand({ ...envelope, type: "unknown" }), false)
})

test("requires payload-free worker capacity diagnostics", () => {
  const diagnostics = {
    writes: 1,
    bytesParsed: 2,
    renderBuilds: 3,
    transfers: 4,
    suppressedHidden: 5,
    suppressedSynchronized: 6,
    fullCatchUps: 7,
    synchronizationTimeouts: 8,
    pendingPresentation: false,
    slotsInFlight: 0,
    bufferAllocations: 24,
    renderBytesUsed: 1024,
    renderBytesAllocated: 4096,
    renderIdleTrims: 1,
    renderIdleBytesReclaimed: 2048,
    renderIdleRegrows: 1,
    schedulerQueueBytes: 0,
    schedulerQueueCommands: 0,
    schedulerInFlight: 0,
  }
  assert.equal(validateTerminalWorkerEvent({ ...envelope, type: "parsed", diagnostics }), true)
  const { renderBytesUsed: _, ...staleDiagnostics } = diagnostics
  assert.equal(
    validateTerminalWorkerEvent({ ...envelope, type: "parsed", diagnostics: staleDiagnostics }),
    false,
  )
})

test("validates packed events and transfers ownership of every packed buffer", () => {
  const update = packedUpdate()
  const event = {
    ...envelope,
    type: "packedUpdate",
    slotId: 0,
    leaseToken: 1,
    update,
    state: {
      title: "",
      scrollbar: null,
      selectionText: "",
      viewportActive: true,
      mouseTracking: false,
      mouseAnyEventTracking: false,
      alternateScreen: false,
      applicationCursorKeys: false,
      synchronizedOutput: false,
    },
  }
  assert.equal(validateTerminalWorkerEvent(event), true)
  const transfer = terminalRenderUpdateTransferList(update)
  assert.equal(transfer.length, 8)
  assert.equal(
    terminalRenderUpdateBufferTransferList(ghosttyRenderUpdateBuffers(update)).length,
    8,
  )
  structuredClone(event, { transfer })
  assert.equal(update.dirtyRows.buffer.byteLength, 0)
  assert.equal(validateTerminalWorkerEvent({ ...event, generation: 0 }), false)
  assert.equal(validateTerminalWorkerEvent({ ...envelope, type: "encodedInput", data: 1 }), false)
})
