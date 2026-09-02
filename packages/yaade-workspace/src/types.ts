import type {
  AppSession,
  ArchiveSession,
  ArchiveSessionTab,
  CloseTerminal,
  CreateSessionTab,
  CreateTerminal,
  MuxEvent,
  MoveTerminalToTab,
  MuxTerminal,
  MuxTerminalId,
  ReorderSessions,
  ReorderSessionTabs,
  ReorderTerminals,
  RestoreSession,
  SaveSessionTabLayout,
  SelectSessionTab,
  SessionId,
  SessionTab,
  TerminalLease,
} from "@yaade/rpc"

export type MuxSessionSnapshot = {
  session: AppSession
  tabs?: SessionTab[]
  muxTerminals: MuxTerminal[]
}

export type HostMux = {
  listSessions(includeArchived?: boolean): Promise<MuxSessionSnapshot[]>
  reorderSessions(command: ReorderSessions): Promise<AppSession[]>
  createTab(command: CreateSessionTab): Promise<SessionTab>
  renameTab(command: import("@yaade/rpc").RenameSessionTab): Promise<SessionTab>
  saveTabLayout(command: SaveSessionTabLayout): Promise<SessionTab>
  reorderTabs(command: ReorderSessionTabs): Promise<SessionTab[]>
  archiveTab(command: ArchiveSessionTab): Promise<SessionTab>
  selectTab(command: SelectSessionTab): Promise<AppSession>
  archiveSession(command: ArchiveSession): Promise<AppSession>
  restoreSession(command: RestoreSession): Promise<AppSession>
  createSession(title?: string): Promise<AppSession>
  renameSession(sessionId: SessionId, title: string): Promise<AppSession>
  getSession(sessionId: SessionId): Promise<MuxSessionSnapshot | null>
  createTerminal(command: CreateTerminal): Promise<MuxTerminal>
  getTerminal(muxTerminalId: MuxTerminalId): Promise<MuxTerminal | null>
  reorderTerminals(command: ReorderTerminals): Promise<MuxTerminal[]>
  moveTerminal(command: MoveTerminalToTab): Promise<MuxTerminal>
  selectTerminal(sessionId: SessionId, muxTerminalId?: MuxTerminalId): Promise<AppSession>
  stopTerminal(muxTerminalId: MuxTerminalId, revision: number): Promise<MuxTerminal>
  restartTerminal(muxTerminalId: MuxTerminalId, revision: number): Promise<MuxTerminal>
  closeTerminal(command: CloseTerminal): Promise<MuxTerminal>
  renameTerminal(muxTerminalId: MuxTerminalId, title: string): Promise<MuxTerminal>
  onEvent(callback: (event: MuxEvent) => void): () => void
}

export type TerminalReplayChunk = {
  readonly data: Uint8Array
  readonly replayNeedsQueryResponses: boolean
  readonly replayTruncated: boolean
}

export type TerminalAttachOptions = {
  /** A new parser has no continuity with the previous renderer. */
  readonly replay: "resume" | "full"
  /** Paints a bounded newest-tail preview while exact replay catches up. */
  readonly onReplayPreview?: (
    chunk: TerminalReplayChunk,
  ) => void | Promise<void>
  /** Receives bounded, ordered replay pages before live output is released. */
  readonly onReplay?: (
    chunk: TerminalReplayChunk,
  ) => void | Promise<void>
}

export type TerminalTheme = {
  foreground: { r: number; g: number; b: number }
  background: { r: number; g: number; b: number }
  cursor: { r: number; g: number; b: number }
}

export type HostTerminal = {
  create(
    cwdUri: string,
    launch?: {
      command?: string
      args?: string[]
      env?: Record<string, string>
      cols?: number
      rows?: number
      theme?: TerminalTheme
    },
  ): Promise<{ id: string; title?: string }>
  attach(id: string, options?: TerminalAttachOptions): Promise<{
    id: string
    title?: string
    terminalEpoch?: string
    ownerId?: string
    ownerEpoch?: string
    protocolVersion?: number
    checkpoint?: {
      checkpointVersion: 1
      terminalEpoch: string
      sequence: number
      cols: number
      rows: number
      createdAt: string
      syntheticBytes: Uint8Array
    }
    replayQuality?: "exact" | "checkpoint" | "degraded"
    outputChunks?: Uint8Array[]
    output: Uint8Array
    replayTruncated?: boolean
    replayNeedsQueryResponses?: boolean
    archiveAvailable?: boolean
    lastSequence: number
    status: "running" | "exited"
    exitCode?: number
    signal?: number
    semanticSnapshot?: import("@yaade/rpc").TerminalSemanticSnapshot | null
  } | null>
  write(id: string, data: string): Promise<void>
  writeBinary(id: string, dataBase64: string): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  setTheme(id: string, theme: TerminalTheme): Promise<void>
  markReplayReady(id: string): Promise<void>
  getCwd(id: string): Promise<string | null>
  getForegroundProcess(id: string): Promise<string | null>
  onData(
    id: string,
    callback: (
      data: Uint8Array,
      replay?: boolean,
      replayNeedsQueryResponses?: boolean,
      replayTruncated?: boolean,
      acknowledgeConsumed?: () => void,
    ) => void,
    options?: {
      readonly acknowledgement: "delivery" | "consumption"
    },
  ): () => void
  onSemanticSnapshot?(
    id: string,
    callback: (snapshot: import("@yaade/rpc").TerminalSemanticSnapshot) => void,
  ): () => void
  onExit(cb: (id: string, exitCode: number, signal?: number) => void): () => void
  dispose(id: string): Promise<void>
  acquireLease(id: string, mode?: "writer" | "observer"): Promise<TerminalLease | null>
  renewLease(id: string, leaseId: string): Promise<TerminalLease | null>
  releaseLease(id: string, leaseId: string): Promise<void>
  requestControl(id: string): Promise<TerminalLease | null>
  transferControl(
    id: string,
    leaseId: string,
    targetClientId: string,
  ): Promise<TerminalLease | null>
  listViewers(id: string): Promise<string[]>
}

/** Ports exposed to the browser terminal multiplexer. */
export type YaadeHostPorts = {
  mux: HostMux
  terminal: HostTerminal
}

export type YaadeHostAPI = YaadeHostPorts

declare global {
  interface Window {
    yaade?: YaadeHostAPI
  }
}
