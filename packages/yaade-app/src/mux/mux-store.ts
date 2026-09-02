import { Schema } from "effect"
import { SessionTab, SessionTabId } from "@yaade/rpc"
import type {
  AppSession,
  SessionId,
  MuxEvent,
  MuxTerminal,
  MuxTerminalId,
} from "@yaade/rpc"
import { localResourceKey } from "./mux-routing.js"

export type MuxStoreSnapshot = {
  readonly sessionsById: ReadonlyMap<SessionId, AppSession>
  readonly visibleSessionIds: readonly SessionId[]
  readonly tabsById: ReadonlyMap<SessionTabId, SessionTab>
  readonly visibleTabIdsBySession: ReadonlyMap<SessionId, readonly SessionTabId[]>
  readonly terminalsById: ReadonlyMap<MuxTerminalId, MuxTerminal>
  readonly terminalIdsBySession: ReadonlyMap<SessionId, readonly MuxTerminalId[]>
  readonly terminalIdsByTab: ReadonlyMap<SessionTabId, readonly MuxTerminalId[]>
  readonly activeSessionId: SessionId | undefined
  readonly activeTabId: SessionTabId | undefined
  readonly activeMuxTerminalId: MuxTerminalId | undefined
  readonly connection: "connecting" | "connected" | "reconciling" | "offline"
}

type Listener = () => void

export type MuxRevisionGap = {
  readonly entity: "session" | "tab" | "muxTerminal"
  readonly id: SessionId | SessionTabId | MuxTerminalId
  readonly expectedRevision: number
  readonly actualRevision: number
}

export type PendingMuxClose = {
  readonly mutationId: number
  confirm(): void
  rollback(): void
}

export type MuxStoreRevisionSnapshot = {
  readonly sessions: ReadonlyMap<SessionId, number>
  readonly tabs: ReadonlyMap<SessionTabId, number>
  readonly terminals: ReadonlyMap<MuxTerminalId, number>
}

function fallbackTab(session: AppSession): SessionTab {
  const id = Schema.decodeUnknownSync(SessionTabId)(`tab-${session.id.slice(4)}`)
  return SessionTab.make({
    id,
    sessionId: session.id,
    title: "Window 1",
    position: 0,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  })
}

/** Normalized client state. PTY bytes intentionally never enter this store. */
export class MuxSessionStore {
  private sessionsById = new Map<SessionId, AppSession>()
  private visibleSessionIds: SessionId[] = []
  private tabsById = new Map<SessionTabId, SessionTab>()
  private visibleTabIdsBySession = new Map<SessionId, SessionTabId[]>()
  private terminalsById = new Map<MuxTerminalId, MuxTerminal>()
  private terminalIdsBySession = new Map<SessionId, MuxTerminalId[]>()
  private terminalIdsByTab = new Map<SessionTabId, MuxTerminalId[]>()
  private activeSessionId: SessionId | undefined
  private activeTabId: SessionTabId | undefined
  private activeMuxTerminalId: MuxTerminalId | undefined
  private connection: MuxStoreSnapshot["connection"] = "connecting"
  private snapshot: MuxStoreSnapshot = this.makeSnapshot()
  private readonly listeners = new Set<Listener>()
  private readonly sessionListeners = new Map<SessionId, Set<Listener>>()
  private readonly tabListeners = new Map<SessionTabId, Set<Listener>>()
  private readonly terminalListeners = new Map<MuxTerminalId, Set<Listener>>()
  private readonly revisions = new Map<string, number>()
  private readonly pendingTerminalCloses = new Map<MuxTerminalId, number>()
  private readonly pendingTabCloses = new Map<SessionTabId, number>()
  private nextCloseMutationId = 1
  private revisionGapHandler: ((gap: MuxRevisionGap) => void) | undefined

  setRevisionGapHandler(handler: ((gap: MuxRevisionGap) => void) | undefined): void {
    this.revisionGapHandler = handler
  }

  getSnapshot = (): MuxStoreSnapshot => this.snapshot

