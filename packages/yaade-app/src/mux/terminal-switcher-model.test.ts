import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import {
  AppSession,
  MuxTerminal,
  SessionTab,
  TerminalOutput,
  type MuxTerminal as MuxTerminalValue,
} from "@yaade/rpc"
import { Schema } from "effect"
import { TerminalFocusHistory, type TerminalFocusIdentity } from "./terminal-focus-history.js"
import {
  rankTerminalSwitcherEntries,
  terminalStatusPreview,
  type TerminalSwitcherSourceEntry,
} from "./terminal-switcher-model.js"

function makeEntry(
  terminalName: string,
  options: {
    readonly serverId?: string
    readonly serverPosition?: number
    readonly session?: string
    readonly sessionPosition?: number
    readonly tab?: string
    readonly tabPosition?: number
    readonly terminalPosition?: number
    readonly title?: string
    readonly processState?: "starting" | "running" | "exited" | "failed" | "disconnected" | "interrupted" | "restoring" | "orphaned"
    readonly activityState?: "starting" | "working" | "running_command" | "waiting_for_input" | "idle" | "failed"
    readonly status?: "created" | "starting" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "disconnected"
    readonly exitCode?: number
  } = {},
): TerminalSwitcherSourceEntry {
  const serverId = options.serverId ?? "current-host"
  const sessionName = options.session ?? "one"
  const tabName = options.tab ?? "one"
  const session = Schema.decodeUnknownSync(AppSession)({
    id: `ses-${sessionName}`,
    title: `Session ${sessionName}`,
    position: options.sessionPosition ?? 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })
  const tab = Schema.decodeUnknownSync(SessionTab)({
    id: `tab-${tabName}`,
    sessionId: session.id,
    title: `Window ${tabName}`,
    position: options.tabPosition ?? 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })
  const terminal = Schema.decodeUnknownSync(MuxTerminal)({
    id: `term-${terminalName}`,
    sessionId: session.id,
    tabId: tab.id,
    kind: "terminal",
    title: options.title ?? terminalName,
    position: options.terminalPosition ?? 0,
    status: options.status ?? "running",
    input: { _tag: "TerminalInput", kind: "terminal" },
    inputRevision: 1,
    output: TerminalOutput.make({
      kind: "process",
      terminalInstanceId: `instance-${terminalName}`,
      generation: 1,
      processState: options.processState ?? "running",
      activityState: options.activityState ?? "idle",
      replayAvailable: true,
      exitCode: options.exitCode,
      truncated: false,
    }),
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })
  const identity: TerminalFocusIdentity = {
    serverId,
    sessionId: session.id,
    tabId: tab.id,
    terminalId: terminal.id,
    generation: terminal.output.generation,
  }
  return {
    identity,
    terminal,
    session,
    tab,
    serverName: serverId === "current-host" ? "This device" : serverId,
    serverPosition: options.serverPosition ?? 0,
    title: options.title ?? terminalName,
  }
}

function withStatus(
  terminal: MuxTerminalValue,
  processState: MuxTerminalValue["output"]["processState"],
  activityState: MuxTerminalValue["output"]["activityState"],
  exitCode?: number,
): MuxTerminalValue {
  const previous = terminal.output
  return {
    ...terminal,
    output: TerminalOutput.make({
      kind: previous.kind,
      terminalInstanceId: previous.terminalInstanceId,
      ptyId: previous.ptyId,
      historyId: previous.historyId,
      processIdentity: previous.processIdentity,
      generation: previous.generation,
      processState,
      activityState,
      replayAvailable: previous.replayAvailable,
      exitCode,
      truncated: previous.truncated,
    }),
  }
}

describe("terminal switcher ranking", () => {
  it("uses MRU first, then stable current-context/server/session/Window/position order", () => {
    const current = makeEntry("current", { session: "active", tab: "active", terminalPosition: 1 })
    const sibling = makeEntry("sibling", { session: "active", tab: "active", terminalPosition: 0 })
    const otherWindow = makeEntry("window", { session: "active", tab: "other", tabPosition: 1 })
    const remote = makeEntry("remote", { serverId: "remote", serverPosition: 1 })
    const history = new TerminalFocusHistory([remote.identity, current.identity])
    const ranked = rankTerminalSwitcherEntries(
      [remote, otherWindow, current, sibling],
      history,
      { activeSessionId: current.session.id, activeTabId: current.tab.id },
    )
    assert.deepEqual(ranked.map(entry => entry.terminal.id), [remote.terminal.id, current.terminal.id, sibling.terminal.id, otherWindow.terminal.id])
    assert.equal(ranked[0]?.section, "Recent")
    assert.equal(ranked[2]?.section, "Other terminals")
  })

  it("uses fuzzy relevance before MRU and MRU only as a tie-breaker", () => {
    const exact = makeEntry("exact", { title: "build" })
    const fuzzy = makeEntry("fuzzy", { title: "background build worker" })
    const tieA = makeEntry("tie-a", { title: "logs" })
    const tieB = makeEntry("tie-b", { title: "logs" })
    const history = new TerminalFocusHistory([fuzzy.identity, tieB.identity, tieA.identity])
    const relevant = rankTerminalSwitcherEntries([fuzzy, exact], history, {}, "build")
    assert.equal(relevant[0]?.terminal.id, exact.terminal.id)
    const tied = rankTerminalSwitcherEntries([tieA, tieB], history, {}, "logs")
    assert.deepEqual(tied.map(entry => entry.terminal.id), [tieB.terminal.id, tieA.terminal.id])
    assert.equal(tied.some(entry => entry.section !== undefined), false)
  })

  it("keeps ranking deterministic for 1, 100, and 5,000 terminals", () => {
    for (const count of [1, 100, 5_000]) {
      const entries = Array.from({ length: count }, (_, index) =>
        makeEntry(`perf-${index}`, {
          session: `perf-${Math.floor(index / 10)}`,
          sessionPosition: Math.floor(index / 10),
          tab: `perf-${Math.floor(index / 5)}`,
          tabPosition: Math.floor(index / 5),
          terminalPosition: index % 5,
          title: `worker ${index}`,
        }),
      )
      const history = new TerminalFocusHistory()
      const ranked = rankTerminalSwitcherEntries(entries, history, {})
      assert.equal(ranked.length, count)
      assert.equal(new Set(ranked.map(entry => entry.terminal.id)).size, ranked.length)
      const queried = rankTerminalSwitcherEntries(entries, history, {}, "worker 49")
      assert.equal(count < 100 ? queried.length === 0 : queried.length > 0, true)
    }
  })
})

describe("typed terminal status previews", () => {
  const base = makeEntry("status").terminal

  it("labels running and waiting terminals", () => {
    assert.deepEqual(terminalStatusPreview(base), { label: "Running", tone: "running" })
    assert.deepEqual(
      terminalStatusPreview(withStatus(base, "running", "waiting_for_input")),
      { label: "Waiting", tone: "waiting" },
    )
  })

  it("labels failed, interrupted, and exited terminals from metadata", () => {
    assert.deepEqual(
      terminalStatusPreview(withStatus(base, "failed", "failed", 2)),
      { label: "Failed (2)", tone: "failed" },
    )
    assert.deepEqual(
      terminalStatusPreview(withStatus(base, "interrupted", "idle")),
      { label: "Interrupted", tone: "interrupted" },
    )
    assert.deepEqual(
      terminalStatusPreview(withStatus(base, "exited", "idle", 0)),
      { label: "Exited (0)", tone: "exited" },
    )
  })
})
