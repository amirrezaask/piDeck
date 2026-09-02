import {
  GHOSTTY_RENDER_UPDATE_VERSION,
  validateGhosttyRenderUpdate,
  type GhosttyMouseInput,
  type GhosttyPointInput,
  type GhosttyRenderUpdate,
  type GhosttyRenderUpdateBuffers,
  type GhosttyTheme,
} from "../core.js";

export const TERMINAL_WORKER_PROTOCOL_VERSION = 2 as const;

export type SerializedKeyEvent = {
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly repeat: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
  readonly capsLock: boolean;
  readonly numLock: boolean;
};

type Envelope = {
  readonly version: typeof TERMINAL_WORKER_PROTOCOL_VERSION;
  readonly terminalId: string;
  readonly sequence: number;
  readonly generation: number;
};

export type TerminalWorkerCommandPayload =
  | { readonly type: "create"; readonly cols: number; readonly rows: number; readonly cellWidth: number; readonly cellHeight: number; readonly theme: GhosttyTheme; readonly visible: boolean; readonly focused: boolean }
  | { readonly type: "writeBytes"; readonly data: Uint8Array<ArrayBuffer> }
  | { readonly type: "writeReplayBytes"; readonly chunks: readonly Uint8Array<ArrayBuffer>[] }
  | { readonly type: "resetAndWriteBytes"; readonly data: Uint8Array<ArrayBuffer> }
  | { readonly type: "recycleRenderUpdate"; readonly slotId: number; readonly leaseToken: number; readonly buffers: GhosttyRenderUpdateBuffers }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number; readonly cellWidth: number; readonly cellHeight: number }
  | { readonly type: "setTheme"; readonly theme: GhosttyTheme }
  | { readonly type: "setPresentationState"; readonly visible: boolean; readonly focused: boolean }
  | { readonly type: "setFontMetrics"; readonly cellWidth: number; readonly cellHeight: number }
  | { readonly type: "key"; readonly event: SerializedKeyEvent; readonly action: "press" | "release" }
  | { readonly type: "paste"; readonly data: string }
  | { readonly type: "text"; readonly data: string }
  | { readonly type: "mouse"; readonly input: GhosttyMouseInput }
  | { readonly type: "setSelection"; readonly anchor: GhosttyPointInput; readonly end: GhosttyPointInput }
  | { readonly type: "clearSelection" | "selectAll" | "scrollToBottom" | "requestFullFrame" | "dispose" }
  | { readonly type: "selectWord" | "selectLine" | "viewportPointToScreen" | "screenPointToViewport"; readonly col: number; readonly row: number }
  | { readonly type: "scroll"; readonly delta: number };

export type TerminalWorkerCommand = Envelope & TerminalWorkerCommandPayload;

export type TerminalWorkerDiagnostics = {
  readonly writes: number;
  readonly bytesParsed: number;
  readonly renderBuilds: number;
  readonly transfers: number;
  readonly suppressedHidden: number;
  readonly suppressedSynchronized: number;
  readonly fullCatchUps: number;
  readonly synchronizationTimeouts: number;
  readonly pendingPresentation: boolean;
  readonly slotsInFlight: number;
  readonly bufferAllocations: number;
  readonly renderBytesUsed: number;
  readonly renderBytesAllocated: number;
  readonly renderIdleTrims: number;
  readonly renderIdleBytesReclaimed: number;
  readonly renderIdleRegrows: number;
  readonly schedulerQueueBytes: number;
  readonly schedulerQueueCommands: number;
  readonly schedulerInFlight: number;
};

export type TerminalRuntimeState = {
  readonly title: string;
  readonly scrollbar: { readonly total: number; readonly offset: number; readonly len: number } | null;
  readonly selectionText: string;
  readonly viewportActive: boolean;
  readonly mouseTracking: boolean;
  readonly mouseAnyEventTracking: boolean;
  readonly alternateScreen: boolean;
  readonly applicationCursorKeys: boolean;
  readonly synchronizedOutput: boolean;
};

