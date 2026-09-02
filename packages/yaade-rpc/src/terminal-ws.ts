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

function fromU64(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(value);
}

export type DecodedTerminalDataFrame = {
  eventSequence: number;
  terminalSequence: number;
  id: string;
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
