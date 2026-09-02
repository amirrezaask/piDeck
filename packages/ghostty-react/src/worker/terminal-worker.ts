import { GhosttyTerminalCore, type GhosttyKeyInput } from "../core.js";
import { browserGhosttyWasmSource } from "@yaade/ghostty-core/loaders/browser";
import {
  TERMINAL_WORKER_PROTOCOL_VERSION,
  terminalRenderUpdateTransferList,
  validateTerminalWorkerCommand,
  type SerializedKeyEvent,
  type TerminalRuntimeState,
  type TerminalWorkerDiagnostics,
  type TerminalWorkerCommand,
  type TerminalWorkerEvent,
} from "./protocol.js";

type MutableWorkerCounters = {
  -readonly [Key in Exclude<
    keyof TerminalWorkerDiagnostics,
    "pendingPresentation" | "slotsInFlight" | "bufferAllocations" |
      "renderBytesUsed" | "renderBytesAllocated" | "renderIdleTrims" |
      "renderIdleBytesReclaimed" | "renderIdleRegrows" | "schedulerQueueBytes" |
      "schedulerQueueCommands" | "schedulerInFlight"
  >]: TerminalWorkerDiagnostics[Key]
};

type RuntimeEntry = {
  core: GhosttyTerminalCore;
  generation: number;
  visible: boolean;
  focused: boolean;
  sync: "inactive" | "suppressing" | "timedOut";
  syncTimer: number | null;
  pendingFull: boolean;
  pendingCommand: TerminalWorkerCommand | null;
  diagnostics: MutableWorkerCounters;
  lastActivityAt: number;
};
const SYNCHRONIZED_OUTPUT_TIMEOUT_MS = 1_000;
const runtimes = new Map<string, RuntimeEntry>();
const pendingUpdates = new Map<string, {
  command: TerminalWorkerCommand;
  core: GhosttyTerminalCore;
  forceFull: boolean;
  timer: number;
}>();

function post(event: TerminalWorkerEvent, transfer: Transferable[] = []): void {
  Reflect.apply(globalThis.postMessage, globalThis, [event, transfer]);
}

function envelope(command: TerminalWorkerCommand) {
  return {
    version: TERMINAL_WORKER_PROTOCOL_VERSION,
    terminalId: command.terminalId,
    sequence: command.sequence,
    generation: command.generation,
  } as const;
}

function keyInput(event: SerializedKeyEvent): GhosttyKeyInput {
  return {
    ...event,
    getModifierState: key => key === "CapsLock" ? event.capsLock : key === "NumLock" && event.numLock,
  };
}

function diagnostics(entry: RuntimeEntry): TerminalWorkerDiagnostics {
  const render = entry.core.renderUpdateDiagnostics();
  return {
    ...entry.diagnostics,
    pendingPresentation: entry.pendingCommand !== null,
    slotsInFlight: render.leasesBuilt - render.leasesReclaimed,
    bufferAllocations: render.backingBuffersAllocated,
    renderBytesUsed: render.backingBytesUsed,
    renderBytesAllocated: render.backingBytesAllocated,
    renderIdleTrims: render.idleTrims,
    renderIdleBytesReclaimed: render.idleBytesReclaimed,
    renderIdleRegrows: render.idleRegrows,
    schedulerQueueBytes: 0,
    schedulerQueueCommands: 0,
    schedulerInFlight: 0,
  };
}

function parsed(command: TerminalWorkerCommand, entry: RuntimeEntry): void {
  post({ ...envelope(command), type: "parsed", diagnostics: diagnostics(entry) });
}

function state(core: GhosttyTerminalCore): TerminalRuntimeState {
  return {
    title: core.title(),
    scrollbar: core.scrollbarState(),
    selectionText: core.selectionText(),
    viewportActive: core.isViewportActive(),
    mouseTracking: core.isMouseTracking(),
    mouseAnyEventTracking: core.isMouseAnyEventTracking(),
    alternateScreen: core.isAlternateScreen(),
    applicationCursorKeys: core.isApplicationCursorKeys(),
    synchronizedOutput: core.isModeEnabled(2026),
  };
}

