/**
 * Hot-path terminal WebSocket framing.
 *
 * Outbound `terminal:data` uses a compact binary frame so flood paths avoid
 * JSON.stringify of multi-KiB PTY payloads. Client→host control (write/resize/
 * ready) stays JSON — payloads are tiny.
 */

import { getHostRoute, HOST_ROUTE_CHANNELS, type HostRouteName } from "./routes.js"

/** Host → client: binary `terminal:data` frame type bytes. */
export const TERMINAL_DATA_FRAME_TYPE_V1 = 0x01 as const;
export const TERMINAL_DATA_FRAME_TYPE = 0x02 as const;
export const TERMINAL_PROTOCOL_VERSION = 4 as const;
export const TERMINAL_PROTOCOL_HEADER_BYTES = 36 as const;
const TERMINAL_PROTOCOL_MAGIC_0 = 0x50;
const TERMINAL_PROTOCOL_MAGIC_1 = 0x44;
const TERMINAL_PROTOCOL_SNAPSHOT = 4;
const TERMINAL_PROTOCOL_PTY_DATA = 6;
const TERMINAL_PROTOCOL_INPUT = 7;
const TERMINAL_PROTOCOL_RESIZE = 8;
const TERMINAL_PROTOCOL_SCROLLBACK_BEGIN = 9;
const TERMINAL_PROTOCOL_SCROLLBACK_CHUNK = 10;
const TERMINAL_PROTOCOL_SCROLLBACK_END = 11;

type Utf8Encoder = { encode(input: string): Uint8Array };
type Utf8Decoder = { decode(input: Uint8Array): string };

function utf8Encode(text: string): Uint8Array {
  const Encoder = (globalThis as { TextEncoder?: new () => Utf8Encoder })
    .TextEncoder;
  if (!Encoder) throw new Error("TextEncoder unavailable");
  return new Encoder().encode(text);
}

function utf8Decode(bytes: Uint8Array): string {
  const Decoder = (globalThis as { TextDecoder?: new () => Utf8Decoder })
    .TextDecoder;
  if (!Decoder) throw new Error("TextDecoder unavailable");
  return new Decoder().decode(bytes);
}

/**
 * Binary layout v2 (big-endian):
 *   u8  type (= 0x02)
 *   u64 eventSequence
 *   u64 terminalSequence
 *   u16 idLen
 *   id bytes (utf8)
 *   payload bytes (opaque remainder)
 *
 * v1 (u32 sequences) is still decoded for mixed-version clients.
 */
export function encodeTerminalDataFrame(
  eventSequence: number,
  terminalSequence: number,
  id: string,
  payload: Uint8Array,
): Uint8Array {
  const idBytes = utf8Encode(id);
  if (idBytes.length > 0xffff) {
    throw new Error("terminal id too long for binary frame");
  }
  const out = new Uint8Array(1 + 8 + 8 + 2 + idBytes.length + payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = TERMINAL_DATA_FRAME_TYPE;
  view.setBigUint64(1, toU64(eventSequence));
  view.setBigUint64(9, toU64(terminalSequence));
  view.setUint16(17, idBytes.length);
  out.set(idBytes, 19);
  out.set(payload, 19 + idBytes.length);
  return out;
}

function toU64(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.trunc(value));
}

export function encodeTerminalInputFrame(
  streamId: number,
  streamEpoch: number,
  sequence: number,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (payload.byteLength === 0) throw new Error("terminal input cannot be empty");
  const output = new Uint8Array(new ArrayBuffer(TERMINAL_PROTOCOL_HEADER_BYTES + payload.byteLength));
  const view = new DataView(output.buffer);
  output[0] = TERMINAL_PROTOCOL_MAGIC_0;
  output[1] = TERMINAL_PROTOCOL_MAGIC_1;
  output[2] = TERMINAL_PROTOCOL_VERSION;
  output[3] = TERMINAL_PROTOCOL_INPUT;
  view.setUint16(4, 0);
  view.setUint16(6, TERMINAL_PROTOCOL_HEADER_BYTES);
  view.setBigUint64(8, toU64(streamId));
  view.setBigUint64(16, toU64(streamEpoch));
  view.setBigUint64(24, toU64(sequence));
  view.setUint32(32, payload.byteLength);
  output.set(payload, TERMINAL_PROTOCOL_HEADER_BYTES);
  return output;
}

