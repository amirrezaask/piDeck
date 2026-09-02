export type TestState = {
  route: "session"
  activeSessionId?: string | null
  activeTabId?: string | null
  activeMuxTerminalId?: string | null
  sessions?: readonly unknown[]
  tabs?: readonly unknown[]
  muxTerminals?: readonly unknown[]
  connection?: string
}

export type TerminalLifecycleState = {
  surfaceInstanceId: number
  runtimeKind: "worker" | "main"
  runtimeGeneration: number
  rendererBackend: "canvas2d" | "webgl2"
  rendererGeneration: number
  rendererRecoveries: number
  rendererSubmission: {
    backend: "webgl2"
    lastFrame: {
      dirtyRowsBuilt: number
      sceneCopyBytes: number
      sceneUploadBytes: number
      sceneUploadCalls: number
      fullPrimitiveUploads: number
      partialPrimitiveUploads: number
      overlayUploadBytes: number
      drawCalls: number
    }
    cumulative: {
      dirtyRowsBuilt: number
      sceneCopyBytes: number
      sceneUploadBytes: number
      sceneUploadCalls: number
      fullPrimitiveUploads: number
      partialPrimitiveUploads: number
      overlayUploadBytes: number
      drawCalls: number
      frames: number
      rowRebuilds: number
      sceneCompactions: number
      atlasTextureUploads: number
      atlasResets: number
      rowBatchAllocations: number
      currentUsedSceneBytes: number
      currentAllocatedBufferBytes: number
      currentAllocatedCpuBytes: number
      currentTargetTransientBytes: number
      currentAtlasBytes: number
      currentGlyphScratchBytes: number
      idleTrims: number
      idleBytesReclaimed: number
      idleRegrows: number
    }
  } | null
  rendererCpuMs: { samples: number; p50: number; p95: number; p99: number }
  attachCount: number
  resizeCount: number
  geometryGeneration: number
  lastSubmittedModelFrame: number
  lastNextPaintObservedFrame: number
  compatibilitySnapshotBuilds: number
  decodedGraphemes: number
  workerDiagnostics: {
    writes: number
    bytesParsed: number
    renderBuilds: number
    transfers: number
    suppressedHidden: number
    suppressedSynchronized: number
    fullCatchUps: number
    synchronizationTimeouts: number
    pendingPresentation: boolean
    slotsInFlight: number
    bufferAllocations: number
    renderBytesUsed: number
    renderBytesAllocated: number
    renderIdleTrims: number
    renderIdleBytesReclaimed: number
    renderIdleRegrows: number
    schedulerQueueBytes: number
    schedulerQueueCommands: number
    schedulerInFlight: number
  }
}

export type YaadeTestAPI = {
  getState(): TestState
  waitForReady(): Promise<void>
  getPerfMeasures(names?: string[]): { name: string; durationMs: number }[]
  createSession?(): Promise<void>
  selectSession?(sessionId: string): Promise<void>
  createTab?(): Promise<void>
  selectTab?(tabId: string): Promise<void>
  closeTab?(tabId: string): Promise<void>
  createMuxTerminal?(kind: "terminal"): Promise<void>
  selectMuxTerminal?(muxTerminalId: string): Promise<void>
  closeMuxTerminal?(muxTerminalId: string): Promise<void>
  closeSession?(sessionId: string, mode?: "keep-running" | "stop-terminals"): Promise<void>
  getTerminalText(tabId?: string): string
  getTerminalCellHeight(tabId?: string): number
  getTerminalCellSize(tabId?: string): { width: number; height: number } | null
  getTerminalDims(tabId?: string): { cols: number; rows: number } | null
  getTerminalLifecycle(tabId?: string): TerminalLifecycleState | null
  maintainTerminalIdleCapacity(tabId?: string): boolean
  getTerminalPixelStats(tabId?: string): Promise<{
    width: number
    height: number
    nonBackgroundPixels: number
  } | null>
  getTerminalCursor(tabId?: string): { x: number; y: number; hidden: boolean } | null
  getTerminalViewportY(tabId?: string): number | null
  scrollTerminalLines(amount: number, tabId?: string): boolean
  focusTerminal(tabId?: string): boolean
  findTerminalText(needle: string, tabId?: string): { col: number; viewportRow: number; cols: number; rows: number } | null
}

declare global {
  interface Window { __yaadeTest?: YaadeTestAPI }
}
