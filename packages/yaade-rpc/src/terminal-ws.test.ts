import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  decodeTerminalDataFrame,
  encodeTerminalDataFrame,
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
