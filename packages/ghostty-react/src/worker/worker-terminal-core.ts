import {
  GhosttyTerminalCore,
  ghosttyRenderUpdateBuffers,
  type GhosttyMouseInput,
  type GhosttyPointInput,
  type GhosttyRenderUpdate,
  type GhosttyResponsePolicy,
  type GhosttyScrollbar,
  type GhosttySelectionRange,
  type GhosttyTheme,
} from "../core.js";
import { browserGhosttyWasmSource } from "@yaade/ghostty-core/loaders/browser";
import {
  serializeKeyboardEvent,
  terminalByteCommandTransferList,
  terminalRenderUpdateBufferTransferList,
  TERMINAL_WORKER_PROTOCOL_VERSION,
  validateTerminalWorkerCommand,
  validateTerminalWorkerEvent,
  type TerminalRuntimeState,
  type TerminalWorkerDiagnostics,
  type TerminalWorkerCommandPayload,
} from "./protocol.js";
import { terminalWorkerPool, type TerminalWorkerChannel } from "./worker-pool.js";

export type TerminalRuntimeKind = "worker" | "main";
export type ParsedCallback = () => void;

export interface TerminalCoreRuntime {
  readonly kind: TerminalRuntimeKind;
  readonly runtimeGeneration: number;
  write(data: string | Uint8Array, parsed?: ParsedCallback): void;
  writeReplay(chunks: readonly Uint8Array[], parsed?: ParsedCallback): void;
  resetAndWrite(data: string | Uint8Array, parsed?: ParsedCallback): void;
  resize(cols: number, rows: number, cellWidth: number, cellHeight: number): void;
  setTheme(theme: GhosttyTheme): void;
  setPresentationState(visible: boolean, focused: boolean): void;
  workerDiagnostics(): TerminalWorkerDiagnostics;
  scroll(delta: number): void;
  scrollToBottom(): void;
  isViewportActive(): boolean;
  scrollbarState(): GhosttyScrollbar | null;
  isMouseTracking(): boolean;
  isMouseAnyEventTracking(): boolean;
  isAlternateScreen(): boolean;
  isApplicationCursorKeys(): boolean;
  isModeEnabled(mode: number): boolean;
  encodeKey(event: KeyboardEvent, action?: "press" | "release"): string;
  encodePaste(data: string): string;
  sendText(data: string): string;
  encodeMouse(input: GhosttyMouseInput): string;
  setSelection(anchor: GhosttyPointInput, end: GhosttyPointInput): void;
  clearSelection(): void;
  selectAll(): void;
  selectWord(col: number, row: number): GhosttySelectionRange | null;
  selectLine(col: number, row: number): GhosttySelectionRange | null;
  selectionText(): string;
  viewportPointToScreen(col: number, row: number): { x: number; y: number } | null;
  screenPointToViewport(col: number, row: number): { x: number; y: number } | null;
  title(): string;
  hyperlinkAt(col: number, row: number): string | null;
  drainRenderUpdates(): readonly GhosttyRenderUpdate[];
  releaseRenderUpdate(update: GhosttyRenderUpdate): void;
  requestFullFrame(): void;
  dispose(): void;
}

export class MainThreadTerminalCore implements TerminalCoreRuntime {
  readonly kind = "main" as const;
  readonly runtimeGeneration = 1;
  private constructor(private readonly core: GhosttyTerminalCore) {}

