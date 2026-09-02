import { Schema } from "effect"
import {
  ArchiveSession,
  ArchiveSessionTab,
  CloseTerminal,
  CreateSessionTab,
  CreateTerminal,
  MoveTerminalToTab,
  RenameSessionTab,
  ReorderSessionTabs,
  ReorderTerminals,
  RestoreSession,
  SaveSessionTabLayout,
  SelectSessionTab,
  SessionId,
  SessionTabId,
  MuxTerminalId,
  type AppSession as AppSessionValue,
  type MuxEvent as MuxEventValue,
  type MuxTerminal,
} from "@yaade/rpc"
import type {
  HostTerminal,
  HostMux,
  YaadeHostAPI,
  MuxSessionSnapshot,
} from "@yaade/workspace"
import type {
  YaadeServerConnection,
  YaadeServerDefinition,
  YaadeServerStatus,
} from "@yaade/shared"
import { createYaadeApi } from "./create-yaade-api.js"
import { normalizeHostBaseUrl, WebHostTransport } from "./web-transport.js"

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/
const SERVER_STORAGE_KEY = "yaade:server-definitions"
const LEGACY_TOKEN_SESSION_KEY = "yaade:legacy-server-tokens"

type StorageLike = Pick<Storage, "getItem" | "setItem">
export type MultiServerGlobalTarget = {
  readonly setYaade: (value: YaadeHostAPI) => void
}
type Listener = () => void

type Owner = {
  readonly serverId: string
  readonly localId: string
}

type ManagedConnection = {
  readonly definition: YaadeServerDefinition
  readonly transport: WebHostTransport
  readonly api: YaadeHostAPI
  status: YaadeServerStatus
  sessionCount: number
  error?: string
  disposeStatus: () => void
  disposeMux: () => void
  disposeTerminal: () => void
}

export type MultiServerSnapshot = {
  readonly connections: readonly YaadeServerConnection[]
  readonly activeServerId: string | undefined
  readonly generation: number
}

export type ServerTestResult =
  | { readonly ok: true; readonly sessionCount: number }
  | { readonly ok: false; readonly error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function normalizeServerDefinition(raw: unknown): YaadeServerDefinition | null {
  if (!isRecord(raw)) return null
  const rawUrl = nonEmptyString(raw.url)
  if (!rawUrl) return null
  let url: string
  try {
    url = normalizeHostBaseUrl(rawUrl)
  } catch {
    return null
  }
  const id = nonEmptyString(raw.id)
  const name = nonEmptyString(raw.name) ?? new URL(url).hostname
  if (!id || !SERVER_ID_PATTERN.test(id)) return null
  const token = nonEmptyString(raw.token)
  return {
    id,
    name,
    url,
    ...(token ? { token } : {}),
  }
}

export function decodeStoredServerDefinitions(raw: unknown): YaadeServerDefinition[] {
  const values = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.servers)
      ? raw.servers
      : []
  const seen = new Set<string>()
  const urls = new Set<string>()
  const definitions: YaadeServerDefinition[] = []
  for (const value of values) {
    const definition = normalizeServerDefinition(value)
    if (!definition || seen.has(definition.id) || urls.has(definition.url)) continue
    seen.add(definition.id)
    urls.add(definition.url)
    definitions.push(definition)
  }
  return definitions
}

function sessionTokenMap(): Record<string, string> {
  if (typeof sessionStorage === "undefined") return {}
  try {
    const raw = sessionStorage.getItem(LEGACY_TOKEN_SESSION_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!isRecord(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
      ),
    )
  } catch {
    return {}
  }
}

function saveSessionTokenMap(tokens: Record<string, string>): void {
  if (typeof sessionStorage === "undefined") return
  try {
    sessionStorage.setItem(LEGACY_TOKEN_SESSION_KEY, JSON.stringify(tokens))
  } catch {
    /* Session storage can be disabled; the user can pair again. */
  }
}

export function loadStoredServerDefinitions(
  storage: StorageLike | null = typeof localStorage === "undefined" ? null : localStorage,
): YaadeServerDefinition[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(SERVER_STORAGE_KEY)
    const definitions = raw ? decodeStoredServerDefinitions(JSON.parse(raw)) : []
    const tokens = sessionTokenMap()
    let migrated = false
    const result = definitions.map(definition => {
      if (definition.token && !tokens[definition.id]) {
        tokens[definition.id] = definition.token
        migrated = true
      }
      return definition.token || !tokens[definition.id]
        ? definition
        : { ...definition, token: tokens[definition.id] }
    })
    if (migrated) {
      saveSessionTokenMap(tokens)
      storage.setItem(
        SERVER_STORAGE_KEY,
        JSON.stringify(result.map(({ token: _token, ...definition }) => definition)),
      )
    }
    return result
  } catch {
    return []
  }
}

