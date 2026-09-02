import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { Schema } from "effect"
import { AppSession, SessionTab, SessionTabId, SessionId, MuxTerminalId, type MuxTerminal } from "@yaade/rpc"
import { MuxSessionStore } from "./mux-store.js"
import {
  nextRuntimeTerminalTitle,
  muxTerminalDisplayTitle,
  muxTerminalPaneTitle,
  muxTerminalWorkTitle,
} from "./terminal-title.js"

const sessionId = Schema.decodeUnknownSync(SessionId)("ses-a")
const terminalId = Schema.decodeUnknownSync(MuxTerminalId)("term-a")

function session(): AppSession {
  return AppSession.make({ id: sessionId, title: "A", position: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01" })
}

function makeTerminal(): MuxTerminal {
  return {
    id: terminalId,
    sessionId,
    kind: "terminal",
    title: "Shell",
    position: 0,
    status: "running",
    input: { _tag: "TerminalInput", kind: "terminal" },
    inputRevision: 1,
    output: {
      _tag: "TerminalOutput",
      kind: "process",
      terminalInstanceId: "term",
      generation: 1,
      processState: "running",
      activityState: "idle",
      replayAvailable: true,
      truncated: false,
    },
    revision: 1,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  }
}

describe("smart MuxTerminal titles", () => {
  it("terminals terminal titles", () => {
    const terminal = makeTerminal()
    assert.equal(muxTerminalWorkTitle(terminal), "Shell")
    assert.equal(muxTerminalDisplayTitle(terminal), "Shell")
  })

  it("terminals a terminal's live title", () => {
    const terminal = makeTerminal()
    const live = nextRuntimeTerminalTitle(terminal, undefined, "fish · ~/dev/yaade", "terminal")
    assert.equal(muxTerminalDisplayTitle(terminal, live), "fish · ~/dev/yaade")
    assert.equal(muxTerminalPaneTitle(terminal, live), "fish")

    const cwdOnly = nextRuntimeTerminalTitle(terminal, undefined, "~/dev/yaade", "terminal")
    assert.equal(muxTerminalPaneTitle(terminal, cwdOnly), "")
  })
})

describe("MuxSessionStore browser state", () => {
  it("keeps normalized snapshots stable until a mutation", () => {
    const store = new MuxSessionStore()
    const first = store.getSnapshot()
    store.replace([session()], [makeTerminal()])
    const second = store.getSnapshot()
    assert.notEqual(first, second)
    assert.equal(store.getSnapshot(), second)
    store.setConnection("connected")
    assert.notEqual(store.getSnapshot(), second)
    assert.equal(store.getSnapshot().terminalsById.get(terminalId)?.title, "Shell")
  })

  it("keeps membership indexes stable for output-only MuxTerminal updates", () => {
    const store = new MuxSessionStore()
    store.replace([session()], [makeTerminal()])
    const before = store.getSnapshot()

    store.apply({
      _tag: "MuxTerminalUpdated",
      eventId: "event-output-only",
      muxTerminalId: terminalId,
      muxTerminal: {
        ...makeTerminal(),
        status: "running",
        revision: 2,
        updatedAt: "2026-01-02",
      },
      revision: 2,
      occurredAt: "2026-01-02",
    })

    const after = store.getSnapshot()
    assert.equal(after.terminalIdsBySession, before.terminalIdsBySession)
    assert.equal(after.terminalIdsByTab, before.terminalIdsByTab)
  })

  it("notifies only the affected terminal subscription", () => {
    const store = new MuxSessionStore()
    store.replace([session()], [makeTerminal()])
    let terminalNotifications = 0
    let otherNotifications = 0
    const otherId = Schema.decodeUnknownSync(MuxTerminalId)("term-b")
    const disposeTerminal = store.subscribeMuxTerminal(terminalId, () => { terminalNotifications += 1 })
    const disposeOther = store.subscribeMuxTerminal(otherId, () => { otherNotifications += 1 })
    store.apply({
      _tag: "MuxTerminalUpdated",
      eventId: "event-1",
      muxTerminalId: terminalId,
      muxTerminal: { ...makeTerminal(), title: "Updated", revision: 2, updatedAt: "2026-01-02" },
      revision: 2,
      occurredAt: "2026-01-02",
    })
    assert.equal(terminalNotifications, 1)
    assert.equal(otherNotifications, 0)
    disposeTerminal()
    disposeOther()
  })

  it("notifies session subscribers for realtime session changes", () => {
    const store = new MuxSessionStore()
    store.replace([session()], [makeTerminal()])
    let notifications = 0
    const dispose = store.subscribeSession(sessionId, () => { notifications += 1 })
    store.apply({
      _tag: "SessionUpdated",
      eventId: "session-update",
      revision: 2,
      occurredAt: "2026-01-02",
      session: { ...session(), title: "Renamed", revision: 2, updatedAt: "2026-01-02" },
    })
    assert.equal(notifications, 1)
    dispose()
  })

  it("does not let an older snapshot overwrite a realtime update", () => {
    const store = new MuxSessionStore()
    store.replace([session()], [makeTerminal()])
    const baseline = store.captureRevisions()
    store.apply({
      _tag: "MuxTerminalUpdated",
      eventId: "newer",
      muxTerminalId: terminalId,
      muxTerminal: { ...makeTerminal(), title: "Newer", revision: 2, updatedAt: "2026-01-02" },
      revision: 2,
      occurredAt: "2026-01-02",
    })
    store.mergeSnapshot([session()], [makeTerminal()], [], false, baseline)
    assert.equal(store.getSnapshot().terminalsById.get(terminalId)?.title, "Newer")
  })

  it("does not resurrect an archived terminal from a late update", () => {
    const store = new MuxSessionStore()
    store.replace([session()], [makeTerminal()])
    store.apply({
      _tag: "MuxTerminalArchived", eventId: "archive", muxTerminalId: terminalId,
      revision: 2, occurredAt: "2026-01-02",
    })
    store.apply({
      _tag: "MuxTerminalUpdated", eventId: "late", muxTerminalId: terminalId,
      muxTerminal: { ...makeTerminal(), title: "Late", revision: 3, updatedAt: "2026-01-03" },
      revision: 3, occurredAt: "2026-01-03",
    })
    assert.equal(store.getSnapshot().terminalsById.get(terminalId)?.archivedAt, "2026-01-02")
    assert.deepEqual(store.getSnapshot().terminalIdsBySession.get(sessionId), [])
  })

  it("keeps active-terminal navigation local across another client's update", () => {
    const store = new MuxSessionStore()
    const tabId = Schema.decodeUnknownSync(SessionTabId)("tab-a")
    const otherId = Schema.decodeUnknownSync(MuxTerminalId)("term-b")
    const first = { ...makeTerminal(), tabId }
    const second = { ...makeTerminal(), id: otherId, tabId, position: 1 }
    const tab = SessionTab.make({
      id: tabId,
      sessionId,
      title: "Window 1",
      position: 0,
      activeMuxTerminalId: first.id,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    })
    store.replace([session()], [first, second], [tab])
    store.selectMuxTerminal(first.id)
    store.apply({
      _tag: "SessionTabUpdated",
      eventId: "tab-focus",
      revision: 2,
      occurredAt: "2026-01-02",
      tab: { ...tab, activeMuxTerminalId: second.id, revision: 2, updatedAt: "2026-01-02" },
    })
    assert.equal(store.getSnapshot().activeMuxTerminalId, first.id)
  })

  it("keeps a newer local pane selection across layout-only tab updates", () => {
    const store = new MuxSessionStore()
    const tabId = Schema.decodeUnknownSync(SessionTabId)("tab-a")
    const otherId = Schema.decodeUnknownSync(MuxTerminalId)("term-b")
    const first = { ...makeTerminal(), tabId }
    const second = { ...makeTerminal(), id: otherId, tabId, position: 1 }
    const tab = SessionTab.make({
      id: tabId,
      sessionId,
      title: "Window 1",
      position: 0,
      activeMuxTerminalId: first.id,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    })
    store.replace([session()], [first, second], [tab])
    store.selectMuxTerminal(second.id)
    store.apply({
      _tag: "SessionTabUpdated",
      eventId: "layout-save",
      revision: 2,
      occurredAt: "2026-01-02",
      tab: { ...tab, layoutJson: "{}", revision: 2, updatedAt: "2026-01-02" },
    })
    assert.equal(store.getSnapshot().activeMuxTerminalId, second.id)
  })

  it("ignores duplicate and older revisions", () => {
    const store = new MuxSessionStore()
    store.replace([session()], [makeTerminal()])
    store.apply({
      _tag: "MuxTerminalUpdated", eventId: "event-2", muxTerminalId: terminalId,
      muxTerminal: { ...makeTerminal(), title: "Newest", revision: 4, updatedAt: "2026-01-04" }, revision: 4, occurredAt: "2026-01-04",
    })
    store.apply({
      _tag: "MuxTerminalUpdated", eventId: "event-1", muxTerminalId: terminalId,
      muxTerminal: { ...makeTerminal(), title: "Old", revision: 3, updatedAt: "2026-01-03" }, revision: 3, occurredAt: "2026-01-03",
    })
    assert.equal(store.getSnapshot().terminalsById.get(terminalId)?.title, "Newest")
  })

  it("removes archived terminals from the visible session list", () => {
    const store = new MuxSessionStore()
    store.replace([session()], [makeTerminal()])
    store.apply({
      _tag: "MuxTerminalArchived", eventId: "archive-1", muxTerminalId: terminalId,
      revision: 2, occurredAt: "2026-01-02",
    })
    assert.deepEqual(store.getSnapshot().terminalIdsBySession.get(sessionId), [])
    assert.equal(store.getSnapshot().terminalsById.get(terminalId)?.archivedAt, "2026-01-02")
  })

  it("stages terminal close without changing authoritative revisions and rolls back once", () => {
    const store = new MuxSessionStore()
    store.replace([session()], [makeTerminal()])
    const before = store.getSnapshot().terminalsById.get(terminalId)
    let publications = 0
    store.subscribe(() => { publications += 1 })

    const pending = store.stageTerminalClose(terminalId)
    assert.ok(pending)
    assert.deepEqual(store.getSnapshot().terminalIdsBySession.get(sessionId), [])
    assert.equal(store.getSnapshot().terminalsById.get(terminalId), before)
    assert.equal(store.stageTerminalClose(terminalId), null)
    pending.rollback()
    assert.deepEqual(store.getSnapshot().terminalIdsBySession.get(sessionId), [terminalId])
    assert.equal(publications, 2)
  })

  it("keeps a pending Window and its terminals hidden across realtime updates", () => {
    const store = new MuxSessionStore()
    const tabId = Schema.decodeUnknownSync(SessionTabId)("tab-close")
    const tab = SessionTab.make({
      id: tabId,
      sessionId,
      title: "Window 1",
      position: 0,
      activeMuxTerminalId: terminalId,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    })
    store.replace([session()], [{ ...makeTerminal(), tabId }], [tab])
    const pending = store.stageTabClose(tabId)
    assert.ok(pending)
    assert.deepEqual(store.getSnapshot().visibleTabIdsBySession.get(sessionId) ?? [], [])
    assert.deepEqual(store.getSnapshot().terminalIdsBySession.get(sessionId), [])

    store.apply({
      _tag: "MuxTerminalUpdated",
      eventId: "pending-update",
      muxTerminalId: terminalId,
      muxTerminal: { ...makeTerminal(), tabId, title: "Authoritative", revision: 2, updatedAt: "2026-01-02" },
      revision: 2,
      occurredAt: "2026-01-02",
    })
    assert.deepEqual(store.getSnapshot().terminalIdsBySession.get(sessionId), [])
    pending.rollback()
    assert.equal(store.getSnapshot().terminalsById.get(terminalId)?.title, "Authoritative")
    assert.deepEqual(store.getSnapshot().terminalIdsBySession.get(sessionId), [terminalId])
  })

  it("does not let stale rollback resurrect an authoritatively archived terminal", () => {
    const store = new MuxSessionStore()
    store.replace([session()], [makeTerminal()])
    const pending = store.stageTerminalClose(terminalId)
    assert.ok(pending)
    store.apply({
      _tag: "MuxTerminalArchived",
      eventId: "authoritative-close",
      muxTerminalId: terminalId,
      revision: 2,
      occurredAt: "2026-01-02",
    })
    pending.rollback()
    assert.deepEqual(store.getSnapshot().terminalIdsBySession.get(sessionId), [])
    assert.equal(store.getSnapshot().terminalsById.get(terminalId)?.archivedAt, "2026-01-02")
  })

  it("reports revision gaps without replacing the newer snapshot", () => {
    const store = new MuxSessionStore()
    store.replace([session()], [makeTerminal()])
    const gaps: number[] = []
    store.setRevisionGapHandler(gap => gaps.push(gap.actualRevision))
    store.apply({
      _tag: "MuxTerminalUpdated", eventId: "event-4", muxTerminalId: terminalId,
      muxTerminal: { ...makeTerminal(), title: "Future", revision: 4, updatedAt: "2026-01-04" }, revision: 4, occurredAt: "2026-01-04",
    })
    assert.deepEqual(gaps, [4])
    assert.equal(store.getSnapshot().terminalsById.get(terminalId)?.title, "Future")
  })
})