  static async create(options: RuntimeCreateOptions): Promise<MainThreadTerminalCore> {
    return new MainThreadTerminalCore(await GhosttyTerminalCore.create(
      options.cols, options.rows, options.cellWidth, options.cellHeight, options.theme,
      options.onData, browserGhosttyWasmSource(), options.responsePolicy,
    ));
  }
  write(data: string | Uint8Array, parsed?: ParsedCallback): void { this.core.write(data); parsed?.(); }
  writeReplay(chunks: readonly Uint8Array[], parsed?: ParsedCallback): void { this.core.writeReplay(chunks); parsed?.(); }
  resetAndWrite(data: string | Uint8Array, parsed?: ParsedCallback): void { this.core.resetAndWrite(data); parsed?.(); }
  resize(cols: number, rows: number, cellWidth: number, cellHeight: number): void { this.core.resize(cols, rows, cellWidth, cellHeight); }
  setTheme(theme: GhosttyTheme): void { this.core.setTheme(theme); }
  setPresentationState(): void {}
  workerDiagnostics(): TerminalWorkerDiagnostics { return EMPTY_DIAGNOSTICS; }
  scroll(delta: number): void { this.core.scroll(delta); }
  scrollToBottom(): void { this.core.scrollToBottom(); }
  isViewportActive(): boolean { return this.core.isViewportActive(); }
  scrollbarState(): GhosttyScrollbar | null { return this.core.scrollbarState(); }
  isMouseTracking(): boolean { return this.core.isMouseTracking(); }
  isMouseAnyEventTracking(): boolean { return this.core.isMouseAnyEventTracking(); }
  isAlternateScreen(): boolean { return this.core.isAlternateScreen(); }
  isApplicationCursorKeys(): boolean { return this.core.isApplicationCursorKeys(); }
  isModeEnabled(mode: number): boolean { return this.core.isModeEnabled(mode); }
  encodeKey(event: KeyboardEvent, action: "press" | "release" = "press"): string { return this.core.encodeKey(event, action); }
  encodePaste(data: string): string { return this.core.encodePaste(data); }
  sendText(data: string): string { return data; }
  encodeMouse(input: GhosttyMouseInput): string { return this.core.encodeMouse(input); }
  setSelection(anchor: GhosttyPointInput, end: GhosttyPointInput): void { this.core.setSelection(anchor, end); }
  clearSelection(): void { this.core.clearSelection(); }
  selectAll(): void { this.core.selectAll(); }
  selectWord(col: number, row: number): GhosttySelectionRange | null { return this.core.selectWord(col, row); }
  selectLine(col: number, row: number): GhosttySelectionRange | null { return this.core.selectLine(col, row); }
  selectionText(): string { return this.core.selectionText(); }
  viewportPointToScreen(col: number, row: number): { x: number; y: number } | null { return this.core.viewportPointToScreen(col, row); }
  screenPointToViewport(col: number, row: number): { x: number; y: number } | null { return this.core.screenPointToViewport(col, row); }
  title(): string { return this.core.title(); }
  hyperlinkAt(col: number, row: number): string | null { return this.core.hyperlinkAt(col, row); }
  drainRenderUpdates(): readonly GhosttyRenderUpdate[] { return [this.core.renderUpdate()]; }
  releaseRenderUpdate(update: GhosttyRenderUpdate): void { this.core.releaseRenderUpdate(update); }
  requestFullFrame(): void {}
  dispose(): void { this.core.dispose(); }
}

export type RuntimeCreateOptions = {
  readonly cols: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly theme: GhosttyTheme;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly responsePolicy?: GhosttyResponsePolicy;
  readonly onData: (data: string) => void;
  readonly onUpdate: () => void;
  readonly onError: (error: Error) => void;
  readonly onRecoveryRequired?: () => void;
};

const EMPTY_DIAGNOSTICS: TerminalWorkerDiagnostics = {
  writes: 0, bytesParsed: 0, renderBuilds: 0, transfers: 0,
  suppressedHidden: 0, suppressedSynchronized: 0, fullCatchUps: 0,
  synchronizationTimeouts: 0, pendingPresentation: false, slotsInFlight: 0,
  bufferAllocations: 0, renderBytesUsed: 0, renderBytesAllocated: 0,
  renderIdleTrims: 0, renderIdleBytesReclaimed: 0, renderIdleRegrows: 0,
  schedulerQueueBytes: 0, schedulerQueueCommands: 0, schedulerInFlight: 0,
};

const EMPTY_STATE: TerminalRuntimeState = {
  title: "", scrollbar: null, selectionText: "", viewportActive: true,
  mouseTracking: false, mouseAnyEventTracking: false, alternateScreen: false,
  applicationCursorKeys: false, synchronizedOutput: false,
};
let nextTerminalId = 1;
const localTextEncoder = new TextEncoder()

function ownedTerminalBytes(data: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const source = typeof data === "string" ? localTextEncoder.encode(data) : data
  const owned = new Uint8Array(source.byteLength)
  owned.set(source)
  return owned
}

export class WorkerTerminalCore implements TerminalCoreRuntime {
  readonly kind = "worker" as const;
  private readonly terminalId = `terminal-${nextTerminalId++}`;
  private readonly channel: TerminalWorkerChannel;
  private sequence = 0;
  private generation = 1;
  get runtimeGeneration(): number { return this.generation; }
  private lastEventSequence = 0;
  private state: TerminalRuntimeState = EMPTY_STATE;
  private diagnostics: TerminalWorkerDiagnostics = EMPTY_DIAGNOSTICS;
  private presentation: { visible: boolean; focused: boolean };
  private readonly updates: GhosttyRenderUpdate[] = [];
  private readonly updateLeases = new WeakMap<GhosttyRenderUpdate, {
    readonly slotId: number
    readonly leaseToken: number
    released: boolean
  }>()
  private readonly parsed = new Map<number, ParsedCallback>();
  private disposed = false;
  private recovering = false;
  private initializationReject: ((error: Error) => void) | null = null;