  captureRevisions(): MuxStoreRevisionSnapshot {
    return {
      sessions: new Map(
        [...this.sessionsById].map(([id, value]) => [id, value.revision ?? 0]),
      ),
      tabs: new Map(
        [...this.tabsById].map(([id, value]) => [id, value.revision ?? 0]),
      ),
      terminals: new Map(
        [...this.terminalsById].map(([id, value]) => [id, value.revision]),
      ),
    }
  }

  /**
   * Apply an authoritative snapshot without allowing a response that was
   * started earlier to overwrite newer realtime events. Entities changed
   * during the request are retained when the response omits or regresses them.
   */
  mergeSnapshot(
    sessions: readonly AppSession[],
    terminals: readonly MuxTerminal[],
    tabs: readonly SessionTab[],
    hasTabs: boolean,
    baseline: MuxStoreRevisionSnapshot,
  ): void {
    const previousSessions = this.sessionsById
    const previousTabs = this.tabsById
    const previousTerminals = this.terminalsById
    const incomingSessions = new Map(sessions.map(value => [value.id, value]))
    const nextSessions = new Map<SessionId, AppSession>()
    for (const [id, incoming] of incomingSessions) {
      const current = this.sessionsById.get(id)
      nextSessions.set(
        id,
        current && (current.revision ?? 0) > (incoming.revision ?? 0)
          ? current
          : incoming,
      )
    }
    for (const [id, current] of this.sessionsById) {
      if (incomingSessions.has(id)) continue
      if ((current.revision ?? 0) > (baseline.sessions.get(id) ?? 0)) {
        nextSessions.set(id, current)
      }
    }

    const incomingTabs = new Map(tabs.map(value => [value.id, value]))
    const nextTabs = hasTabs ? new Map<SessionTabId, SessionTab>() : new Map(this.tabsById)
    if (hasTabs) {
      for (const [id, incoming] of incomingTabs) {
        const current = this.tabsById.get(id)
        nextTabs.set(
          id,
          current && (current.revision ?? 0) > (incoming.revision ?? 0)
            ? current
            : incoming,
        )
      }
      for (const [id, current] of this.tabsById) {
        if (incomingTabs.has(id)) continue
        if ((current.revision ?? 0) > (baseline.tabs.get(id) ?? 0)) {
          nextTabs.set(id, current)
        }
      }
    }

    for (const session of nextSessions.values()) {
      const hasVisibleTab = [...nextTabs.values()].some(
        tab => tab.sessionId === session.id && !tab.archivedAt,
      )
      if (!hasVisibleTab) {
        const fallback = fallbackTab(session)
        nextTabs.set(fallback.id, fallback)
      }
    }

    const incomingTerminals = new Map(terminals.map(value => [value.id, value]))
    const nextTerminals = new Map<MuxTerminalId, MuxTerminal>()
    for (const [id, incoming] of incomingTerminals) {
      const current = this.terminalsById.get(id)
      nextTerminals.set(
        id,
        current && current.revision > incoming.revision ? current : incoming,
      )
    }
    for (const [id, current] of this.terminalsById) {
      if (incomingTerminals.has(id)) continue
      if (current.revision > (baseline.terminals.get(id) ?? 0)) {
        nextTerminals.set(id, current)
      }
    }

    this.sessionsById = nextSessions
    this.tabsById = nextTabs
    this.terminalsById = nextTerminals
    this.clearAuthoritativelyFinishedCloses()
    for (const [id, value] of nextSessions) {
      this.revisions.set(`session:${id}`, Math.max(this.revisions.get(`session:${id}`) ?? 0, value.revision ?? 0))
    }
    for (const [id, value] of nextTabs) {
      this.revisions.set(`tab:${id}`, Math.max(this.revisions.get(`tab:${id}`) ?? 0, value.revision ?? 0))
    }
    for (const [id, value] of nextTerminals) {
      this.revisions.set(`terminal:${id}`, Math.max(this.revisions.get(`terminal:${id}`) ?? 0, value.revision))
    }
    for (const [id, revision] of baseline.sessions) {
      this.revisions.set(`session:${id}`, Math.max(this.revisions.get(`session:${id}`) ?? 0, revision))
    }
    for (const [id, revision] of baseline.tabs) {
      this.revisions.set(`tab:${id}`, Math.max(this.revisions.get(`tab:${id}`) ?? 0, revision))
    }
    for (const [id, revision] of baseline.terminals) {
      this.revisions.set(`terminal:${id}`, Math.max(this.revisions.get(`terminal:${id}`) ?? 0, revision))
    }
    this.rebuildVisibleSessions()
    this.rebuildVisibleTabs()
    this.reconcileSelection()
    this.notifyMapChanges(previousSessions, nextSessions, this.sessionListeners)
    this.notifyMapChanges(previousTabs, nextTabs, this.tabListeners)
    this.notifyMapChanges(previousTerminals, nextTerminals, this.terminalListeners)
    this.publish()
  }

