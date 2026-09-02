import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  decodeTerminalStreamV3,
  encodeTerminalStreamV3,
  MAX_TERMINAL_STREAM_V3_BYTES,
} from "./terminal-stream-v3-codec.js"
import type { TerminalSnapshotMessage } from "./terminal-stream-v3.js"
import {
  encodeTerminalWsAck,
  tryDecodeTerminalReplayRequired,
  tryDecodeTerminalWsAck,
} from "./terminal-ws.js"

test("v3 terminal frames carry an explicit version, kind, and payload length", () => {
  const message: TerminalSnapshotMessage = {
    type: "terminal.snapshot",
    terminalId: "terminal-a",
    ownerEpoch: "owner-a",
    terminalEpoch: "epoch-a",
    revision: 1,
    snapshot: {
      schemaVersion: 1,
      cols: 80,
      rows: 1,
      activeScreen: "primary",
      revision: 1,
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
    },
  }
  const frame = encodeTerminalStreamV3(message)
  assert.equal(frame[0], 3)
  assert.equal(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2), frame.byteLength - 6)
  assert.deepEqual(decodeTerminalStreamV3(frame), message)
})

test("terminal flow-control frames validate acknowledgement sequences", () => {
  assert.deepEqual(
    tryDecodeTerminalWsAck(JSON.parse(encodeTerminalWsAck("term-1", 42))),
    { type: "terminal:ack", terminalId: "term-1", sequence: 42 },
  )
  assert.equal(
    tryDecodeTerminalWsAck({ type: "terminal:ack", terminalId: "term-1", sequence: -1 }),
    null,
  )
  assert.deepEqual(
    tryDecodeTerminalReplayRequired({
      type: "terminal:replay-required",
      terminalId: "term-1",
      sequence: 40,
    }),
    { type: "terminal:replay-required", terminalId: "term-1", sequence: 40 },
  )
})

test("malformed and oversized v3 frames are rejected", () => {
  assert.equal(decodeTerminalStreamV3(new Uint8Array([3, 1, 0, 0, 0, 2, 0])), null)
  const oversized = new Uint8Array(6)
  oversized[0] = 3
  oversized[1] = 1
  new DataView(oversized.buffer).setUint32(2, MAX_TERMINAL_STREAM_V3_BYTES + 1)
  assert.equal(decodeTerminalStreamV3(oversized), null)
})