  private constructor(private readonly options: RuntimeCreateOptions) {
    this.presentation = { visible: options.visible, focused: options.focused };
    this.channel = terminalWorkerPool().acquire(
      this.terminalId,
      value => this.receive(value),
      error => this.fail(error),
    );
  }

  static create(options: RuntimeCreateOptions): Promise<WorkerTerminalCore> {
    const runtime = new WorkerTerminalCore(options);
    return new Promise((resolve, reject) => {
      runtime.initializationReject = reject;
      const timeout = window.setTimeout(() => {
        runtime.initializationReject = null;
        runtime.dispose();
        reject(new Error("Terminal worker initialization timed out"));
      }, 3_000);
      const ready = (value: unknown) => {
        if (!validateTerminalWorkerEvent(value) || value.type !== "ready" || value.terminalId !== runtime.terminalId) return;
        window.clearTimeout(timeout);
        runtime.readyListener = null;
        runtime.initializationReject = null;
        resolve(runtime);
      };
      runtime.readyListener = ready;
      runtime.send({
        type: "create", cols: options.cols, rows: options.rows,
        cellWidth: options.cellWidth, cellHeight: options.cellHeight, theme: options.theme,
        visible: options.visible, focused: options.focused,
      });
    });
  }

  private readyListener: ((value: unknown) => void) | null = null;
  private send(payload: TerminalWorkerCommandPayload): number {
    const sequence = ++this.sequence;
    const command: unknown = {
      ...payload,
      version: TERMINAL_WORKER_PROTOCOL_VERSION,
      terminalId: this.terminalId,
      sequence,
      generation: this.generation,
    };
    if (!validateTerminalWorkerCommand(command)) {
      throw new Error("Invalid terminal worker command");
    }
    const transfer = command.type === "writeBytes" ||
      command.type === "writeReplayBytes" || command.type === "resetAndWriteBytes"
      ? terminalByteCommandTransferList(command)
      : command.type === "recycleRenderUpdate"
        ? terminalRenderUpdateBufferTransferList(command.buffers)
        : []
    this.channel.post(command, transfer);
    return sequence;
  }

  private receive(value: unknown): void {
    this.readyListener?.(value);
    if (!validateTerminalWorkerEvent(value) || this.disposed || value.terminalId !== this.terminalId || value.generation !== this.generation) return;
    // Packed frames have their own model frame/generation fence and may finish
    // after a later control completion. Other event families stay strict FIFO.
    if (value.type !== "packedUpdate" && value.sequence < this.lastEventSequence) return;
    if (value.type !== "packedUpdate") this.lastEventSequence = value.sequence;
    switch (value.type) {
      case "packedUpdate":
        this.state = value.state;
        this.updateLeases.set(value.update, {
          slotId: value.slotId,
          leaseToken: value.leaseToken,
          released: false,
        })
        this.updates.push(value.update);
        if (this.updates.length > 3) {
          const discarded = this.updates.shift()
          if (discarded) this.releaseRenderUpdate(discarded)
        }
        this.options.onUpdate();
        return;
      case "encodedInput": if (value.data.length > 0) this.options.onData(value.data); return;
      case "parsed":
        this.diagnostics = value.diagnostics;
        this.parsed.get(value.sequence)?.(); this.parsed.delete(value.sequence); return;
      case "fatalError": case "recoverableError": this.fail(new Error(value.message)); return;
      default: return;
    }
  }

  private fail(error: Error): void {
    if (this.disposed || this.recovering) return;
    const rejectInitialization = this.initializationReject;
    if (rejectInitialization !== null) {
      this.initializationReject = null;
      this.readyListener = null;
      this.disposed = true;
      this.channel.release();
      rejectInitialization(error);
      return;
    }
    this.recovering = true;
    this.parsed.clear();
    this.updates.length = 0;
    this.state = EMPTY_STATE;
    this.generation += 1;
    this.sequence = 0;
    this.lastEventSequence = 0;
    this.options.onError(error);
    this.readyListener = value => {
      if (!validateTerminalWorkerEvent(value) || value.type !== "ready" ||
        value.terminalId !== this.terminalId || value.generation !== this.generation) return;
      this.readyListener = null;
      this.recovering = false;
      this.options.onRecoveryRequired?.();
    };
    this.send({
      type: "create",
      cols: this.options.cols,
      rows: this.options.rows,
      cellWidth: this.options.cellWidth,
      cellHeight: this.options.cellHeight,
      theme: this.options.theme,
      visible: this.presentation.visible,
      focused: this.presentation.focused,
    });
  }

  private command(payload: TerminalWorkerCommandPayload, parsed?: ParsedCallback): void {
    if (this.disposed || this.recovering) return;
    const sequence = this.send(payload);
    if (parsed) this.parsed.set(sequence, parsed);
  }

