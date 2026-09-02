import { Schema } from "effect"
import {
  TerminalPatchMessage,
  TerminalResyncRequiredMessage,
  TerminalSnapshotMessage,
  type TerminalStreamV3Message as TerminalStreamV3MessageType,
} from "./terminal-stream-v3.js"

export const TERMINAL_STREAM_V3_VERSION = 3
export const MAX_TERMINAL_STREAM_V3_BYTES = 8 * 1024 * 1024

const KIND_SNAPSHOT = 1
const KIND_PATCH = 2
const KIND_RESYNC = 3

function kindFor(message: TerminalStreamV3MessageType): number {
  switch (message.type) {
    case "terminal.snapshot":
      return KIND_SNAPSHOT
    case "terminal.patch":
      return KIND_PATCH
    case "terminal.resync-required":
      return KIND_RESYNC
  }
}

export function encodeTerminalStreamV3(message: TerminalStreamV3MessageType): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message))
  if (payload.byteLength > MAX_TERMINAL_STREAM_V3_BYTES) {
    throw new Error("terminal stream v3 payload is too large")
  }
  const frame = new Uint8Array(6 + payload.byteLength)
  frame[0] = TERMINAL_STREAM_V3_VERSION
  frame[1] = kindFor(message)
  new DataView(frame.buffer).setUint32(2, payload.byteLength)
  frame.set(payload, 6)
  return frame
}

export function decodeTerminalStreamV3(
  input: ArrayBuffer | ArrayBufferView,
): TerminalStreamV3MessageType | null {
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  if (bytes.byteLength < 6 || bytes[0] !== TERMINAL_STREAM_V3_VERSION) return null
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2)
  if (size > MAX_TERMINAL_STREAM_V3_BYTES || bytes.byteLength !== size + 6) return null
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes.subarray(6)))
  } catch {
    return null
  }
  const kind = bytes[1]
  try {
    if (kind === KIND_SNAPSHOT) return Schema.decodeUnknownSync(TerminalSnapshotMessage)(raw)
    if (kind === KIND_PATCH) return Schema.decodeUnknownSync(TerminalPatchMessage)(raw)
    if (kind === KIND_RESYNC) return Schema.decodeUnknownSync(TerminalResyncRequiredMessage)(raw)
    return null
  } catch {
    return null
  }
}