export type TerminalWorkerEvent = Envelope & (
  | { readonly type: "ready" }
  | { readonly type: "completed" }
  | { readonly type: "packedUpdate"; readonly slotId: number; readonly leaseToken: number; readonly update: GhosttyRenderUpdate; readonly state: TerminalRuntimeState }
  | { readonly type: "encodedInput"; readonly data: string }
  | { readonly type: "parsed"; readonly diagnostics: TerminalWorkerDiagnostics }
  | { readonly type: "selectionResult"; readonly result: unknown }
  | { readonly type: "recoverableError" | "fatalError"; readonly message: string }
  | { readonly type: "disposed" }
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validEnvelope(value: Record<string, unknown>): boolean {
  return value.version === TERMINAL_WORKER_PROTOCOL_VERSION &&
    typeof value.terminalId === "string" && value.terminalId.length > 0 &&
    Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0 &&
    Number.isSafeInteger(value.generation) && Number(value.generation) >= 1;
}

const COMMAND_TYPES = new Set([
  "create", "writeBytes", "writeReplayBytes", "resetAndWriteBytes", "recycleRenderUpdate", "resize", "setTheme", "setPresentationState",
  "setFontMetrics", "key", "paste", "text", "mouse", "setSelection", "clearSelection",
  "selectAll", "selectWord", "selectLine", "scroll", "scrollToBottom",
  "viewportPointToScreen", "screenPointToViewport", "requestFullFrame", "dispose",
]);

export function validateTerminalWorkerCommand(value: unknown): value is TerminalWorkerCommand {
  if (!isRecord(value) || !validEnvelope(value) || !COMMAND_TYPES.has(String(value.type))) return false;
  switch (value.type) {
    case "writeBytes": case "resetAndWriteBytes":
      return value.data instanceof Uint8Array && value.data.byteLength > 0 && value.data.buffer.byteLength > 0;
    case "writeReplayBytes":
      return Array.isArray(value.chunks) && value.chunks.length > 0 &&
        value.chunks.every(chunk => chunk instanceof Uint8Array && chunk.byteLength > 0 && chunk.buffer.byteLength > 0);
    case "recycleRenderUpdate":
      return Number.isSafeInteger(value.slotId) && Number(value.slotId) >= 0 &&
        Number.isSafeInteger(value.leaseToken) && Number(value.leaseToken) >= 1 &&
        validateRenderUpdateBuffers(value.buffers);
    case "paste": case "text": return typeof value.data === "string";
    case "create": case "resize": return Number.isFinite(value.cols) && Number.isFinite(value.rows) && Number.isFinite(value.cellWidth) && Number.isFinite(value.cellHeight) && (value.type !== "create" || (isRecord(value.theme) && typeof value.visible === "boolean" && typeof value.focused === "boolean"));
    case "setTheme": return isRecord(value.theme);
    case "setPresentationState": return typeof value.visible === "boolean" && typeof value.focused === "boolean";
    case "setFontMetrics": return Number.isFinite(value.cellWidth) && Number.isFinite(value.cellHeight);
    case "key": return isRecord(value.event) && (value.action === "press" || value.action === "release");
    case "mouse": return isRecord(value.input);
    case "setSelection": return isRecord(value.anchor) && isRecord(value.end);
    case "selectWord": case "selectLine": case "viewportPointToScreen": case "screenPointToViewport": return Number.isFinite(value.col) && Number.isFinite(value.row);
    case "scroll": return Number.isFinite(value.delta);
    default: return true;
  }
}

function validateDiagnostics(value: unknown): value is TerminalWorkerDiagnostics {
  if (!isRecord(value)) return false;
  const counters = [
    "writes", "bytesParsed", "renderBuilds", "transfers", "suppressedHidden",
    "suppressedSynchronized", "fullCatchUps", "synchronizationTimeouts", "slotsInFlight",
    "bufferAllocations", "renderBytesUsed", "renderBytesAllocated", "renderIdleTrims",
    "renderIdleBytesReclaimed", "renderIdleRegrows", "schedulerQueueBytes",
    "schedulerQueueCommands", "schedulerInFlight",
  ];
  return counters.every(field => Number.isSafeInteger(value[field]) && Number(value[field]) >= 0) &&
    typeof value.pendingPresentation === "boolean";
}

function validateState(value: unknown): value is TerminalRuntimeState {
  return isRecord(value) && typeof value.title === "string" &&
    typeof value.selectionText === "string" && typeof value.viewportActive === "boolean" &&
    typeof value.mouseTracking === "boolean" && typeof value.mouseAnyEventTracking === "boolean" &&
    typeof value.alternateScreen === "boolean" && typeof value.applicationCursorKeys === "boolean" &&
    typeof value.synchronizedOutput === "boolean" &&
    (value.scrollbar === null || (isRecord(value.scrollbar) && Number.isFinite(value.scrollbar.total) && Number.isFinite(value.scrollbar.offset) && Number.isFinite(value.scrollbar.len)));
}

export function validateTerminalWorkerEvent(value: unknown): value is TerminalWorkerEvent {
  if (!isRecord(value) || !validEnvelope(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "ready": case "completed": case "disposed": return true;
    case "parsed": return validateDiagnostics(value.diagnostics);
    case "encodedInput": return typeof value.data === "string";
    case "packedUpdate": return Number.isSafeInteger(value.slotId) && Number(value.slotId) >= 0 &&
      Number.isSafeInteger(value.leaseToken) && Number(value.leaseToken) >= 1 &&
      validateGhosttyRenderUpdate(value.update) && validateState(value.state) &&
      value.update.version === GHOSTTY_RENDER_UPDATE_VERSION;
    case "selectionResult": return "result" in value;
    case "recoverableError": case "fatalError": return typeof value.message === "string";
    default: return false;
  }
}

function validateRenderUpdateBuffers(value: unknown): value is GhosttyRenderUpdateBuffers {
  if (!isRecord(value)) return false
  const fields = ["dirtyRows", "rowFlags", "graphemeOffsets", "graphemeLengths", "foregrounds", "backgrounds", "styles", "graphemes"] as const
  return fields.every(field => value[field] instanceof ArrayBuffer && value[field].byteLength > 0) &&
    value.dirtyRows instanceof ArrayBuffer && value.dirtyRows.byteLength % 4 === 0 &&
    value.graphemeOffsets instanceof ArrayBuffer && value.graphemeOffsets.byteLength % 4 === 0 &&
    value.graphemeLengths instanceof ArrayBuffer && value.graphemeLengths.byteLength % 4 === 0 &&
    value.foregrounds instanceof ArrayBuffer && value.foregrounds.byteLength % 4 === 0 &&
    value.backgrounds instanceof ArrayBuffer && value.backgrounds.byteLength % 4 === 0 &&
    value.styles instanceof ArrayBuffer && value.styles.byteLength % 2 === 0
}

export function terminalRenderUpdateBufferTransferList(buffers: GhosttyRenderUpdateBuffers): Transferable[] {
  return [
    buffers.dirtyRows, buffers.rowFlags, buffers.graphemeOffsets,
    buffers.graphemeLengths, buffers.foregrounds, buffers.backgrounds,
    buffers.styles, buffers.graphemes,
  ]
}

export function terminalByteCommandTransferList(
  command: Extract<TerminalWorkerCommand, { readonly type: "writeBytes" | "writeReplayBytes" | "resetAndWriteBytes" }>,
): Transferable[] {
  return command.type === "writeReplayBytes"
    ? command.chunks.map(chunk => chunk.buffer)
    : [command.data.buffer]
}

export function terminalRenderUpdateTransferList(update: GhosttyRenderUpdate): Transferable[] {
  return [
    update.dirtyRows.buffer, update.rowFlags.buffer, update.graphemeOffsets.buffer,
    update.graphemeLengths.buffer, update.foregrounds.buffer, update.backgrounds.buffer,
    update.styles.buffer, update.graphemes.buffer,
  ];
}

export function serializeKeyboardEvent(event: KeyboardEvent): SerializedKeyEvent {
  return {
    key: event.key, code: event.code, location: event.location, repeat: event.repeat,
    shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey,
    metaKey: event.metaKey, isComposing: event.isComposing,
    capsLock: event.getModifierState("CapsLock"), numLock: event.getModifierState("NumLock"),
  };
}
