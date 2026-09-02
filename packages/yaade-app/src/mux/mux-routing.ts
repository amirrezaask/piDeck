import { Schema } from "effect"
import {
  AppSession,
  SessionId,
  SessionTabId,
  MuxTerminalId,
  type SessionTab,
  type SessionId as SessionIdType,
  type MuxTerminalId as MuxTerminalIdType,
} from "@yaade/rpc"

export type MuxSessionRoute = {
  sessionId?: SessionIdType
  tabId?: SessionTabId
  muxTerminalId?: MuxTerminalIdType
}

function optionalSessionId(value: string | null): SessionIdType | undefined {
  if (!value) return undefined
  try {
    return Schema.decodeUnknownSync(SessionId)(value)
  } catch {
    return undefined
  }
}

function optionalTabId(value: string | null): SessionTabId | undefined {
  if (!value) return undefined
  try {
    return Schema.decodeUnknownSync(SessionTabId)(value)
  } catch {
    return undefined
  }
}

function optionalMuxTerminalId(value: string | null): MuxTerminalIdType | undefined {
  if (!value) return undefined
  try {
    return Schema.decodeUnknownSync(MuxTerminalId)(value)
  } catch {
    return undefined
  }
}

export function parseMuxSessionRoute(input: string | URL): MuxSessionRoute {
  const url = typeof input === "string" ? new URL(input, "http://yaade.local") : input
  const sessionId = optionalSessionId(url.searchParams.get("s"))
  const tabId = optionalTabId(url.searchParams.get("t"))
  const muxTerminalId = optionalMuxTerminalId(url.searchParams.get("term"))
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(tabId ? { tabId } : {}),
    ...(muxTerminalId ? { muxTerminalId } : {}),
  }
}

function isSessionTabId(value: SessionTabId | MuxTerminalIdType): value is SessionTabId {
  return value.startsWith("tab-")
}

function isMuxTerminalId(value: SessionTabId | MuxTerminalIdType): value is MuxTerminalIdType {
  return value.startsWith("term-")
}

/** Build a deep link using tmux's session/window/pane hierarchy. */
export function muxSessionUrl(
  sessionId: SessionIdType,
  tabOrMuxTerminalId?: SessionTabId | MuxTerminalIdType,
  muxTerminalId?: MuxTerminalIdType,
): string {
  const params = new URLSearchParams({ s: sessionId })
  const tabId = tabOrMuxTerminalId && isSessionTabId(tabOrMuxTerminalId)
    ? tabOrMuxTerminalId
    : undefined
  const paneId = muxTerminalId ?? (
    tabOrMuxTerminalId && isMuxTerminalId(tabOrMuxTerminalId)
      ? tabOrMuxTerminalId
      : undefined
  )
  if (tabId) params.set("t", tabId)
  if (paneId) params.set("term", paneId)
  return `/?${params.toString()}`
}

export const LAST_MUX_SESSION_ROUTE_KEY = "yaade:last-terminal-multiplexer-route"

export function persistMuxSessionRoute(
  url: string,
  storage: Pick<Storage, "setItem">,
): void {
  try {
    storage.setItem(LAST_MUX_SESSION_ROUTE_KEY, url)
  } catch {
    /* private mode / quota */
  }
}

export function readPersistedMuxSessionRoute(
  storage: Pick<Storage, "getItem">,
): string | undefined {
  try {
    return storage.getItem(LAST_MUX_SESSION_ROUTE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export function resolveMuxSessionRoute(
  href: string,
  storage: Pick<Storage, "getItem">,
): MuxSessionRoute {
  const live = parseMuxSessionRoute(href)
  if (live.sessionId) return live
  const saved = readPersistedMuxSessionRoute(storage)
  if (!saved) return live
  const restored = parseMuxSessionRoute(saved)
  return restored.sessionId ? restored : live
}

/** Strip `ses-`/`tab-`/`term-` and an optional `serverId--` multi-server prefix. */
export function localResourceKey(id: string): string {
  const rest = id.replace(/^(ses|tab|term)-/, "")
  const split = rest.indexOf("--")
  return split === -1 ? rest : rest.slice(split + 2)
}

export function sameLocalResource(left?: string, right?: string): boolean {
  if (!left || !right) return false
  return left === right || localResourceKey(left) === localResourceKey(right)
}

function findUniqueId<T extends string>(
  requested: string | undefined,
  ids: readonly T[],
): T | undefined {
  if (!requested) return undefined
  const exact = ids.find(id => id === requested)
  if (exact) return exact
  const key = localResourceKey(requested)
  return ids.find(id => localResourceKey(id) === key)
}

function findUniqueByLocalKey<T extends { readonly id: string }>(
  requested: string | undefined,
  items: readonly T[],
): T | undefined {
  const id = findUniqueId(requested, items.map(item => item.id))
  return id ? items.find(item => item.id === id) : undefined
}

function loadedId(
  requested: string | undefined,
  ids: Iterable<string>,
): string | undefined {
  return findUniqueId(requested, [...ids])
}

export function shouldHoldRequestedRoute(
  route: MuxSessionRoute,
  loaded: {
    readonly sessionsById: ReadonlyMap<string, unknown>
    readonly tabsById: ReadonlyMap<string, unknown>
    readonly terminalsById: ReadonlyMap<string, unknown>
  },
  connection: "connecting" | "connected" | "reconciling" | "offline",
): boolean {
  const requestedMissing =
    Boolean(route.sessionId && !loadedId(route.sessionId, loaded.sessionsById.keys())) ||
    Boolean(route.tabId && !loadedId(route.tabId, loaded.tabsById.keys())) ||
    Boolean(route.muxTerminalId && !loadedId(route.muxTerminalId, loaded.terminalsById.keys()))
  if (!requestedMissing) return false
  return connection !== "connected"
}

export function chooseSession(
  requested: SessionIdType | undefined,
  sessions: readonly AppSession[],
): AppSession | undefined {
  const visible = sessions.filter(session => !session.archivedAt)
  if (requested) return findUniqueByLocalKey(requested, visible)
  return [...visible].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

export function isLiveSessionTab(
  session: AppSession | undefined,
  tab: SessionTab | undefined,
): boolean {
  return Boolean(
    session &&
      !session.archivedAt &&
      tab &&
      !tab.archivedAt &&
      tab.sessionId === session.id,
  )
}

export function chooseTab(
  requested: SessionTabId | undefined,
  session: AppSession | undefined,
  tabs: readonly SessionTab[],
  owningTabId?: SessionTabId,
): SessionTab | undefined {
  if (!session) return undefined
  const visible = tabs
    .filter(tab => tab.sessionId === session.id && !tab.archivedAt)
    .sort((a, b) => a.position - b.position)
  return (
    findUniqueByLocalKey(requested, visible) ??
    findUniqueByLocalKey(owningTabId, visible) ??
    findUniqueByLocalKey(session.activeTabId, visible) ??
    visible[0]
  )
}

export function chooseMuxTerminal(
  requested: MuxTerminalIdType | undefined,
  tab: SessionTab | AppSession | undefined,
  muxTerminalIds: readonly MuxTerminalIdType[],
): MuxTerminalIdType | undefined {
  if (!tab) return undefined
  const requestedMatch = findUniqueId(requested, muxTerminalIds)
  if (requestedMatch) return requestedMatch
  const activeMatch = findUniqueId(tab.activeMuxTerminalId, muxTerminalIds)
  if (activeMatch) return activeMatch
  return muxTerminalIds[0]
}