  stageTerminalClose(id: MuxTerminalId): PendingMuxClose | null {
    const terminal = this.terminalsById.get(id)
    if (!terminal || terminal.archivedAt || this.pendingTerminalCloses.has(id)) return null
    const mutationId = this.nextCloseMutationId++
    this.pendingTerminalCloses.set(id, mutationId)
    this.rebuildTerminalIndexes()
    this.reconcileSelection()
    this.publish()
    return this.closeHandle(this.pendingTerminalCloses, id, mutationId)
  }

  stageTabClose(id: SessionTabId): PendingMuxClose | null {
    const tab = this.tabsById.get(id)
    if (!tab || tab.archivedAt || this.pendingTabCloses.has(id)) return null
    const mutationId = this.nextCloseMutationId++
    this.pendingTabCloses.set(id, mutationId)
    this.rebuildVisibleTabs()
    this.reconcileSelection()
    this.publish()
    return this.closeHandle(this.pendingTabCloses, id, mutationId)
  }

  clearPendingCloses(): void {
    if (this.pendingTerminalCloses.size === 0 && this.pendingTabCloses.size === 0) return
    this.pendingTerminalCloses.clear()
    this.pendingTabCloses.clear()
    this.rebuildVisibleTabs()
    this.reconcileSelection()
    this.publish()
  }

