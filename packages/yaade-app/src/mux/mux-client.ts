import type {
  AppSession,
  ArchiveSessionTab,
  CloseTerminal,
  SessionId,
  SessionTab,
  SessionTabId,
  MuxTerminal,
  MuxTerminalId,
} from "@yaade/rpc"
import type { HostMux, MuxSessionSnapshot } from "@yaade/workspace"
import {
  MuxSessionStore,
  type MuxRevisionGap,
} from "./mux-store.js"

type TerminalApi = HostMux

type MuxClientOptions = {
  readonly api?: TerminalApi
  readonly store?: MuxSessionStore
  readonly window?: Pick<Window, "addEventListener" | "removeEventListener">
}

function terminalApi(api?: TerminalApi): TerminalApi {
  if (api) return api
  const value = globalThis.window?.yaade?.mux
  if (!value) throw new Error("Multiplexer API is unavailable")
  return value
}

/** Browser boundary for the host-owned Session/MuxTerminal control plane. */
export class MuxClient {
  readonly store: MuxSessionStore
  private readonly api: TerminalApi
  private readonly eventWindow: Pick<Window, "addEventListener" | "removeEventListener">
  private disposeEvents: (() => void) | undefined
  private disposed = false
  private reconcilePromise: Promise<void> | undefined
  private readonly revisionGapHandler = (gap: MuxRevisionGap): void => {
    void this.reconcileGap(gap)
  }

  constructor(options: MuxClientOptions = {}) {
    this.store = options.store ?? new MuxSessionStore()
    this.api = terminalApi(options.api)
    this.eventWindow = options.window ?? globalThis.window ?? {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }
    this.store.setRevisionGapHandler(this.revisionGapHandler)
  }

  start(): () => void {
    this.disposed = false
    this.store.setRevisionGapHandler(this.revisionGapHandler)
    if (this.disposeEvents) return this.disposeEvents
    const disposeMuxEvents = this.api.onEvent(event => this.store.apply(event))
    const onReconnect = () => { void this.reconcile() }
    const onReplayGap = () => { void this.reconcile() }
    const onRuntimeSnapshot = () => {
      // Runtime snapshots are emitted by individual transports, while this
      // client may aggregate multiple servers. Re-fetch through the scoped API
      // instead of applying the unscoped wire snapshot directly.
      void this.reconcile().catch(() => undefined)
    }
    this.eventWindow.addEventListener("yaade:host-reconnected", onReconnect)
    this.eventWindow.addEventListener("yaade:host-replay-gap", onReplayGap)
    this.eventWindow.addEventListener("yaade:runtime-snapshot", onRuntimeSnapshot)
    this.disposeEvents = () => {
      disposeMuxEvents()
      this.eventWindow.removeEventListener("yaade:host-reconnected", onReconnect)
      this.eventWindow.removeEventListener("yaade:host-replay-gap", onReplayGap)
      this.eventWindow.removeEventListener("yaade:runtime-snapshot", onRuntimeSnapshot)
      this.disposeEvents = undefined
    }
    return this.disposeEvents
  }

  async hydrate(includeArchived = false): Promise<void> {
    if (this.disposed) return
    const baseline = this.store.captureRevisions()
    if (this.store.getSnapshot().connection !== "offline") {
      this.store.setConnection("reconciling")
    }
    try {
      const snapshots = await this.api.listSessions(includeArchived)
      if (this.disposed) return
      this.replaceSnapshots(snapshots, baseline)
      this.store.setConnection("connected")
    } catch (error) {
      if (!this.disposed) this.store.setConnection("offline")
      throw error
    }
  }

  async reconcileSession(sessionId: SessionId): Promise<void> {
    if (this.disposed) return
    const snapshot = await this.api.getSession(sessionId)
    if (!snapshot || this.disposed) return
    this.store.replaceSession(
      snapshot.session,
      snapshot.muxTerminals,
      snapshot.tabs,
    )
  }

