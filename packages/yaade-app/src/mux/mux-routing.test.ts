import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { Schema } from "effect"
import { AppSession, SessionId, SessionTab, SessionTabId, MuxTerminalId } from "@yaade/rpc"
import {
  chooseSession,
  chooseTab,
  chooseMuxTerminal,
  isLiveSessionTab,
  localResourceKey,
  parseMuxSessionRoute,
  persistMuxSessionRoute,
  resolveMuxSessionRoute,
  shouldHoldRequestedRoute,
  muxSessionUrl,
} from "./mux-routing.js"

const sessionA = AppSession.make({ id: Schema.decodeUnknownSync(SessionId)("ses-a"), title: "A", position: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01" })
const sessionB = AppSession.make({ id: Schema.decodeUnknownSync(SessionId)("ses-b"), title: "B", position: 1, createdAt: "2026-01-02", updatedAt: "2026-01-03" })

describe("terminal session routing", () => {
  it("parses and serializes the global session URL", () => {
    const sessionId = Schema.decodeUnknownSync(SessionId)("ses-a")
    const tabId = Schema.decodeUnknownSync(SessionTabId)("tab-a")
    const terminalId = Schema.decodeUnknownSync(MuxTerminalId)("term-a")
    assert.deepEqual(parseMuxSessionRoute(muxSessionUrl(sessionId, tabId, terminalId)), { sessionId, tabId, muxTerminalId: terminalId })
    assert.deepEqual(parseMuxSessionRoute(muxSessionUrl(sessionId, terminalId)), { sessionId, muxTerminalId: terminalId })
  })

  it("resolves host-local deep links against multi-server scoped ids", () => {
    const local = Schema.decodeUnknownSync(SessionId)("ses-aaaa1111")
    const scoped = Schema.decodeUnknownSync(SessionId)("ses-local--aaaa1111")
    const other = Schema.decodeUnknownSync(SessionId)("ses-local--bbbb2222")
    const scopedSession = AppSession.make({
      id: scoped,
      title: "A02",
      position: 1,
      createdAt: "2026-01-04",
      updatedAt: "2026-01-04",
    })
    const otherSession = AppSession.make({
      id: other,
      title: "Session 1",
      position: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    })
    assert.equal(chooseSession(local, [otherSession, scopedSession])?.id, scoped)
    assert.equal(chooseSession(local, [otherSession]), undefined)
    const route = parseMuxSessionRoute(`/?s=${local}`)
    const loaded = {
      sessionsById: new Map([[scoped, scopedSession]]),
      tabsById: new Map(),
      terminalsById: new Map(),
    }
    assert.equal(shouldHoldRequestedRoute(route, loaded, "connecting"), false)
    assert.equal(
      shouldHoldRequestedRoute(route, { sessionsById: new Map(), tabsById: new Map(), terminalsById: new Map() }, "connecting"),
      true,
    )
  })

  it("normalizes local and server-scoped resource ids consistently", () => {
    assert.deepEqual(
      [
        "ses-local",
        "ses-server-a--local",
        "tab-local",
        "tab-server-a--local",
        "term-local",
        "term-server-a--local",
      ].map(localResourceKey),
      ["local", "local", "local", "local", "local", "local"],
    )
  })

  it("holds a deep link until the requested session is loaded", () => {
    const route = parseMuxSessionRoute(muxSessionUrl(sessionA.id))
    const empty = {
      sessionsById: new Map(),
      tabsById: new Map(),
      terminalsById: new Map(),
    }
    const loaded = {
      sessionsById: new Map([[sessionA.id, sessionA]]),
      tabsById: new Map(),
      terminalsById: new Map(),
    }
    assert.equal(shouldHoldRequestedRoute(route, empty, "connecting"), true)
    assert.equal(shouldHoldRequestedRoute(route, empty, "reconciling"), true)
    assert.equal(shouldHoldRequestedRoute(route, empty, "connected"), false)
    assert.equal(shouldHoldRequestedRoute(route, loaded, "connecting"), false)
    assert.equal(shouldHoldRequestedRoute(route, loaded, "connected"), false)
  })

  it("falls back to a session's persisted active terminal", () => {
    const terminalId = Schema.decodeUnknownSync(MuxTerminalId)("term-a")
    const active = AppSession.make({ ...sessionA, activeMuxTerminalId: terminalId })
    assert.equal(chooseMuxTerminal(undefined, active, [terminalId]), terminalId)
    assert.equal(chooseMuxTerminal(undefined, sessionA, [terminalId]), terminalId)
  })

  it("resolves a terminal's owning window when the URL omits t", () => {
    const tabA = SessionTab.make({
      id: Schema.decodeUnknownSync(SessionTabId)("tab-a"),
      sessionId: sessionA.id,
      title: "Window 1",
      position: 0,
      createdAt: sessionA.createdAt,
      updatedAt: sessionA.updatedAt,
    })
    const tabB = SessionTab.make({
      id: Schema.decodeUnknownSync(SessionTabId)("tab-b"),
      sessionId: sessionA.id,
      title: "Window 2",
      position: 1,
      createdAt: sessionA.createdAt,
      updatedAt: sessionA.updatedAt,
    })
    const chosen = chooseTab(undefined, sessionA, [tabA, tabB], tabB.id)
    assert.equal(chosen?.id, tabB.id)
  })

  it("restores the last session route when the URL has no s", () => {
    const memory = new Map<string, string>()
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value)
      },
    }
    const url = muxSessionUrl(sessionA.id, Schema.decodeUnknownSync(SessionTabId)("tab-a"))
    persistMuxSessionRoute(url, storage)
    assert.equal(resolveMuxSessionRoute("/", storage).sessionId, sessionA.id)
    assert.equal(resolveMuxSessionRoute("/?s=ses-b", storage).sessionId, sessionB.id)
  })

  it("rejects archived or cross-session tabs as terminal targets", () => {
    const tab = SessionTab.make({
      id: Schema.decodeUnknownSync(SessionTabId)("tab-a"),
      sessionId: sessionA.id,
      title: "Window 1",
      position: 0,
      createdAt: sessionA.createdAt,
      updatedAt: sessionA.updatedAt,
    })
    assert.equal(isLiveSessionTab(sessionA, tab), true)
    assert.equal(isLiveSessionTab(sessionB, tab), false)
    assert.equal(
      isLiveSessionTab(sessionA, { ...tab, archivedAt: "2026-01-04" }),
      false,
    )
  })
})