  replaceMuxTerminalIfNewer(terminal: MuxTerminal): void {
    const current = this.terminalsById.get(terminal.id)
    if (current && current.revision > terminal.revision) return
    this.replaceMuxTerminal(terminal)
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeSession(id: SessionId, listener: Listener): () => void {
    return this.subscribeEntity(this.sessionListeners, id, listener)
  }

  subscribeTab(id: SessionTabId, listener: Listener): () => void {
    return this.subscribeEntity(this.tabListeners, id, listener)
  }

  subscribeMuxTerminal(id: MuxTerminalId, listener: Listener): () => void {
    return this.subscribeEntity(this.terminalListeners, id, listener)
  }

  private subscribeEntity<K>(
    map: Map<K, Set<Listener>>,
    key: K,
    listener: Listener,
  ): () => void {
    const listeners = map.get(key) ?? new Set<Listener>()
    listeners.add(listener)
    map.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) map.delete(key)
    }
  }

  replaceTab(tab: SessionTab): void {
    const current = this.tabsById.get(tab.id)
    if (
      current &&
      ((current.revision ?? 0) > (tab.revision ?? 0) ||
        ((current.revision ?? 0) === (tab.revision ?? 0) &&
          current.updatedAt > tab.updatedAt))
    ) return
    this.tabsById = new Map(this.tabsById).set(tab.id, tab)
    if (tab.archivedAt) this.pendingTabCloses.delete(tab.id)
    this.rebuildVisibleTabs()
    this.reconcileSelection()
    this.notify(this.tabListeners, tab.id)
    this.publish()
  }

  replaceMuxTerminal(terminal: MuxTerminal): void {
    const current = this.terminalsById.get(terminal.id)
    if (
      current &&
      (current.revision > terminal.revision ||
        (current.revision === terminal.revision && current.updatedAt > terminal.updatedAt))
    ) return
    const sessions = [...this.sessionsById.values()]
    const tabs = [...this.tabsById.values()]
    const terminals = [...this.terminalsById.values()].filter(candidate => candidate.id !== terminal.id)
    this.replace(sessions, [...terminals, terminal], tabs)
  }

  replaceSession(
    session: AppSession,
    terminals: readonly MuxTerminal[],
    tabs?: readonly SessionTab[],
  ): void {
    const currentSession = this.sessionsById.get(session.id)
    const nextSession =
      currentSession && (currentSession.revision ?? 0) > (session.revision ?? 0)
        ? currentSession
        : session
    const sessions = [...this.sessionsById.values()].filter(candidate => candidate.id !== session.id)
    const existingTerminals = [...this.terminalsById.values()].filter(candidate => candidate.sessionId !== session.id)
    const incomingTerminals = new Map(terminals.map(value => [value.id, value]))
    for (const current of this.terminalsById.values()) {
      if (current.sessionId !== session.id || incomingTerminals.has(current.id)) continue
      if (current.archivedAt) incomingTerminals.set(current.id, current)
    }
    for (const incoming of terminals) {
      const current = this.terminalsById.get(incoming.id)
      if (current && current.revision > incoming.revision) {
        incomingTerminals.set(incoming.id, current)
      }
    }
    const existingTabs = [...this.tabsById.values()].filter(candidate => candidate.sessionId !== session.id)
    const incomingTabs = new Map((tabs ?? []).map(value => [value.id, value]))
    for (const current of this.tabsById.values()) {
      if (current.sessionId !== session.id) continue
      // A legacy host may omit tabs entirely. Retain the local normalized tabs
      // in that case; an explicit empty array remains authoritative.
      if (tabs === undefined) {
        incomingTabs.set(current.id, current)
        continue
      }
      if (incomingTabs.has(current.id)) continue
      if (current.archivedAt) incomingTabs.set(current.id, current)
    }
    for (const incoming of tabs ?? []) {
      const current = this.tabsById.get(incoming.id)
      if (current && (current.revision ?? 0) > (incoming.revision ?? 0)) {
        incomingTabs.set(incoming.id, current)
      }
    }
    this.replace(
      [...sessions, nextSession],
      [...existingTerminals, ...incomingTerminals.values()],
      [...existingTabs, ...incomingTabs.values()],
    )
  }

  setConnection(connection: MuxStoreSnapshot["connection"]): void {
    if (this.connection === connection) return
    this.connection = connection
    this.publish()
  }

  /** `tabs` is optional so older host snapshots can be upgraded in memory. */
  replace(
    sessions: readonly AppSession[],
    terminals: readonly MuxTerminal[],
    tabs: readonly SessionTab[] = [],
  ): void {
    const previousSessions = this.sessionsById
    const previousTabs = this.tabsById
    const previousTerminals = this.terminalsById
    this.sessionsById = new Map(sessions.map(session => [session.id, session]))
    this.visibleSessionIds = sessions
      .filter(session => !session.archivedAt)
      .sort((a, b) => a.position - b.position)
      .map(session => session.id)

    const nextTabs = [...tabs]
    for (const session of sessions) {
      if (!nextTabs.some(tab => tab.sessionId === session.id && !tab.archivedAt)) {
        nextTabs.push(fallbackTab(session))
      }
    }
    this.tabsById = new Map(nextTabs.map(tab => [tab.id, tab]))
    this.visibleTabIdsBySession = new Map()
    for (const tab of nextTabs) {
      if (tab.archivedAt || this.pendingTabCloses.has(tab.id)) continue
      const ids = this.visibleTabIdsBySession.get(tab.sessionId) ?? []
      ids.push(tab.id)
      this.visibleTabIdsBySession.set(tab.sessionId, ids)
    }
    for (const ids of this.visibleTabIdsBySession.values()) {
      ids.sort((a, b) => (this.tabsById.get(a)?.position ?? 0) - (this.tabsById.get(b)?.position ?? 0))
    }

    this.terminalsById = new Map(terminals.map(terminal => [terminal.id, terminal]))
    this.clearAuthoritativelyFinishedCloses()
    for (const session of sessions) {
      this.revisions.set(`session:${session.id}`, Math.max(this.revisions.get(`session:${session.id}`) ?? 0, session.revision ?? 0))
    }
    for (const tab of tabs) {
      this.revisions.set(`tab:${tab.id}`, Math.max(this.revisions.get(`tab:${tab.id}`) ?? 0, tab.revision ?? 0))
    }
    for (const terminal of terminals) {
      this.revisions.set(`terminal:${terminal.id}`, Math.max(this.revisions.get(`terminal:${terminal.id}`) ?? 0, terminal.revision))
    }
    this.rebuildTerminalIndexes()
    this.reconcileSelection()
    this.notifyMapChanges(previousSessions, this.sessionsById, this.sessionListeners)
    this.notifyMapChanges(previousTabs, this.tabsById, this.tabListeners)
    this.notifyMapChanges(previousTerminals, this.terminalsById, this.terminalListeners)
    this.publish()
  }

  selectSession(id: SessionId): void {
    const resolved = this.resolveSessionId(id)
    if (!resolved || this.activeSessionId === resolved) return
    this.activeSessionId = resolved
    this.activeTabId = this.selectedTabForSession(resolved)
    this.activeMuxTerminalId = this.activeTabId
      ? this.selectedTerminalForTab(this.activeTabId)
      : undefined
    this.publish()
  }

  selectTab(id: SessionTabId): void {
    const tab = this.tabsById.get(id) ?? this.findByLocalKey(this.tabsById, id)
    if (!tab || tab.archivedAt || this.pendingTabCloses.has(tab.id)) return
    this.activeSessionId = tab.sessionId
    this.activeTabId = id
    this.activeMuxTerminalId = this.selectedTerminalForTab(id)
    this.publish()
  }

  selectMuxTerminal(id: MuxTerminalId): void {
    const terminal = this.terminalsById.get(id) ?? this.findByLocalKey(this.terminalsById, id)
    if (!terminal || terminal.archivedAt || this.pendingTerminalCloses.has(terminal.id)) return
    const tabId = this.tabIdForTerminal(terminal)
    if (!tabId) return
    this.activeSessionId = terminal.sessionId
    this.activeTabId = tabId
    this.activeMuxTerminalId = id
    this.publish()
  }

  apply(event: MuxEvent): void {
    let entityKey: string | undefined
    let entity: MuxRevisionGap["entity"] | undefined
    let entityId: SessionId | SessionTabId | MuxTerminalId | undefined

    if (event._tag === "SessionTabCreated" || event._tag === "SessionTabUpdated" || event._tag === "SessionTabArchived") {
      entityKey = `tab:${event.tab.id}`
      entity = "tab"
      entityId = event.tab.id
    } else if ("muxTerminalId" in event) {
      entityKey = `terminal:${event.muxTerminalId}`
      entity = "muxTerminal"
      entityId = event.muxTerminalId
    } else if ("session" in event) {
      entityKey = `session:${event.session.id}`
      entity = "session"
      entityId = event.session.id
    }

    const current = entity === "tab" && entityId
      ? this.tabsById.get(entityId as SessionTabId)
      : entity === "session" && entityId
        ? this.sessionsById.get(entityId as SessionId)
        : entity === "muxTerminal" && entityId
          ? this.terminalsById.get(entityId as MuxTerminalId)
          : undefined
    const knownRevision = entityKey
      ? Math.max(
          this.revisions.get(entityKey) ?? 0,
          current?.revision ?? 0,
        )
      : 0
    // Revisions are the authoritative ordering. Wall-clock timestamps can
    // differ between host processes, so never let a lower/equal revision
    // regress an entity merely because its timestamp looks newer.
    if (entityKey && knownRevision >= event.revision) return
    if (
      entityKey &&
      entity &&
      entityId &&
      knownRevision > 0 &&
      event.revision > knownRevision + 1
    ) {
      this.revisionGapHandler?.({
        entity,
        id: entityId,
        expectedRevision: knownRevision + 1,
        actualRevision: event.revision,
      })
    }
    if (entityKey) this.revisions.set(entityKey, event.revision)

    switch (event._tag) {
      case "SessionCreated":
      case "SessionUpdated":
      case "SessionArchived":
      case "SessionRestored":
        this.sessionsById = new Map(this.sessionsById).set(event.session.id, event.session)
        this.rebuildVisibleSessions()
        this.notify(this.sessionListeners, event.session.id)
        if (event.session.id === this.activeSessionId) {
          const tabIds = this.visibleTabIdsBySession.get(event.session.id) ?? []
          const keepLocalTab =
            this.activeTabId != null && tabIds.includes(this.activeTabId)
          const nextTabId = keepLocalTab
            ? this.activeTabId
            : event.session.activeTabId && tabIds.includes(event.session.activeTabId)
              ? event.session.activeTabId
              : this.selectedTabForSession(event.session.id)
          this.activeTabId = nextTabId
          const terminalIds = nextTabId
            ? this.terminalIdsByTab.get(nextTabId) ?? []
            : []
          if (
            !this.activeMuxTerminalId ||
            !terminalIds.includes(this.activeMuxTerminalId)
          ) {
            this.activeMuxTerminalId = nextTabId
              ? this.selectedTerminalForTab(nextTabId)
              : undefined
          }
        }
        break
      case "SessionTabCreated":
      case "SessionTabUpdated":
      case "SessionTabArchived": {
        this.tabsById = new Map(this.tabsById).set(event.tab.id, event.tab)
        if (event.tab.archivedAt) this.pendingTabCloses.delete(event.tab.id)
        this.rebuildVisibleTabs()
        this.notify(this.tabListeners, event.tab.id)
        if (this.activeTabId === event.tab.id) {
          const ids = this.terminalIdsByTab.get(event.tab.id) ?? []
          const keepLocal =
            this.activeMuxTerminalId != null &&
            ids.includes(this.activeMuxTerminalId)
          if (!keepLocal) {
            this.activeMuxTerminalId = this.selectedTerminalForTab(event.tab.id)
          }
        }
        break
      }
      case "MuxTerminalCreated":
      case "MuxTerminalUpdated": {
        const currentTerminal = this.terminalsById.get(event.muxTerminal.id)
        if (currentTerminal?.archivedAt && !event.muxTerminal.archivedAt) break
        this.upsertTerminal(event.muxTerminal)
        break
      }
      case "TerminalOutputChanged": {
        const terminal = this.terminalsById.get(event.muxTerminalId)
        if (terminal) this.upsertTerminal({ ...terminal, output: event.output, revision: event.revision, updatedAt: event.occurredAt })
        break
      }
      case "MuxTerminalArchived": {
        const terminal = this.terminalsById.get(event.muxTerminalId)
        if (terminal) {
          this.pendingTerminalCloses.delete(event.muxTerminalId)
          this.upsertTerminal({ ...terminal, archivedAt: event.occurredAt, revision: event.revision, updatedAt: event.occurredAt })
        }
        break
      }
    }
    this.reconcileSelection()
    this.publish()
  }

  private upsertTerminal(terminal: MuxTerminal): void {
    const previous = this.terminalsById.get(terminal.id)
    this.terminalsById = new Map(this.terminalsById).set(terminal.id, terminal)
    if (
      !previous ||
      previous.sessionId !== terminal.sessionId ||
      previous.tabId !== terminal.tabId ||
      previous.archivedAt !== terminal.archivedAt ||
      previous.position !== terminal.position
    ) {
      this.updateTerminalIndexes(previous, terminal)
    }
    this.notify(this.terminalListeners, terminal.id)
  }

  private updateTerminalIndexes(previous: MuxTerminal | undefined, next: MuxTerminal): void {
    const sessionIndexes = new Map(this.terminalIdsBySession)
    const tabIndexes = new Map(this.terminalIdsByTab)
    const touchedSessions = new Set<SessionId>()
    const touchedTabs = new Set<SessionTabId>()

    const remove = (terminal: MuxTerminal) => {
      if (terminal.archivedAt) return
      const tabId = this.tabIdForTerminal(terminal)
      const sessionIds = sessionIndexes.get(terminal.sessionId) ?? []
      sessionIndexes.set(
        terminal.sessionId,
        sessionIds.filter(id => id !== terminal.id),
      )
      touchedSessions.add(terminal.sessionId)
      if (!tabId) return
      const tabIds = tabIndexes.get(tabId) ?? []
      tabIndexes.set(tabId, tabIds.filter(id => id !== terminal.id))
      touchedTabs.add(tabId)
    }
    const insert = (terminal: MuxTerminal) => {
      if (terminal.archivedAt || this.pendingTerminalCloses.has(terminal.id)) return
      const tabId = this.tabIdForTerminal(terminal)
      if (!tabId || this.tabsById.get(tabId)?.archivedAt || this.pendingTabCloses.has(tabId)) return
      sessionIndexes.set(terminal.sessionId, [
        ...(sessionIndexes.get(terminal.sessionId) ?? []),
        terminal.id,
      ])
      tabIndexes.set(tabId, [...(tabIndexes.get(tabId) ?? []), terminal.id])
      touchedSessions.add(terminal.sessionId)
      touchedTabs.add(tabId)
    }

    if (previous) remove(previous)
    insert(next)
    for (const sessionId of touchedSessions) {
      sessionIndexes.get(sessionId)?.sort(
        (a, b) =>
          (this.terminalsById.get(a)?.position ?? 0) -
          (this.terminalsById.get(b)?.position ?? 0),
      )
    }
    for (const tabId of touchedTabs) {
      tabIndexes.get(tabId)?.sort(
        (a, b) =>
          (this.terminalsById.get(a)?.position ?? 0) -
          (this.terminalsById.get(b)?.position ?? 0),
      )
    }
    this.terminalIdsBySession = sessionIndexes
    this.terminalIdsByTab = tabIndexes
  }

  private rebuildTerminalIndexes(): void {
    this.terminalIdsBySession = new Map(
      this.visibleSessionIds.map(id => [id, [] as MuxTerminalId[]]),
    )
    this.terminalIdsByTab = new Map(
      [...this.tabsById.values()]
        .filter(tab => !tab.archivedAt && !this.pendingTabCloses.has(tab.id))
        .map(tab => [tab.id, [] as MuxTerminalId[]]),
    )
    for (const terminal of this.terminalsById.values()) {
      if (terminal.archivedAt || this.pendingTerminalCloses.has(terminal.id)) continue
      const tabId = this.tabIdForTerminal(terminal)
      if (!tabId || this.tabsById.get(tabId)?.archivedAt || this.pendingTabCloses.has(tabId)) continue
      const sessionIds = this.terminalIdsBySession.get(terminal.sessionId) ?? []
      sessionIds.push(terminal.id)
      this.terminalIdsBySession.set(terminal.sessionId, sessionIds)
      const tabIds = this.terminalIdsByTab.get(tabId) ?? []
      tabIds.push(terminal.id)
      this.terminalIdsByTab.set(tabId, tabIds)
    }
    for (const ids of this.terminalIdsBySession.values()) {
      ids.sort((a, b) => (this.terminalsById.get(a)?.position ?? 0) - (this.terminalsById.get(b)?.position ?? 0))
    }
    for (const ids of this.terminalIdsByTab.values()) {
      ids.sort((a, b) => (this.terminalsById.get(a)?.position ?? 0) - (this.terminalsById.get(b)?.position ?? 0))
    }
  }

  private tabIdForTerminal(terminal: MuxTerminal): SessionTabId | undefined {
    if (terminal.tabId && this.tabsById.has(terminal.tabId)) return terminal.tabId
    return this.visibleTabIdsBySession.get(terminal.sessionId)?.[0]
  }

  private rebuildVisibleSessions(): void {
    this.visibleSessionIds = [...this.sessionsById.values()]
      .filter(session => !session.archivedAt)
      .sort((a, b) => a.position - b.position)
      .map(session => session.id)
  }

  private rebuildVisibleTabs(): void {
    this.visibleTabIdsBySession = new Map()
    for (const tab of this.tabsById.values()) {
      if (tab.archivedAt || this.pendingTabCloses.has(tab.id)) continue
      const ids = this.visibleTabIdsBySession.get(tab.sessionId) ?? []
      ids.push(tab.id)
      this.visibleTabIdsBySession.set(tab.sessionId, ids)
    }
    for (const ids of this.visibleTabIdsBySession.values()) {
      ids.sort((a, b) => (this.tabsById.get(a)?.position ?? 0) - (this.tabsById.get(b)?.position ?? 0))
    }
    this.rebuildTerminalIndexes()
  }

  private selectedTabForSession(id: SessionId): SessionTabId | undefined {
    const ids = this.visibleTabIdsBySession.get(id) ?? []
    const session = this.sessionsById.get(id)
    return session?.activeTabId && ids.includes(session.activeTabId)
      ? session.activeTabId
      : ids[0]
  }

  private selectedTerminalForTab(id: SessionTabId): MuxTerminalId | undefined {
    const ids = this.terminalIdsByTab.get(id) ?? []
    const tab = this.tabsById.get(id)
    return tab?.activeMuxTerminalId && ids.includes(tab.activeMuxTerminalId)
      ? tab.activeMuxTerminalId
      : ids[0]
  }

  private resolveSessionId(id: string): SessionId | undefined {
    if (this.sessionsById.has(id as SessionId)) return id as SessionId
    return this.findByLocalKey(this.sessionsById, id)?.id
  }

  private findByLocalKey<T extends { readonly id: string }>(
    items: ReadonlyMap<string, T>,
    requested: string,
  ): T | undefined {
    const exact = items.get(requested)
    if (exact) return exact
    const key = localResourceKey(requested)
    for (const item of items.values()) {
      if (localResourceKey(item.id) === key) return item
    }
    return undefined
  }

  private reconcileSelection(): void {
    if (!this.activeSessionId || !this.sessionsById.has(this.activeSessionId) || !this.visibleSessionIds.includes(this.activeSessionId)) {
      this.activeSessionId = this.visibleSessionIds[0]
    }
    if (!this.activeSessionId) {
      this.activeTabId = undefined
      this.activeMuxTerminalId = undefined
      return
    }
    const tabIds = this.visibleTabIdsBySession.get(this.activeSessionId) ?? []
    if (!this.activeTabId || !tabIds.includes(this.activeTabId)) {
      this.activeTabId = this.selectedTabForSession(this.activeSessionId)
    }
    this.activeMuxTerminalId = this.activeTabId
      ? this.activeMuxTerminalId && (this.terminalIdsByTab.get(this.activeTabId) ?? []).includes(this.activeMuxTerminalId)
        ? this.activeMuxTerminalId
        : this.selectedTerminalForTab(this.activeTabId)
      : undefined
  }

  private closeHandle<K>(
    pending: Map<K, number>,
    key: K,
    mutationId: number,
  ): PendingMuxClose {
    return {
      mutationId,
      confirm: () => {
        if (pending.get(key) === mutationId) pending.delete(key)
      },
      rollback: () => {
        if (pending.get(key) !== mutationId) return
        pending.delete(key)
        this.rebuildVisibleTabs()
        this.reconcileSelection()
        this.publish()
      },
    }
  }

  private clearAuthoritativelyFinishedCloses(): void {
    for (const id of this.pendingTerminalCloses.keys()) {
      const terminal = this.terminalsById.get(id)
      if (!terminal || terminal.archivedAt) this.pendingTerminalCloses.delete(id)
    }
    for (const id of this.pendingTabCloses.keys()) {
      const tab = this.tabsById.get(id)
      if (!tab || tab.archivedAt) this.pendingTabCloses.delete(id)
    }
  }

  private makeSnapshot(): MuxStoreSnapshot {
    return {
      sessionsById: this.sessionsById,
      visibleSessionIds: this.visibleSessionIds,
      tabsById: this.tabsById,
      visibleTabIdsBySession: this.visibleTabIdsBySession,
      terminalsById: this.terminalsById,
      terminalIdsBySession: this.terminalIdsBySession,
      terminalIdsByTab: this.terminalIdsByTab,
      activeSessionId: this.activeSessionId,
      activeTabId: this.activeTabId,
      activeMuxTerminalId: this.activeMuxTerminalId,
      connection: this.connection,
    }
  }

  private publish(): void {
    this.snapshot = this.makeSnapshot()
    for (const listener of this.listeners) listener()
  }

  private notify<K>(map: Map<K, Set<Listener>>, key: K): void {
    for (const listener of map.get(key) ?? []) listener()
  }

  private notifyMapChanges<K, V>(
    previous: ReadonlyMap<K, V>,
    next: ReadonlyMap<K, V>,
    listeners: Map<K, Set<Listener>>,
  ): void {
    const keys = new Set([...previous.keys(), ...next.keys()])
    for (const key of keys) {
      if (previous.get(key) !== next.get(key)) this.notify(listeners, key)
    }
  }
}