  async closeTerminal(command: CloseTerminal): Promise<MuxTerminal | undefined> {
    if (this.disposed) return undefined
    const terminal = this.store.getSnapshot().terminalsById.get(command.muxTerminalId)
    if (!terminal) return undefined
    const pending = this.store.stageTerminalClose(command.muxTerminalId)
    if (!pending) return undefined
    try {
      const archived = await this.api.closeTerminal(command)
      if (this.disposed) return archived
      this.store.replaceMuxTerminal(archived)
      pending.confirm()
      return archived
    } catch (error) {
      try {
        await this.reconcileSession(terminal.sessionId)
      } finally {
        const authoritative = this.store.getSnapshot().terminalsById.get(command.muxTerminalId)
        if (authoritative?.archivedAt) pending.confirm()
        else pending.rollback()
      }
      throw error
    }
  }

  async closeTab(command: ArchiveSessionTab): Promise<SessionTab | undefined> {
    if (this.disposed) return undefined
    const tab = this.store.getSnapshot().tabsById.get(command.tabId)
    if (!tab) return undefined
    const pending = this.store.stageTabClose(command.tabId)
    if (!pending) return undefined
    try {
      const archived = await this.api.archiveTab(command)
      if (this.disposed) return archived
      this.store.replaceTab(archived)
      pending.confirm()
      return archived
    } catch (error) {
      try {
        await this.reconcileSession(tab.sessionId)
      } finally {
        const authoritative = this.store.getSnapshot().tabsById.get(command.tabId)
        if (authoritative?.archivedAt) pending.confirm()
        else pending.rollback()
      }
      throw error
    }
  }

  async reconcile(): Promise<void> {
    if (this.disposed) return
    if (this.reconcilePromise) return this.reconcilePromise
    const promise = this.hydrate().finally(() => {
      if (this.reconcilePromise === promise) this.reconcilePromise = undefined
    })
    this.reconcilePromise = promise
    return promise
  }

  dispose(): void {
    this.disposed = true
    this.disposeEvents?.()
    this.reconcilePromise = undefined
    this.store.setRevisionGapHandler(undefined)
    this.store.clearPendingCloses()
  }

  private async reconcileGap(gap: MuxRevisionGap): Promise<void> {
    try {
      if (gap.entity === "session" || gap.entity === "tab") {
        const sessionId = gap.entity === "session"
          ? gap.id as SessionId
          : this.store.getSnapshot().tabsById.get(gap.id as SessionTabId)?.sessionId
        if (!sessionId) return
        await this.reconcileSession(sessionId)
        return
      }
      const terminal = await this.api.getTerminal(gap.id as MuxTerminalId)
      if (!terminal || this.disposed) return
      this.store.replaceMuxTerminalIfNewer(terminal)
    } catch {
      // Reconciliation is best effort; a dropped host connection will trigger
      // the next full snapshot instead of an unhandled rejection.
    }
  }

  private replaceSnapshots(
    snapshots: readonly MuxSessionSnapshot[],
    baseline: ReturnType<MuxSessionStore["captureRevisions"]>,
  ): void {
    const hasTabs = snapshots.some(snapshot => snapshot.tabs !== undefined)
    this.store.mergeSnapshot(
      snapshots.map(snapshot => snapshot.session),
      snapshots.flatMap(snapshot => snapshot.muxTerminals),
      snapshots.flatMap(snapshot => snapshot.tabs ?? []),
      hasTabs,
      baseline,
    )
  }
}

export function createTerminalClient(options: MuxClientOptions = {}): MuxClient {
  return new MuxClient(options)
}

export function activeMuxTerminal(
  store: MuxSessionStore,
  sessionId: SessionId,
): MuxTerminal | undefined {
  const snapshot = store.getSnapshot()
  const tabId = snapshot.activeSessionId === sessionId
    ? snapshot.activeTabId
    : snapshot.sessionsById.get(sessionId)?.activeTabId
  const ids = tabId ? snapshot.terminalIdsByTab.get(tabId) ?? [] : []
  const activeId = tabId ? snapshot.tabsById.get(tabId)?.activeMuxTerminalId : undefined
  const id = activeId && ids.includes(activeId) ? activeId : ids[0]
  return id ? snapshot.terminalsById.get(id) : undefined
}

export function sessionById(store: MuxSessionStore, id: SessionId): AppSession | undefined {
  return store.getSnapshot().sessionsById.get(id)
}