export function saveStoredServerDefinitions(
  definitions: readonly YaadeServerDefinition[],
  storage: StorageLike | null = typeof localStorage === "undefined" ? null : localStorage,
): void {
  if (!storage) return
  try {
    const tokens = sessionTokenMap()
    for (const definition of definitions) {
      if (definition.token) tokens[definition.id] = definition.token
    }
    saveSessionTokenMap(tokens)
    // Browser localStorage keeps server metadata only. Legacy bearer tokens
    // are session-scoped during migration; device auth can replace them.
    const persisted = definitions.map(({ token: _token, ...definition }) => definition)
    storage.setItem(SERVER_STORAGE_KEY, JSON.stringify(persisted))
  } catch {
    // Storage can be disabled or full. The live connection still works.
  }
}

function scopedId(
  prefix: "ses" | "tab" | "term",
  serverId: string,
  localId: string,
): string {
  return `${prefix}-${serverId}--${localId.slice(prefix.length + 1)}`
}

function publicSessionId(value: string): SessionId {
  return Schema.decodeUnknownSync(SessionId)(value)
}

function publicTabId(value: string): SessionTabId {
  return Schema.decodeUnknownSync(SessionTabId)(value)
}

function publicMuxTerminalId(value: string): MuxTerminalId {
  return Schema.decodeUnknownSync(MuxTerminalId)(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function scopedTerminalId(serverId: string, terminalId: string): string {
  return `term-${serverId}--${terminalId}`
}

export class MultiServerHostClient {
  readonly mux: HostMux
  readonly ports: YaadeHostAPI

  private readonly currentServerId: string
  private readonly connections = new Map<string, ManagedConnection>()
  private readonly listeners = new Set<Listener>()
  private readonly muxEventListeners = new Set<(event: MuxEventValue) => void>()
  private readonly sessionOwners = new Map<string, Owner>()
  private readonly tabOwners = new Map<string, Owner>()
  private readonly muxTerminalOwners = new Map<string, Owner>()
  private readonly ptyOwners = new Map<string, Owner>()
  private readonly terminalExitListeners = new Set<(
    id: string,
    exitCode: number,
    signal?: number,
  ) => void>()
  private readonly aggregateTerminal: HostTerminal
  private activeServerId: string | undefined
  private generation = 0
  private globalTarget?: MultiServerGlobalTarget
  private snapshot: MultiServerSnapshot

  constructor(options: {
    readonly currentServer: YaadeServerDefinition
    readonly servers?: readonly YaadeServerDefinition[]
    readonly globalTarget?: MultiServerGlobalTarget
  }) {
    this.currentServerId = options.currentServer.id
    this.globalTarget = options.globalTarget
    this.aggregateTerminal = this.createTerminal()
    this.mux = this.createMux()
    this.syncDefinitions(options.currentServer, options.servers ?? [])
    this.ports = this.createPorts(options.currentServer)
    this.snapshot = this.makeSnapshot()
    this.selectServer(this.currentServerId)
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): MultiServerSnapshot => this.snapshot

  setGlobalTarget(target: MultiServerGlobalTarget | undefined): void {
    this.globalTarget = target
    this.publishGlobal()
  }

  getServerDefinitions(): YaadeServerDefinition[] {
    return [...this.connections.values()]
      .map(connection => connection.definition)
      .filter(definition => definition.id !== this.currentServerId)
  }

  setServers(definitions: readonly YaadeServerDefinition[]): void {
    const current = this.connections.get(this.currentServerId)?.definition
    if (!current) return
    this.syncDefinitions(current, definitions)
    this.generation += 1
    this.snapshot = this.makeSnapshot()
    this.publishGlobal()
    this.publish()
  }

  selectSession(sessionId: string): void {
    const owner = this.sessionOwners.get(sessionId)
    if (owner) this.selectServer(owner.serverId)
  }

  selectTab(tabId: string): void {
    const owner = this.tabOwners.get(tabId)
    if (owner) this.selectServer(owner.serverId)
  }

  selectMuxTerminal(muxTerminalId: string): void {
    const owner = this.muxTerminalOwners.get(muxTerminalId)
    if (owner) this.selectServer(owner.serverId)
  }

  serverForSession(sessionId: string): YaadeServerConnection | undefined {
    const owner = this.sessionOwners.get(sessionId)
    return owner ? this.connectionInfo(owner.serverId) : undefined
  }

  onMuxEvent(callback: (event: MuxEventValue) => void): () => void {
    this.muxEventListeners.add(callback)
    return () => this.muxEventListeners.delete(callback)
  }

  async testServer(definition: YaadeServerDefinition): Promise<ServerTestResult> {
    let normalized: YaadeServerDefinition
    try {
      normalized = normalizeServerDefinition(definition) ?? (() => {
        throw new Error("Enter a valid http or https server URL")
      })()
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
    const transport = new WebHostTransport({
      baseUrl: normalized.url,
      authToken: normalized.token ?? null,
    })
    const api = createYaadeApi(transport)
    try {
      const sessions = await api.mux.listSessions(false)
      return { ok: true, sessionCount: sessions.length }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    } finally {
      transport.close()
    }
  }

  private createPorts(currentServer: YaadeServerDefinition): YaadeHostAPI {
    const connection = this.connections.get(currentServer.id)
    if (connection) {
      return { ...connection.api, mux: this.mux, terminal: this.aggregateTerminal }
    }
    // The current connection is installed by syncDefinitions immediately after
    // construction. This branch only keeps the object creation type-safe.
    throw new Error("current YAADE server was not initialized")
  }

  private syncDefinitions(
    currentServer: YaadeServerDefinition,
    definitions: readonly YaadeServerDefinition[],
  ): void {
    const desired = new Map<string, YaadeServerDefinition>()
    desired.set(currentServer.id, currentServer)
    for (const definition of definitions) {
      const normalized = normalizeServerDefinition(definition)
      if (!normalized || normalized.id === currentServer.id || desired.has(normalized.id)) continue
      if ([...desired.values()].some(item => item.url === normalized.url)) continue
      desired.set(normalized.id, normalized)
    }

    for (const [id, connection] of this.connections) {
      const next = desired.get(id)
      if (!next || next.url !== connection.definition.url || next.token !== connection.definition.token) {
        this.disposeConnection(connection)
        this.connections.delete(id)
      }
    }
    for (const definition of desired.values()) {
      if (!this.connections.has(definition.id)) {
        this.connections.set(definition.id, this.createConnection(definition))
      }
    }
    if (!this.activeServerId || !this.connections.has(this.activeServerId)) {
      this.activeServerId = currentServer.id
    }
  }

  private createConnection(definition: YaadeServerDefinition): ManagedConnection {
    const transport = new WebHostTransport({
      baseUrl: definition.url,
      authToken:
        definition.id === this.currentServerId
          ? undefined
          : definition.token ?? null,
    })
    const api = createYaadeApi(transport)
    const connection: ManagedConnection = {
      definition,
      transport,
      api,
      status: "connecting",
      sessionCount: 0,
      disposeStatus: () => undefined,
      disposeMux: () => undefined,
      disposeTerminal: () => undefined,
      }
    const disposeConnectionStatus = transport.on("connection:status", (...args) => {
      const status = args[0]
      if (status === "connected") {
        connection.status = "connected"
        connection.error = undefined
      } else if (status === "synchronizing") {
        connection.status = "synchronizing"
      } else if (status === "disconnected") {
        if (connection.status !== "revoked" && connection.status !== "incompatible") {
          connection.status = "offline"
        }
      }
      this.snapshot = this.makeSnapshot()
      this.publish()
    })
    const disposeProtocolErrors = transport.on("protocol:error", (...args) => {
      const message = String(args[0] ?? "")
      if (/incompatible/i.test(message)) connection.status = "incompatible"
      else if (/revoked/i.test(message)) connection.status = "revoked"
      connection.error = message || connection.error
      this.snapshot = this.makeSnapshot()
      this.publish()
    })
    connection.disposeStatus = () => {
      disposeConnectionStatus()
      disposeProtocolErrors()
    }
    connection.disposeMux = api.mux.onEvent(event => {
      const scoped = this.scopeEvent(connection, event)
      for (const listener of this.muxEventListeners) listener(scoped)
    })
    const disposeExit = api.terminal.onExit((id, exitCode, signal) => {
      const scopedId = this.scopePtyId(connection.definition.id, id)
      for (const listener of this.terminalExitListeners) listener(scopedId, exitCode, signal)
    })
    connection.disposeTerminal = () => {
      disposeExit()
    }
    return connection
  }

  private disposeConnection(connection: ManagedConnection): void {
    connection.disposeStatus()
    connection.disposeMux()
    connection.disposeTerminal()
    connection.transport.close()
  }

  selectServer(serverId: string): void {
    if (!this.connections.has(serverId)) return
    if (this.activeServerId === serverId) {
      this.publishGlobal()
      return
    }
    this.activeServerId = serverId
    this.publishGlobal()
    this.snapshot = this.makeSnapshot()
    this.publish()
  }

  private activeConnection(): ManagedConnection {
    const active = this.activeServerId
      ? this.connections.get(this.activeServerId)
      : undefined
    const fallback = active ?? this.connections.values().next().value
    if (!fallback) throw new Error("No YAADE servers are configured")
    return fallback
  }

  private connectionForOwner(owner: Owner): ManagedConnection {
    const connection = this.connections.get(owner.serverId)
    if (!connection) throw new Error("YAADE server is no longer connected")
    return connection
  }

  private ownerForSession(sessionId: string): Owner {
    const owner = this.sessionOwners.get(sessionId)
    if (!owner) throw new Error("Session is not available on a connected server")
    return owner
  }

  private ownerForTab(tabId: string): Owner {
    const owner = this.tabOwners.get(tabId)
    if (!owner) throw new Error("Window is not available on a connected server")
    return owner
  }

  private ownerForMuxTerminal(muxTerminalId: string): Owner {
    const owner = this.muxTerminalOwners.get(muxTerminalId)
    if (!owner) throw new Error("Terminal is not available on a connected server")
    return owner
  }

  private keepLocalIds(connection: ManagedConnection): boolean {
    return connection.definition.id === this.currentServerId
  }

  private scopeSession(connection: ManagedConnection, session: AppSessionValue): AppSessionValue {
    const owner = { serverId: connection.definition.id, localId: session.id }
    this.sessionOwners.set(session.id, owner)
    if (this.keepLocalIds(connection)) return session
    const id = publicSessionId(scopedId("ses", owner.serverId, owner.localId))
    this.sessionOwners.set(id, owner)
    return {
      ...session,
      id,
      ...(session.activeTabId
        ? { activeTabId: publicTabId(scopedId("tab", owner.serverId, session.activeTabId)) }
        : {}),
      ...(session.activeMuxTerminalId
        ? { activeMuxTerminalId: publicMuxTerminalId(scopedId("term", owner.serverId, session.activeMuxTerminalId)) }
        : {}),
    }
  }

  private scopeTab(connection: ManagedConnection, tab: import("@yaade/rpc").SessionTab): import("@yaade/rpc").SessionTab {
    const owner = { serverId: connection.definition.id, localId: tab.id }
    this.tabOwners.set(tab.id, owner)
    const sessionOwner = { serverId: connection.definition.id, localId: tab.sessionId }
    this.sessionOwners.set(tab.sessionId, sessionOwner)
    if (this.keepLocalIds(connection)) return tab
    const id = publicTabId(scopedId("tab", owner.serverId, owner.localId))
    this.tabOwners.set(id, owner)
    const sessionId = publicSessionId(scopedId("ses", sessionOwner.serverId, sessionOwner.localId))
    this.sessionOwners.set(sessionId, sessionOwner)
    return {
      ...tab,
      id,
      sessionId,
      ...(tab.activeMuxTerminalId
        ? { activeMuxTerminalId: publicMuxTerminalId(scopedId("term", owner.serverId, tab.activeMuxTerminalId)) }
        : {}),
    }
  }

  private scopeMuxTerminal(connection: ManagedConnection, terminal: MuxTerminal): MuxTerminal {
    const owner = { serverId: connection.definition.id, localId: terminal.id }
    this.muxTerminalOwners.set(terminal.id, owner)
    const sessionOwner = { serverId: connection.definition.id, localId: terminal.sessionId }
    this.sessionOwners.set(terminal.sessionId, sessionOwner)
    if (terminal.output.kind === "process" && terminal.output.ptyId) {
      this.ptyOwners.set(terminal.output.ptyId, {
        serverId: owner.serverId,
        localId: terminal.output.ptyId,
      })
    }
    if (this.keepLocalIds(connection)) return terminal
    const id = publicMuxTerminalId(scopedId("term", owner.serverId, owner.localId))
    this.muxTerminalOwners.set(id, owner)
    const sessionId = publicSessionId(scopedId("ses", sessionOwner.serverId, sessionOwner.localId))
    this.sessionOwners.set(sessionId, sessionOwner)
    const output = this.scopeProcessOutput(owner.serverId, terminal.output)
    if (terminal.output.kind === "process" && terminal.output.ptyId) {
      this.ptyOwners.set(this.scopePtyId(owner.serverId, terminal.output.ptyId), {
        serverId: owner.serverId,
        localId: terminal.output.ptyId,
      })
    }
    return {
      ...terminal,
      id,
      sessionId,
      ...(terminal.tabId
        ? { tabId: publicTabId(scopedId("tab", owner.serverId, terminal.tabId)) }
        : {}),
      output,
    }
  }

  private scopePtyId(serverId: string, localId: string): string {
    if (serverId === this.currentServerId) return localId
    return scopedTerminalId(serverId, localId)
  }


  private ownerForPty(ptyId: string): Owner {
    const owner = this.ptyOwners.get(ptyId)
    if (owner) return owner
    return {
      serverId: this.activeConnection().definition.id,
      localId: ptyId,
    }
  }

  private scopeProcessOutput(
    serverId: string,
    output: MuxTerminal["output"],
  ): MuxTerminal["output"] {
    if (output.kind !== "process") return output
    return {
      ...output,
      terminalInstanceId: scopedTerminalId(serverId, output.terminalInstanceId),
      ...(output.ptyId
        ? { ptyId: this.scopePtyId(serverId, output.ptyId) }
        : {}),
    }
  }

  private scopeSnapshot(
    connection: ManagedConnection,
    snapshot: MuxSessionSnapshot,
  ): MuxSessionSnapshot {
    return {
      session: this.scopeSession(connection, snapshot.session),
      ...(snapshot.tabs
        ? { tabs: snapshot.tabs.map(tab => this.scopeTab(connection, tab)) }
        : {}),
      muxTerminals: snapshot.muxTerminals.map(terminal => this.scopeMuxTerminal(connection, terminal)),
    }
  }

  private scopeEvent(
    connection: ManagedConnection,
    event: MuxEventValue,
  ): MuxEventValue {
    switch (event._tag) {
      case "SessionCreated":
      case "SessionUpdated":
      case "SessionArchived":
      case "SessionRestored":
        return { ...event, session: this.scopeSession(connection, event.session) }
      case "SessionTabCreated":
      case "SessionTabUpdated":
      case "SessionTabArchived":
        return { ...event, tab: this.scopeTab(connection, event.tab) }
      case "MuxTerminalCreated":
      case "MuxTerminalUpdated":
        return {
          ...event,
          muxTerminalId: this.keepLocalIds(connection)
            ? event.muxTerminalId
            : publicMuxTerminalId(scopedId("term", connection.definition.id, event.muxTerminalId)),
          muxTerminal: this.scopeMuxTerminal(connection, event.muxTerminal),
        }
      case "TerminalOutputChanged":
        if (event.output.kind === "process" && event.output.ptyId) {
          const ptyId = this.keepLocalIds(connection)
            ? event.output.ptyId
            : this.scopePtyId(connection.definition.id, event.output.ptyId)
          this.ptyOwners.set(ptyId, {
            serverId: connection.definition.id,
            localId: event.output.ptyId,
          })
        }
        return {
          ...event,
          muxTerminalId: this.keepLocalIds(connection)
            ? event.muxTerminalId
            : publicMuxTerminalId(scopedId("term", connection.definition.id, event.muxTerminalId)),
          output: this.keepLocalIds(connection)
            ? event.output
            : this.scopeProcessOutput(connection.definition.id, event.output),
        }
      case "MuxTerminalArchived":
        return {
          ...event,
          muxTerminalId: this.keepLocalIds(connection)
            ? event.muxTerminalId
            : publicMuxTerminalId(scopedId("term", connection.definition.id, event.muxTerminalId)),
        }
    }
  }

  private createTerminal(): HostTerminal {
    const self = this
    return {
      create: async (cwdUri, launch) => {
        const connection = self.activeConnection()
        const local = await connection.api.terminal.create(cwdUri, launch)
        const id = self.scopePtyId(connection.definition.id, local.id)
        self.ptyOwners.set(id, { serverId: connection.definition.id, localId: local.id })
        return { ...local, id }
      },
      attach: (id, options) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.attach(
          owner.localId,
          options,
        )
      },
      write: (id, data) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.write(owner.localId, data)
      },
      writeBinary: (id, data) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.writeBinary(owner.localId, data)
      },
      resize: (id, cols, rows) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.resize(owner.localId, cols, rows)
      },
      setTheme: (id, theme) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.setTheme(owner.localId, theme)
      },
      markReplayReady: (id) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.markReplayReady(owner.localId)
      },
      getCwd: (id) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.getCwd(owner.localId)
      },
      getForegroundProcess: (id) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.getForegroundProcess(owner.localId)
      },
      onData: (id, callback, options) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.onData(
          owner.localId,
          callback,
          options,
        )
      },
      onSemanticSnapshot: (id, callback) => {
        const owner = self.ownerForPty(id)
        const subscribe = self.connectionForOwner(owner).api.terminal.onSemanticSnapshot
        return subscribe?.(owner.localId, callback) ?? (() => undefined)
      },
      onExit: (callback) => {
        self.terminalExitListeners.add(callback)
        return () => self.terminalExitListeners.delete(callback)
      },
      dispose: (id) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.dispose(owner.localId)
      },
      acquireLease: (id, mode) => {
        const owner = self.ownerForPty(id)
        return mode === undefined
          ? self.connectionForOwner(owner).api.terminal.acquireLease(owner.localId)
          : self.connectionForOwner(owner).api.terminal.acquireLease(owner.localId, mode)
      },
      renewLease: (id, leaseId) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.renewLease(owner.localId, leaseId)
      },
      releaseLease: (id, leaseId) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.releaseLease(owner.localId, leaseId)
      },
      requestControl: id => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.requestControl(owner.localId)
      },
      transferControl: (id, leaseId, targetClientId) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.transferControl(owner.localId, leaseId, targetClientId)
      },
      listViewers: id => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.listViewers(owner.localId)
      },
    }
  }

  private toLocalCommand(command: unknown): unknown {
    if (!isRecord(command) || typeof command._tag !== "string") return command
    switch (command._tag) {
      case "CreateSessionTab": {
        const owner = this.ownerForSession(String(command.sessionId))
        return { ...command, sessionId: publicSessionId(owner.localId) }
      }
      case "RenameSessionTab":
      case "SaveSessionTabLayout":
      case "ArchiveSessionTab": {
        const owner = this.ownerForTab(String(command.tabId))
        return { ...command, tabId: publicTabId(owner.localId) }
      }
      case "ReorderSessionTabs":
      case "SelectSessionTab": {
        const owner = this.ownerForSession(String(command.sessionId))
        const tabIds = Array.isArray(command.tabIds)
          ? command.tabIds.map(value => publicTabId(this.ownerForTab(String(value)).localId))
          : undefined
        return {
          ...command,
          sessionId: publicSessionId(owner.localId),
          ...(tabIds ? { tabIds } : {}),
          ...(command.tabId
            ? { tabId: publicTabId(this.ownerForTab(String(command.tabId)).localId) }
            : {}),
        }
      }
      case "ArchiveSession":
      case "RestoreSession":
      case "RenameSession": {
        const owner = this.ownerForSession(String(command.sessionId))
        return { ...command, sessionId: publicSessionId(owner.localId) }
      }
      case "CreateTerminal": {
        const owner = this.ownerForSession(String(command.sessionId))
        return {
          ...command,
          sessionId: publicSessionId(owner.localId),
          ...(command.tabId
            ? { tabId: publicTabId(this.ownerForTab(String(command.tabId)).localId) }
            : {}),
        }
      }
      case "ReorderTerminals": {
        const owner = this.ownerForSession(String(command.sessionId))
        return {
          ...command,
          sessionId: publicSessionId(owner.localId),
          ...(command.tabId
            ? { tabId: publicTabId(this.ownerForTab(String(command.tabId)).localId) }
            : {}),
          muxTerminalIds: Array.isArray(command.muxTerminalIds)
            ? command.muxTerminalIds.map(value => publicMuxTerminalId(this.ownerForMuxTerminal(String(value)).localId))
            : command.muxTerminalIds,
        }
      }
      case "MoveTerminalToTab": {
        const terminalOwner = this.ownerForMuxTerminal(String(command.muxTerminalId))
        const tabOwner = this.ownerForTab(String(command.targetTabId))
        if (terminalOwner.serverId !== tabOwner.serverId) {
          throw new Error("A terminal cannot move between YAADE servers")
        }
        return {
          ...command,
          muxTerminalId: publicMuxTerminalId(terminalOwner.localId),
          targetTabId: publicTabId(tabOwner.localId),
        }
      }
      case "CancelMuxTerminal":
      case "RestartMuxTerminal":
      case "CloseTerminal": {
        const owner = this.ownerForMuxTerminal(String(command.muxTerminalId))
        return { ...command, muxTerminalId: publicMuxTerminalId(owner.localId) }
      }
      case "SelectSessionMuxTerminal": {
        const owner = this.ownerForSession(String(command.sessionId))
        return {
          ...command,
          sessionId: publicSessionId(owner.localId),
          ...(command.muxTerminalId
            ? { muxTerminalId: publicMuxTerminalId(this.ownerForMuxTerminal(String(command.muxTerminalId)).localId) }
            : {}),
        }
      }
      default:
        return command
    }
  }

  private createMux(): HostMux {
    const self = this
    return {
      listSessions: async includeArchived => {
        let succeeded = 0
        const results = await Promise.all(
          [...self.connections.values()].map(async connection => {
            try {
              const snapshots = await connection.api.mux.listSessions(includeArchived)
              connection.status = "connected"
              connection.error = undefined
              connection.sessionCount = snapshots.filter(snapshot => !snapshot.session.archivedAt).length
              succeeded += 1
              return snapshots.map(snapshot => self.scopeSnapshot(connection, snapshot))
            } catch (error) {
              connection.status = "offline"
              connection.error = errorMessage(error)
              return []
            }
          }),
        )
        self.snapshot = self.makeSnapshot()
        self.publish()
        if (succeeded === 0 && self.connections.size > 0) {
          throw new Error("No YAADE servers are reachable")
        }
        return results.flat()
      },
      reorderSessions: async command => {
        const grouped = new Map<string, SessionId[]>()
        for (const id of command.sessionIds) {
          const owner = self.ownerForSession(id)
          const ids = grouped.get(owner.serverId) ?? []
          ids.push(publicSessionId(owner.localId))
          grouped.set(owner.serverId, ids)
        }
        const results: AppSessionValue[] = []
        for (const [serverId, sessionIds] of grouped) {
          const connection = self.connections.get(serverId)
          if (!connection) continue
          const local = await connection.api.mux.reorderSessions({ ...command, sessionIds })
          results.push(...local.map(session => self.scopeSession(connection, session)))
        }
        return results
      },
      createTab: async command => {
        const owner = self.ownerForSession(command.sessionId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.createTab(
          Schema.decodeUnknownSync(CreateSessionTab)(self.toLocalCommand(command)),
        )
        return self.scopeTab(connection, local)
      },
      renameTab: async command => {
        const owner = self.ownerForTab(command.tabId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.renameTab(
          Schema.decodeUnknownSync(RenameSessionTab)(self.toLocalCommand(command)),
        )
        return self.scopeTab(connection, local)
      },
      saveTabLayout: async command => {
        const owner = self.ownerForTab(command.tabId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.saveTabLayout(
          Schema.decodeUnknownSync(SaveSessionTabLayout)(self.toLocalCommand(command)),
        )
        return self.scopeTab(connection, local)
      },
      reorderTabs: async command => {
        const owner = self.ownerForSession(command.sessionId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.reorderTabs(
          Schema.decodeUnknownSync(ReorderSessionTabs)(self.toLocalCommand(command)),
        )
        return local.map(tab => self.scopeTab(connection, tab))
      },
      archiveTab: async command => {
        const owner = self.ownerForTab(command.tabId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.archiveTab(
          Schema.decodeUnknownSync(ArchiveSessionTab)(self.toLocalCommand(command)),
        )
        return self.scopeTab(connection, local)
      },
      selectTab: async command => {
        const owner = self.ownerForSession(command.sessionId)
        const connection = self.connectionForOwner(owner)
        self.selectServer(owner.serverId)
        const local = await connection.api.mux.selectTab(
          Schema.decodeUnknownSync(SelectSessionTab)(self.toLocalCommand(command)),
        )
        return self.scopeSession(connection, local)
      },
      archiveSession: async command => {
        const owner = self.ownerForSession(command.sessionId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.archiveSession(
          Schema.decodeUnknownSync(ArchiveSession)(self.toLocalCommand(command)),
        )
        return self.scopeSession(connection, local)
      },
      restoreSession: async command => {
        const owner = self.ownerForSession(command.sessionId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.restoreSession(
          Schema.decodeUnknownSync(RestoreSession)(self.toLocalCommand(command)),
        )
        return self.scopeSession(connection, local)
      },
      createSession: async title => {
        const connection = self.activeConnection()
        const local = await connection.api.mux.createSession(title)
        return self.scopeSession(connection, local)
      },
      renameSession: async (sessionId, title) => {
        const owner = self.ownerForSession(sessionId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.renameSession(publicSessionId(owner.localId), title)
        return self.scopeSession(connection, local)
      },
      getSession: async sessionId => {
        const owner = self.ownerForSession(sessionId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.getSession(publicSessionId(owner.localId))
        return local ? self.scopeSnapshot(connection, local) : null
      },
      createTerminal: async command => {
        const owner = self.ownerForSession(command.sessionId)
        const connection = self.connectionForOwner(owner)
        self.selectServer(owner.serverId)
        const local = await connection.api.mux.createTerminal(
          Schema.decodeUnknownSync(CreateTerminal)(self.toLocalCommand(command)),
        )
        return self.scopeMuxTerminal(connection, local)
      },
      getTerminal: async muxTerminalId => {
        const owner = self.ownerForMuxTerminal(muxTerminalId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.getTerminal(publicMuxTerminalId(owner.localId))
        return local ? self.scopeMuxTerminal(connection, local) : null
      },
      reorderTerminals: async command => {
        const owner = self.ownerForSession(command.sessionId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.reorderTerminals(
          Schema.decodeUnknownSync(ReorderTerminals)(self.toLocalCommand(command)),
        )
        return local.map(terminal => self.scopeMuxTerminal(connection, terminal))
      },
      moveTerminal: async command => {
        const owner = self.ownerForMuxTerminal(command.muxTerminalId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.moveTerminal(
          Schema.decodeUnknownSync(MoveTerminalToTab)(self.toLocalCommand(command)),
        )
        return self.scopeMuxTerminal(connection, local)
      },
      selectTerminal: async (sessionId, muxTerminalId) => {
        const owner = self.ownerForSession(sessionId)
        const connection = self.connectionForOwner(owner)
        self.selectServer(owner.serverId)
        const local = await connection.api.mux.selectTerminal(
          publicSessionId(owner.localId),
          muxTerminalId ? publicMuxTerminalId(self.ownerForMuxTerminal(muxTerminalId).localId) : undefined,
        )
        return self.scopeSession(connection, local)
      },
      stopTerminal: async (muxTerminalId, revision) => {
        const owner = self.ownerForMuxTerminal(muxTerminalId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.stopTerminal(publicMuxTerminalId(owner.localId), revision)
        return self.scopeMuxTerminal(connection, local)
      },
      restartTerminal: async (muxTerminalId, revision) => {
        const owner = self.ownerForMuxTerminal(muxTerminalId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.restartTerminal(publicMuxTerminalId(owner.localId), revision)
        return self.scopeMuxTerminal(connection, local)
      },
      closeTerminal: async command => {
        const owner = self.ownerForMuxTerminal(command.muxTerminalId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.closeTerminal(
          Schema.decodeUnknownSync(CloseTerminal)(self.toLocalCommand(command)),
        )
        return self.scopeMuxTerminal(connection, local)
      },
      renameTerminal: async (muxTerminalId, title) => {
        const owner = self.ownerForMuxTerminal(muxTerminalId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.mux.renameTerminal(publicMuxTerminalId(owner.localId), title)
        return self.scopeMuxTerminal(connection, local)
      },
      onEvent: callback => self.onMuxEvent(callback),
    }
  }

  private connectionInfo(serverId: string): YaadeServerConnection | undefined {
    const connection = this.connections.get(serverId)
    if (!connection) return undefined
    return {
      id: connection.definition.id,
      name: connection.definition.name,
      url: connection.definition.url,
      status: connection.status,
      sessionCount: connection.sessionCount,
      ...(connection.error ? { error: connection.error } : {}),
    }
  }

  private makeSnapshot(): MultiServerSnapshot {
    return {
      connections: [...this.connections.keys()]
        .map(id => this.connectionInfo(id))
        .filter((value): value is YaadeServerConnection => Boolean(value)),
      activeServerId: this.activeServerId,
      generation: this.generation,
    }
  }

  private publishGlobal(): void {
    const active = this.activeServerId
      ? this.connections.get(this.activeServerId)
      : undefined
    if (active) {
      Object.assign(this.ports, active.api, {
        mux: this.mux,
        terminal: this.aggregateTerminal,
      })
    }
    this.globalTarget?.setYaade(this.ports)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

export function createMultiServerHostClient(options: {
  readonly currentServer: YaadeServerDefinition
  readonly servers?: readonly YaadeServerDefinition[]
  readonly globalTarget?: MultiServerGlobalTarget
}): MultiServerHostClient {
  return new MultiServerHostClient(options)
}

export { SERVER_STORAGE_KEY }