export function encodeTerminalScrollbackRequest(
  streamId: number,
  streamEpoch: number,
  sequence: number,
  cursor: number,
  maxBytes: number,
  reverse: boolean,
): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("invalid scrollback cursor");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) {
    throw new Error("invalid scrollback byte limit");
  }
  const output = new Uint8Array(new ArrayBuffer(TERMINAL_PROTOCOL_HEADER_BYTES + 13));
  const view = new DataView(output.buffer);
  output.set([TERMINAL_PROTOCOL_MAGIC_0, TERMINAL_PROTOCOL_MAGIC_1, TERMINAL_PROTOCOL_VERSION, TERMINAL_PROTOCOL_SCROLLBACK_BEGIN]);
  view.setUint16(6, TERMINAL_PROTOCOL_HEADER_BYTES);
  view.setBigUint64(8, toU64(streamId));
  view.setBigUint64(16, toU64(streamEpoch));
  view.setBigUint64(24, toU64(sequence));
  view.setUint32(32, 13);
  view.setBigUint64(36, toU64(cursor));
  view.setUint32(44, maxBytes);
  output[48] = reverse ? 1 : 0;
  return output;
}

export function encodeTerminalResizeFrame(
  streamId: number,
  streamEpoch: number,
  sequence: number,
  cols: number,
  rows: number,
): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 0xffff || rows > 0xffff) {
    throw new Error("invalid terminal resize dimensions");
  }
  const output = new Uint8Array(new ArrayBuffer(TERMINAL_PROTOCOL_HEADER_BYTES + 4));
  const view = new DataView(output.buffer);
  output.set([TERMINAL_PROTOCOL_MAGIC_0, TERMINAL_PROTOCOL_MAGIC_1, TERMINAL_PROTOCOL_VERSION, TERMINAL_PROTOCOL_RESIZE]);
  view.setUint16(6, TERMINAL_PROTOCOL_HEADER_BYTES);
  view.setBigUint64(8, toU64(streamId));
  view.setBigUint64(16, toU64(streamEpoch));
  view.setBigUint64(24, toU64(sequence));
  view.setUint32(32, 4);
  view.setUint16(36, cols);
  view.setUint16(38, rows);
  return output;
}

function fromU64(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(value);
}

export type DecodedTerminalDataFrame = {
  eventSequence: number;
  terminalSequence: number;
  id?: string;
  streamId?: number;
  streamEpoch?: number;
  frameType?:
    | "snapshot"
    | "ready"
    | "pty-data"
    | "scrollback-begin"
    | "scrollback-chunk"
    | "scrollback-end"
    | "resync-begin";
  payload: Uint8Array;
};

export function decodeTerminalDataFrame(
  bytes: ArrayBuffer | ArrayBufferView,
): DecodedTerminalDataFrame | null {
  const buf =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 11) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (
    buf.length >= TERMINAL_PROTOCOL_HEADER_BYTES &&
    buf[0] === TERMINAL_PROTOCOL_MAGIC_0 &&
    buf[1] === TERMINAL_PROTOCOL_MAGIC_1
  ) {
    const frameType = buf[3] === TERMINAL_PROTOCOL_SNAPSHOT
      ? "snapshot" as const
      : buf[3] === 5
        ? "ready" as const
        : buf[3] === TERMINAL_PROTOCOL_PTY_DATA
          ? "pty-data" as const
          : buf[3] === TERMINAL_PROTOCOL_SCROLLBACK_BEGIN
            ? "scrollback-begin" as const
            : buf[3] === TERMINAL_PROTOCOL_SCROLLBACK_CHUNK
              ? "scrollback-chunk" as const
              : buf[3] === TERMINAL_PROTOCOL_SCROLLBACK_END
                ? "scrollback-end" as const
                : buf[3] === 13
                  ? "resync-begin" as const
                  : null;
    if (buf[2] !== TERMINAL_PROTOCOL_VERSION || frameType === null) return null;
    if (view.getUint16(4) !== 0 || view.getUint16(6) !== TERMINAL_PROTOCOL_HEADER_BYTES) return null;
    const payloadLength = view.getUint32(32);
    if (
      (frameType === "snapshot" || frameType === "pty-data" || frameType === "scrollback-chunk") &&
      payloadLength === 0
    ) return null;
    if (buf.length !== TERMINAL_PROTOCOL_HEADER_BYTES + payloadLength) return null;
    const streamId = fromU64(view.getBigUint64(8));
    const streamEpoch = fromU64(view.getBigUint64(16));
    const terminalSequence = fromU64(view.getBigUint64(24));
    if (frameType === "pty-data" && terminalSequence < payloadLength) return null;
    return {
      eventSequence: 0,
      terminalSequence,
      streamId,
      streamEpoch,
      frameType,
      payload: buf.subarray(TERMINAL_PROTOCOL_HEADER_BYTES),
    };
  }
  if (buf[0] === TERMINAL_DATA_FRAME_TYPE) {
    if (buf.length < 19) return null;
    const eventSequence = fromU64(view.getBigUint64(1));
    const terminalSequence = fromU64(view.getBigUint64(9));
    const idLen = view.getUint16(17);
    if (19 + idLen > buf.length) return null;
    const id = utf8Decode(buf.subarray(19, 19 + idLen));
    const payload = buf.subarray(19 + idLen);
    return { eventSequence, terminalSequence, id, payload };
  }
  if (buf[0] !== TERMINAL_DATA_FRAME_TYPE_V1) return null;
  const eventSequence = view.getUint32(1);
  const terminalSequence = view.getUint32(5);
  const idLen = view.getUint16(9);
  if (11 + idLen > buf.length) return null;
  const id = utf8Decode(buf.subarray(11, 11 + idLen));
  const payload = buf.subarray(11 + idLen);
  return { eventSequence, terminalSequence, id, payload };
}