  write(data: string | Uint8Array, parsed?: ParsedCallback): void {
    const owned = ownedTerminalBytes(data)
    this.command({ type: "writeBytes", data: owned }, parsed)
  }
  writeReplay(chunks: readonly Uint8Array[], parsed?: ParsedCallback): void {
    const owned = chunks.filter(chunk => chunk.byteLength > 0).map(ownedTerminalBytes)
    if (owned.length === 0) { parsed?.(); return }
    this.command({ type: "writeReplayBytes", chunks: owned }, parsed)
  }
  resetAndWrite(data: string | Uint8Array, parsed?: ParsedCallback): void {
    const owned = ownedTerminalBytes(data)
    this.command({ type: "resetAndWriteBytes", data: owned }, parsed)
  }
  resize(cols: number, rows: number, cellWidth: number, cellHeight: number): void { this.command({ type: "resize", cols, rows, cellWidth, cellHeight }); }
  setTheme(theme: GhosttyTheme): void { this.command({ type: "setTheme", theme }); }
  setPresentationState(visible: boolean, focused: boolean): void {
    if (this.presentation.visible === visible && this.presentation.focused === focused) return;
    this.presentation = { visible, focused };
    this.command({ type: "setPresentationState", visible, focused });
  }
  scroll(delta: number): void { this.command({ type: "scroll", delta }); }
  scrollToBottom(): void { this.command({ type: "scrollToBottom" }); }
  isViewportActive(): boolean { return this.state.viewportActive; }
  scrollbarState(): GhosttyScrollbar | null { return this.state.scrollbar; }
  isMouseTracking(): boolean { return this.state.mouseTracking; }
  isMouseAnyEventTracking(): boolean { return this.state.mouseAnyEventTracking; }
  isAlternateScreen(): boolean { return this.state.alternateScreen; }
  isApplicationCursorKeys(): boolean { return this.state.applicationCursorKeys; }
  isModeEnabled(mode: number): boolean { return mode === 2026 ? this.state.synchronizedOutput : false; }
  encodeKey(event: KeyboardEvent, action: "press" | "release" = "press"): string { this.command({ type: "key", event: serializeKeyboardEvent(event), action }); return ""; }
  encodePaste(data: string): string { this.command({ type: "paste", data }); return ""; }
  sendText(data: string): string { this.command({ type: "text", data }); return ""; }
  encodeMouse(input: GhosttyMouseInput): string { this.command({ type: "mouse", input }); return ""; }
  setSelection(anchor: GhosttyPointInput, end: GhosttyPointInput): void { this.command({ type: "setSelection", anchor, end }); }
  clearSelection(): void { this.command({ type: "clearSelection" }); }
  selectAll(): void { this.command({ type: "selectAll" }); }
  selectWord(col: number, row: number): GhosttySelectionRange | null { this.command({ type: "selectWord", col, row }); return null; }
  selectLine(col: number, row: number): GhosttySelectionRange | null { this.command({ type: "selectLine", col, row }); return null; }
  selectionText(): string { return this.state.selectionText; }
  viewportPointToScreen(col: number, row: number): { x: number; y: number } { return { x: col, y: row + (this.state.scrollbar?.offset ?? 0) }; }
  screenPointToViewport(col: number, row: number): { x: number; y: number } | null { const y = row - (this.state.scrollbar?.offset ?? 0); return y < 0 ? null : { x: col, y }; }
  title(): string { return this.state.title; }
  hyperlinkAt(): string | null { return null; }
  drainRenderUpdates(): readonly GhosttyRenderUpdate[] { return this.updates.splice(0); }
  releaseRenderUpdate(update: GhosttyRenderUpdate): void {
    const lease = this.updateLeases.get(update)
    if (!lease || lease.released || this.disposed || this.recovering) return
    lease.released = true
    const buffers = ghosttyRenderUpdateBuffers(update)
    this.command({
      type: "recycleRenderUpdate",
      slotId: lease.slotId,
      leaseToken: lease.leaseToken,
      buffers,
    })
  }
  requestFullFrame(): void { this.command({ type: "requestFullFrame" }); }
  workerDiagnostics(): TerminalWorkerDiagnostics {
    const scheduler = this.channel.schedulerSnapshot()
    return {
      ...this.diagnostics,
      schedulerQueueBytes: scheduler.bytes,
      schedulerQueueCommands: scheduler.commands,
      schedulerInFlight: scheduler.inFlight,
    }
  }
  dispose(): void {
    if (this.disposed) return;
    for (const update of this.updates.splice(0)) this.releaseRenderUpdate(update)
    this.command({ type: "dispose" });
    this.disposed = true;
    this.parsed.clear();
    this.channel.release();
  }
}
