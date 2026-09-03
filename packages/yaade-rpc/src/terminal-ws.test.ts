import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  decodeTerminalDataFrame,
  encodeTerminalDataFrame,
  encodeTerminalInputFrame,
  encodeTerminalResizeFrame,
  encodeTerminalWsCommand,
  tryDecodeTerminalWsCommand,
  tryDecodeTerminalWsResult,
} from "./terminal-ws.js";

test("round-trips binary terminal:data frames", () => {
  const payload = new Uint8Array([0x68, 0x69, 0xff, 0xe2]);
  const encoded = encodeTerminalDataFrame(42, 7, "term-1", payload);
  const decoded = decodeTerminalDataFrame(encoded);
  assert.deepEqual(decoded, {
    eventSequence: 42,
    terminalSequence: 7,
    id: "term-1",
    payload,
  });
});

test("rejects truncated or wrong-type binary frames", () => {
  assert.equal(
    decodeTerminalDataFrame(new Uint8Array([0x02, 0, 0, 0, 1])),
    null,
  );
  assert.equal(decodeTerminalDataFrame(new Uint8Array([0x01, 0, 0])), null);
  assert.equal(
    decodeTerminalDataFrame(new Uint8Array([0x03, 0, 0, 0, 1, 0, 0, 0, 1])),
    null,
  );
});

test("round-trips v2 frames with sequences above 2^32", () => {
  const eventSequence = 2 ** 32 + 17;
  const terminalSequence = 2 ** 32 + 99;
  const encoded = encodeTerminalDataFrame(
    eventSequence,
    terminalSequence,
    "term-u64",
    new Uint8Array([1, 2, 3]),
  );
  assert.equal(encoded[0], 0x02);
  assert.deepEqual(decodeTerminalDataFrame(encoded), {
    eventSequence,
    terminalSequence,
    id: "term-u64",
    payload: new Uint8Array([1, 2, 3]),
  });
});

test("encodes binary INPUT with stream epoch and byte position", () => {
  const payload = new Uint8Array([0, 0xff, 0x1b]);
  const encoded = encodeTerminalInputFrame(17, 9, 3, payload);
  const view = new DataView(encoded.buffer);
  assert.deepEqual(Array.from(encoded.subarray(0, 4)), [0x50, 0x44, 4, 7]);
  assert.equal(view.getBigUint64(8), 17n);
  assert.equal(view.getBigUint64(16), 9n);
  assert.equal(view.getBigUint64(24), 3n);
  assert.equal(view.getUint32(32), payload.byteLength);
  assert.deepEqual(encoded.subarray(36), payload);
});

test("encodes binary RESIZE with bounded dimensions and control position", () => {
  const encoded = encodeTerminalResizeFrame(17, 9, 4, 132, 48);
  const view = new DataView(encoded.buffer);
  assert.deepEqual(Array.from(encoded.subarray(0, 4)), [0x50, 0x44, 4, 8]);
  assert.equal(view.getBigUint64(8), 17n);
  assert.equal(view.getBigUint64(16), 9n);
  assert.equal(view.getBigUint64(24), 4n);
  assert.equal(view.getUint16(36), 132);
  assert.equal(view.getUint16(38), 48);
  assert.throws(() => encodeTerminalResizeFrame(17, 9, 5, 0, 48));
});

test("decodes a snapshot payload larger than its stream cut", () => {
  const encoded = new Uint8Array(36 + 128);
  const view = new DataView(encoded.buffer);
  encoded.set([0x50, 0x44, 4, 4]);
  view.setUint16(6, 36);
  view.setBigUint64(8, 17n);
  view.setBigUint64(16, 9n);
  view.setBigUint64(24, 3n);
  view.setUint32(32, 128);
  assert.equal(decodeTerminalDataFrame(encoded)?.frameType, "snapshot");
});

test("decodes protocol-v4 PTY_DATA without copying its opaque payload", () => {
  const payload = new Uint8Array([0xff, 0xe2, 0x82]);
  const encoded = new Uint8Array(36 + payload.byteLength);
  const view = new DataView(encoded.buffer);
  encoded.set([0x50, 0x44, 4, 6]);
  view.setUint16(6, 36);
  view.setBigUint64(8, 17n);
  view.setBigUint64(16, 9n);
  view.setBigUint64(24, 103n);
  view.setUint32(32, payload.byteLength);
  encoded.set(payload, 36);
  const decoded = decodeTerminalDataFrame(encoded);
  assert.deepEqual(decoded, {
    eventSequence: 0,
    terminalSequence: 103,
    streamId: 17,
    streamEpoch: 9,
    frameType: "pty-data",
    payload: encoded.subarray(36),
  });
  assert.equal(decoded?.payload.buffer, encoded.buffer);
});

test("encodes and decodes terminal WS control commands", () => {
  const raw = JSON.parse(
    encodeTerminalWsCommand("request-1", "terminal:write", ["id", "x"]),
  );
  assert.deepEqual(tryDecodeTerminalWsCommand(raw), {
    requestId: "request-1",
    op: "terminal:write",
    args: ["id", "x"],
  });
  assert.deepEqual(
    tryDecodeTerminalWsCommand({
      requestId: "request-2",
      op: "terminal:ready",
      args: ["id"],
    }),
    { requestId: "request-2", op: "terminal:ready", args: ["id"] },
  );
  assert.equal(
    tryDecodeTerminalWsCommand({ op: "mux:listSessions", args: [] }),
    null,
  );
});

test("decodes observable terminal WS results", () => {
  assert.deepEqual(
    tryDecodeTerminalWsResult({
      type: "terminal:result",
      requestId: "request-1",
      ok: true,
      value: null,
    }),
    { type: "terminal:result", requestId: "request-1", ok: true, value: null },
  );
  assert.deepEqual(
    tryDecodeTerminalWsResult({
      type: "terminal:result",
      requestId: "request-2",
      ok: false,
      error: { code: "NOT_FOUND", message: "terminal missing" },
    }),
    {
      type: "terminal:result",
      requestId: "request-2",
      ok: false,
      error: { code: "NOT_FOUND", message: "terminal missing" },
    },
  );
});