export type TerminalWsAck = {
  type: "terminal:ack";
  terminalId: string;
  sequence: number;
};

export type TerminalReplayRequired = {
  type: "terminal:replay-required";
  terminalId: string;
  sequence: number;
};

export function encodeTerminalWsAck(terminalId: string, sequence: number): string {
  return JSON.stringify({ type: "terminal:ack", terminalId, sequence });
}

export function tryDecodeTerminalWsAck(raw: unknown): TerminalWsAck | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    record.type !== "terminal:ack" ||
    typeof record.terminalId !== "string" ||
    record.terminalId.length === 0 ||
    typeof record.sequence !== "number" ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 0
  ) return null;
  return {
    type: "terminal:ack",
    terminalId: record.terminalId,
    sequence: record.sequence,
  };
}

export function tryDecodeTerminalReplayRequired(
  raw: unknown,
): TerminalReplayRequired | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    record.type !== "terminal:replay-required" ||
    typeof record.terminalId !== "string" ||
    record.terminalId.length === 0 ||
    typeof record.sequence !== "number" ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 0
  ) return null;
  return {
    type: "terminal:replay-required",
    terminalId: record.terminalId,
    sequence: record.sequence,
  };
}

/** Client → host control ops over the event WebSocket (JSON text frames). */
export type TerminalWsHotOp = Extract<
  HostRouteName,
  | "terminal:write"
  | "terminal:writeBinary"
  | "terminal:resize"
  | "terminal:ready"
  | "terminal:detach"
  | "terminal:attach"
>

/** Hot operations are selected from the canonical route registry. */
export const TERMINAL_WS_HOT_OPS = HOST_ROUTE_CHANNELS.filter(
  (channel): channel is TerminalWsHotOp =>
    channel.startsWith("terminal:") && getHostRoute(channel)?.realtime === true,
)

export type TerminalWsCommand = {
  requestId: string;
  op: TerminalWsHotOp;
  args: unknown[];
};

export type TerminalWsResult = {
  type: "terminal:result";
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: { message: string; code?: string };
};

export function isTerminalWsHotOp(value: unknown): value is TerminalWsHotOp {
  return (
    typeof value === "string" &&
    value.startsWith("terminal:") &&
    getHostRoute(value)?.realtime === true
  )
}

export function encodeTerminalWsCommand(
  requestId: string,
  op: TerminalWsHotOp,
  args: unknown[],
): string {
  const cmd: TerminalWsCommand = { requestId, op, args };
  return JSON.stringify(cmd);
}

export function tryDecodeTerminalWsCommand(
  raw: unknown,
): TerminalWsCommand | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.requestId !== "string" ||
    obj.requestId.length === 0 ||
    !isTerminalWsHotOp(obj.op) ||
    !Array.isArray(obj.args)
  )
    return null;
  return { requestId: obj.requestId, op: obj.op, args: obj.args };
}

export function tryDecodeTerminalWsResult(
  raw: unknown,
): TerminalWsResult | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (
    obj.type !== "terminal:result" ||
    typeof obj.requestId !== "string" ||
    typeof obj.ok !== "boolean"
  )
    return null;
  if (obj.ok)
    return {
      type: "terminal:result",
      requestId: obj.requestId,
      ok: true,
      value: obj.value,
    };
  const error = obj.error;
  if (error === null || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record.message !== "string") return null;
  return {
    type: "terminal:result",
    requestId: obj.requestId,
    ok: false,
    error: {
      message: record.message,
      ...(typeof record.code === "string" ? { code: record.code } : {}),
    },
  };
}
