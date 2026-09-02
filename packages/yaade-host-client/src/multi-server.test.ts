import assert from "node:assert/strict"
import {
  AppSession,
  TerminalOutput,
  SessionId,
  SessionTab,
  SessionTabId,
  MuxTerminal,
  MuxTerminalId,
} from "@yaade/rpc"
import { Schema } from "effect"
import { test } from "vite-plus/test"
import type { MuxSessionSnapshot } from "@yaade/workspace"
import {
  createMultiServerHostClient,
  decodeStoredServerDefinitions,
  normalizeServerDefinition,
} from "./multi-server.js"

test("normalizes and de-duplicates saved server definitions", () => {
  const servers = decodeStoredServerDefinitions([
    { id: "srv-one", name: "One", url: "https://one.example/" },
    { id: "srv-two", name: "Two", url: "https://one.example" },
    { id: "srv-one", name: "Duplicate", url: "https://two.example" },
    { id: "bad id", name: "Invalid", url: "https://invalid.example" },
    { id: "srv-three", name: "Three", url: "ftp://three.example" },
  ])

  assert.deepEqual(servers, [
    { id: "srv-one", name: "One", url: "https://one.example" },
  ])
})

test("requires a stable id and rejects embedded credentials", () => {
  assert.equal(normalizeServerDefinition({ name: "One", url: "https://one.example" }), null)
  assert.equal(
    normalizeServerDefinition({
      id: "srv-one",
      name: "One",
      url: "https://user:pass@one.example",
    }),
    null,
  )
  assert.deepEqual(
    normalizeServerDefinition({
      id: "srv-one",
      name: "One",
      url: "https://one.example/",
      token: " secret ",
    }),
    {
      id: "srv-one",
      name: "One",
      url: "https://one.example",
      token: "secret",
    },
  )
})

test("keeps scoped terminal ownership pointed at the PTY id", async () => {
  const sessionId = Schema.decodeUnknownSync(SessionId)("ses-test")
  const tabId = Schema.decodeUnknownSync(SessionTabId)("tab-test")
  const terminalId = Schema.decodeUnknownSync(MuxTerminalId)("term-test")
  const session = AppSession.make({
    id: sessionId,
    title: "Session",
    position: 0,
    activeTabId: tabId,
    activeMuxTerminalId: terminalId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })
  const tab = SessionTab.make({
    id: tabId,
    sessionId: session.id,
    title: "Window",
    position: 0,
    activeMuxTerminalId: terminalId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  })
  const terminal = Schema.decodeUnknownSync(MuxTerminal)({
    id: terminalId,
    sessionId: session.id,
    tabId: tab.id,
    kind: "terminal",
    title: "Terminal",
    position: 0,
    status: "running",
    input: { _tag: "TerminalInput", kind: "terminal" },
    inputRevision: 1,
    output: TerminalOutput.make({
      kind: "process",
      terminalInstanceId: "instance-test",
      ptyId: "term-test",
      generation: 1,
      processState: "running",
      activityState: "idle",
      replayAvailable: true,
      truncated: false,
    }),
    revision: 1,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  })
  const snapshot: MuxSessionSnapshot = {
    session,
    tabs: [tab],
    muxTerminals: [terminal],
  }
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const previousFetch = globalThis.fetch
  const previousWebSocket = globalThis.WebSocket
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: undefined })
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      channel?: string
      args?: unknown[]
    }
    const channel = body.channel ?? ""
    const args = body.args ?? []
    calls.push({ channel, args })
    const value = channel === "mux:listSessions"
      ? [snapshot]
      : channel === "terminal:attach"
        ? {
            id: "term-test",
            title: "Terminal",
            outputChunks: [],
            output: "",
            replayTruncated: false,
            replayNeedsQueryResponses: false,
            lastSequence: 0,
            status: "running",
            exitCode: null,
            signal: null,
          }
        : []
    return new Response(JSON.stringify({ value }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  try {
    const client = createMultiServerHostClient({
      currentServer: {
        id: "current-host",
        name: "Current",
        url: "http://yaade.test",
      },
    })
    const snapshots = await client.mux.listSessions(false)
    const output = snapshots[0]?.muxTerminals[0]?.output
    assert.equal(output?.kind, "process")
    if (output?.kind !== "process" || !output.ptyId) throw new Error("missing scoped PTY")
    await client.ports.terminal.attach(output.ptyId)
    assert.deepEqual(
      calls.find(call => call.channel === "terminal:attach")?.args,
      ["term-test", 0, "raw"],
    )
  } finally {
    globalThis.fetch = previousFetch
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: previousWebSocket,
    })
  }
})