function cancelPendingUpdate(terminalId: string): void {
  const pending = pendingUpdates.get(terminalId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingUpdates.delete(terminalId);
}

function markSuppressed(entry: RuntimeEntry, command: TerminalWorkerCommand, forceFull = false): void {
  cancelPendingUpdate(command.terminalId);
  entry.pendingCommand = command;
  entry.pendingFull ||= forceFull;
}

function armSynchronizedTimeout(entry: RuntimeEntry, command: TerminalWorkerCommand): void {
  if (entry.syncTimer !== null) return;
  entry.syncTimer = setTimeout(() => {
    entry.syncTimer = null;
    const current = runtimes.get(command.terminalId);
    if (current !== entry || current.generation !== command.generation || entry.sync !== "suppressing") return;
    entry.sync = "timedOut";
    entry.diagnostics.synchronizationTimeouts += 1;
    const catchUp = entry.pendingCommand ?? command;
    if (!entry.visible) {
      entry.pendingFull = true;
      return;
    }
    const forceFull = entry.pendingFull;
    entry.pendingCommand = null;
    entry.pendingFull = false;
    entry.diagnostics.fullCatchUps += 1;
    emitOrSchedule(catchUp, entry.core, forceFull);
  }, SYNCHRONIZED_OUTPUT_TIMEOUT_MS);
}

function requestPresentation(command: TerminalWorkerCommand, entry: RuntimeEntry, forceFull = false): void {
  const synchronized = entry.core.isModeEnabled(2026);
  if (!entry.visible) {
    entry.diagnostics.suppressedHidden += 1;
    markSuppressed(entry, command, true);
    if (synchronized && entry.sync === "inactive") {
      entry.sync = "suppressing";
      armSynchronizedTimeout(entry, command);
    } else if (!synchronized && entry.sync !== "inactive") {
      if (entry.syncTimer !== null) clearTimeout(entry.syncTimer);
      entry.syncTimer = null;
      entry.sync = "inactive";
    }
    return;
  }
  if (synchronized) {
    entry.diagnostics.suppressedSynchronized += 1;
    if (entry.sync === "inactive" || entry.sync === "timedOut") {
      entry.sync = "suppressing";
      armSynchronizedTimeout(entry, command);
    }
    markSuppressed(entry, command, forceFull);
    return;
  }
  if (!synchronized && entry.sync === "suppressing") {
    if (entry.syncTimer !== null) clearTimeout(entry.syncTimer);
    entry.syncTimer = null;
    entry.sync = "inactive";
    const catchUp = entry.pendingCommand ?? command;
    const catchUpFull = entry.pendingFull || forceFull;
    entry.pendingCommand = null;
    entry.pendingFull = false;
    entry.diagnostics.fullCatchUps += 1;
    emitOrSchedule(catchUp, entry.core, catchUpFull);
    return;
  }
  if (!synchronized && entry.sync === "timedOut") {
    entry.sync = "inactive";
  }
  const catchingUp = entry.pendingCommand !== null || entry.pendingFull;
  entry.pendingCommand = null;
  const catchUpFull = entry.pendingFull || forceFull;
  entry.pendingFull = false;
  if (catchingUp) entry.diagnostics.fullCatchUps += 1;
  emitOrSchedule(command, entry.core, catchUpFull);
}

function emitUpdate(command: TerminalWorkerCommand, core: GhosttyTerminalCore, forceFull = false): boolean {
  const lease = core.tryRenderUpdate(true, forceFull)
  if (!lease) return false
  const entry = runtimes.get(command.terminalId);
  if (entry) {
    entry.diagnostics.renderBuilds += 1;
    entry.diagnostics.transfers += 1;
  }
  post(
    {
      ...envelope(command), type: "packedUpdate", slotId: lease.slotId,
      leaseToken: lease.leaseToken, update: lease.update, state: state(core),
    },
    terminalRenderUpdateTransferList(lease.update),
  )
  return true
}

function emitOrSchedule(command: TerminalWorkerCommand, core: GhosttyTerminalCore, forceFull = false): void {
  if (!emitUpdate(command, core, forceFull)) scheduleUpdate(command, core, forceFull)
}

function scheduleUpdate(command: TerminalWorkerCommand, core: GhosttyTerminalCore, forceFull = false): void {
  const pending = pendingUpdates.get(command.terminalId);
  if (pending) {
    pending.command = command;
    pending.forceFull ||= forceFull;
    if (pending.timer === 0) armPendingUpdate(pending)
    return;
  }
  const entry = { command, core, forceFull, timer: 0 };
  pendingUpdates.set(command.terminalId, entry);
  armPendingUpdate(entry)
}

function armPendingUpdate(entry: {
  command: TerminalWorkerCommand
  core: GhosttyTerminalCore
  forceFull: boolean
  timer: number
}): void {
  entry.timer = setTimeout(() => {
    pendingUpdates.delete(entry.command.terminalId)
    const runtime = runtimes.get(entry.command.terminalId)
    if (!runtime || runtime.generation !== entry.command.generation) return
    if (!runtime.visible || runtime.sync === "suppressing") {
      runtime.pendingCommand = entry.command
      runtime.pendingFull ||= entry.forceFull || !runtime.visible
      return
    }
    if (!emitUpdate(entry.command, entry.core, entry.forceFull)) {
      entry.timer = 0
      pendingUpdates.set(entry.command.terminalId, entry)
    }
  }, 0)
}

async function create(command: Extract<TerminalWorkerCommand, { type: "create" }>): Promise<void> {
  const previous = runtimes.get(command.terminalId);
  if (previous?.syncTimer !== null && previous?.syncTimer !== undefined) clearTimeout(previous.syncTimer);
  cancelPendingUpdate(command.terminalId);
  previous?.core.dispose();
  const core = await GhosttyTerminalCore.create(
    command.cols, command.rows, command.cellWidth, command.cellHeight,
    command.theme, () => undefined, browserGhosttyWasmSource(), "render-only",
  );
  const entry: RuntimeEntry = {
    core,
    generation: command.generation,
    visible: command.visible,
    focused: command.focused,
    sync: "inactive",
    syncTimer: null,
    pendingFull: !command.visible,
    pendingCommand: command.visible ? null : command,
    diagnostics: {
      writes: 0, bytesParsed: 0, renderBuilds: 0, transfers: 0,
      suppressedHidden: 0, suppressedSynchronized: 0, fullCatchUps: 0,
      synchronizationTimeouts: 0,
    },
    lastActivityAt: performance.now(),
  };
  runtimes.set(command.terminalId, entry);
  post({ ...envelope(command), type: "ready" });
  if (command.visible) emitOrSchedule(command, core);
}

function process(command: TerminalWorkerCommand, entry: RuntimeEntry): void {
  const { core } = entry;
  if (command.type !== "recycleRenderUpdate") entry.lastActivityAt = performance.now();
  switch (command.type) {
    case "writeBytes":
      entry.diagnostics.writes += 1; entry.diagnostics.bytesParsed += command.data.byteLength;
      core.write(command.data); requestPresentation(command, entry); parsed(command, entry); return;
    case "writeReplayBytes":
      entry.diagnostics.writes += 1;
      entry.diagnostics.bytesParsed += command.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      core.writeReplay(command.chunks); requestPresentation(command, entry); parsed(command, entry); return;
    case "resetAndWriteBytes":
      entry.diagnostics.writes += 1; entry.diagnostics.bytesParsed += command.data.byteLength;
      core.resetAndWrite(command.data); requestPresentation(command, entry, true); parsed(command, entry); return;
    case "recycleRenderUpdate": {
      if (core.reclaimRenderUpdate(command.slotId, command.leaseToken, command.buffers)) {
        const pending = pendingUpdates.get(command.terminalId)
        if (pending && pending.timer === 0 && entry.visible && entry.sync !== "suppressing") armPendingUpdate(pending)
      }
      return
    }
    case "resize": cancelPendingUpdate(command.terminalId); core.resize(command.cols, command.rows, command.cellWidth, command.cellHeight); requestPresentation(command, entry, true); return;
    case "setTheme": cancelPendingUpdate(command.terminalId); core.setTheme(command.theme); requestPresentation(command, entry, true); return;
    case "setPresentationState": {
      if (entry.visible === command.visible && entry.focused === command.focused) return;
      const wasVisible = entry.visible;
      entry.visible = command.visible;
      entry.focused = command.focused;
      if (!command.visible) {
        cancelPendingUpdate(command.terminalId);
        entry.pendingCommand = command;
        entry.pendingFull = true;
        return;
      }
      if (!wasVisible) requestPresentation(command, entry, true);
      return;
    }
    case "setFontMetrics": return;
    case "key": post({ ...envelope(command), type: "encodedInput", data: core.encodeKey(keyInput(command.event), command.action) }); return;
    case "paste": post({ ...envelope(command), type: "encodedInput", data: core.encodePaste(command.data) }); return;
    case "text": post({ ...envelope(command), type: "encodedInput", data: command.data }); return;
    case "mouse": post({ ...envelope(command), type: "encodedInput", data: core.encodeMouse(command.input) }); return;
    case "setSelection": core.setSelection(command.anchor, command.end); requestPresentation(command, entry); return;
    case "clearSelection": core.clearSelection(); requestPresentation(command, entry); return;
    case "selectAll": core.selectAll(); requestPresentation(command, entry); return;
    case "selectWord": post({ ...envelope(command), type: "selectionResult", result: core.selectWord(command.col, command.row) }); requestPresentation(command, entry); return;
    case "selectLine": post({ ...envelope(command), type: "selectionResult", result: core.selectLine(command.col, command.row) }); requestPresentation(command, entry); return;
    case "scroll": core.scroll(command.delta); requestPresentation(command, entry); return;
    case "scrollToBottom": core.scrollToBottom(); requestPresentation(command, entry); return;
    case "viewportPointToScreen": post({ ...envelope(command), type: "selectionResult", result: core.viewportPointToScreen(command.col, command.row) }); return;
    case "screenPointToViewport": post({ ...envelope(command), type: "selectionResult", result: core.screenPointToViewport(command.col, command.row) }); return;
    case "requestFullFrame": requestPresentation(command, entry, true); return;
    case "dispose": {
      cancelPendingUpdate(command.terminalId);
      if (entry.syncTimer !== null) clearTimeout(entry.syncTimer);
      entry.syncTimer = null;
      core.dispose();
      runtimes.delete(command.terminalId);
      post({ ...envelope(command), type: "disposed" });
      return;
    }
    case "create": return;
  }
}

setInterval(() => {
  const now = performance.now();
  for (const [terminalId, entry] of runtimes) {
    if (pendingUpdates.has(terminalId) || entry.pendingCommand !== null) continue;
    entry.core.trimRenderBuffers(entry.lastActivityAt, now);
  }
}, 10_000);

globalThis.addEventListener("message", (message: MessageEvent<unknown>) => {
  const command = message.data;
  if (!validateTerminalWorkerCommand(command)) return;
  if (command.type === "create") {
    void create(command).catch(error => post({
      ...envelope(command), type: "fatalError",
      message: error instanceof Error ? error.message : String(error),
    }));
    return;
  }
  const entry = runtimes.get(command.terminalId);
  if (!entry || entry.generation !== command.generation) return;
  try {
    process(command, entry);
    post({ ...envelope(command), type: "completed" });
  } catch (error) {
    post({
      ...envelope(command), type: "recoverableError",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
