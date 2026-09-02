import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { AppSession, TerminalOutput, MuxEvent, MuxTerminal, MuxTerminalUpdated } from "@yaade/rpc"
import type { HostMux, MuxSessionSnapshot } from "@yaade/workspace"
import { Schema } from "effect"
import { MuxClient } from "./mux-client.js"
import { MuxSessionStore } from "./mux-store.js"

class FakeWindow {
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type))
  }
}

function makeTerminal(revision: number): MuxTerminal {
  return Schema.decodeUnknownSync(MuxTerminal)({
    id: "term-client-test",
    sessionId: "ses-client-test",
    kind: "terminal",
    title: "Shell",
    position: 0,
    status: "running",
    input: { _tag: "TerminalInput", kind: "terminal" },
    inputRevision: 1,
    output: TerminalOutput.make({
      kind: "process",
      terminalInstanceId: "terminal",
      generation: 1,
      processState: "running",
      activityState: "idle",
      replayAvailable: true,
      truncated: false,
    }),
    revision,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: `2026-08-12T00:00:0${revision}.000Z`,
  })
}

function makeApi(initial: MuxSessionSnapshot, latest: () => MuxTerminal): HostMux {
  let eventListener: ((event: MuxEvent) => void) | undefined
  return {
    listSessions: async () => [initial],
    reorderSessions: async () => [initial.session],
    archiveSession: async () => initial.session,
    restoreSession: async () => initial.session,
    createSession: async () => initial.session,
    renameSession: async () => initial.session,
    getSession: async () => ({ session: initial.session, muxTerminals: [latest()] }),
    createTerminal: async () => latest(),
    getTerminal: async () => latest(),
    reorderTerminals: async () => [latest()],
    moveTerminal: async () => latest(),
    selectTerminal: async () => initial.session,
    stopTerminal: async () => latest(),
    restartTerminal: async () => latest(),
    closeTerminal: async () => latest(),
    renameTerminal: async () => latest(),
    onEvent: callback => {
      eventListener = callback
      return () => { eventListener = undefined }
    },
    // Test-only access to the transport callback.
    emit(event: MuxEvent): void {
      eventListener?.(event)
    },
  } as HostMux & { emit(event: MuxEvent): void }
}

describe("MuxClient", () => {
  it("refetches a MuxTerminal when an event revision jumps", async () => {
    const terminal = makeTerminal(1)
    const recovered = makeTerminal(3)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeMuxTerminalId: terminal.id,
      createdAt: terminal.createdAt,
      updatedAt: terminal.createdAt,
    })
    const api = makeApi({ session, muxTerminals: [terminal] }, () => recovered)
    const window = new FakeWindow()
    const client = new MuxClient({ api, window })
    client.start()
    await client.hydrate()

    const event = MuxTerminalUpdated.make({
      eventId: "terminal-gap",
      muxTerminalId: recovered.id,
      revision: recovered.revision,
      occurredAt: recovered.updatedAt,
      muxTerminal: recovered,
    })
    ;(api as HostMux & { emit(event: MuxEvent): void }).emit(event)
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.equal(client.store.getSnapshot().terminalsById.get(terminal.id)?.revision, 3)
    client.dispose()
  })

  it("keeps realtime revisions when a stale snapshot resolves later", async () => {
    const terminal = makeTerminal(1)
    const newer = makeTerminal(2)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeMuxTerminalId: terminal.id,
      createdAt: terminal.createdAt,
      updatedAt: terminal.createdAt,
    })
    let resolveList: ((value: MuxSessionSnapshot[]) => void) | undefined
    const api = makeApi({ session, muxTerminals: [terminal] }, () => terminal)
    api.listSessions = async () => new Promise(resolve => { resolveList = resolve })
    const window = new FakeWindow()
    const client = new MuxClient({ api, window })
    client.start()
    const hydration = client.hydrate()
    ;(api as HostMux & { emit(event: MuxEvent): void }).emit(
      MuxTerminalUpdated.make({
        eventId: "newer-event",
        muxTerminalId: newer.id,
        revision: newer.revision,
        occurredAt: newer.updatedAt,
        muxTerminal: newer,
      }),
    )
    resolveList?.([{ session, muxTerminals: [terminal] }])
    await hydration
    assert.equal(client.store.getSnapshot().terminalsById.get(terminal.id)?.revision, 2)
    client.dispose()
  })

  it("can be started again after disposal", async () => {
    const terminal = makeTerminal(1)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeMuxTerminalId: terminal.id,
      createdAt: terminal.createdAt,
      updatedAt: terminal.createdAt,
    })
    const recovered = makeTerminal(3)
    const api = makeApi({ session, muxTerminals: [terminal] }, () => recovered)
    const window = new FakeWindow()
    const client = new MuxClient({ api, window })
    client.start()
    await client.hydrate()
    client.dispose()
    client.start()
    ;(api as HostMux & { emit(event: MuxEvent): void }).emit(
      MuxTerminalUpdated.make({
        eventId: "after-restart",
        muxTerminalId: recovered.id,
        revision: recovered.revision,
        occurredAt: recovered.updatedAt,
        muxTerminal: recovered,
      }),
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(client.store.getSnapshot().terminalsById.get(terminal.id)?.revision, 3)
    client.dispose()
  })

  it("re-fetches through the API for runtime snapshots", async () => {
    const terminal = makeTerminal(1)
    const recovered = makeTerminal(4)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeMuxTerminalId: terminal.id,
      createdAt: terminal.createdAt,
      updatedAt: terminal.createdAt,
    })
    const api = makeApi({ session, muxTerminals: [terminal] }, () => recovered)
    let listCalls = 0
    api.listSessions = async () => {
      listCalls += 1
      return [{ session, muxTerminals: [listCalls === 1 ? terminal : recovered] }]
    }
    const window = new FakeWindow()
    const client = new MuxClient({ api, window })
    client.start()
    await client.hydrate()
    window.dispatch("yaade:runtime-snapshot")
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(listCalls, 2)
    assert.equal(client.store.getSnapshot().terminalsById.get(terminal.id)?.revision, 4)
    client.dispose()
  })

  it("reconciles all snapshots after a host reconnect", async () => {
    const terminal = makeTerminal(1)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeMuxTerminalId: terminal.id,
      createdAt: terminal.createdAt,
      updatedAt: terminal.createdAt,
    })
    const api = makeApi({ session, muxTerminals: [terminal] }, () => terminal)
    const window = new FakeWindow()
    const client = new MuxClient({ api, window, store: new MuxSessionStore() })
    client.start()
    await client.hydrate()
    window.dispatch("yaade:host-reconnected")
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(client.store.getSnapshot().connection, "connected")
    client.dispose()
  })

  it("does not flash reconciling over a known offline connection", async () => {
    const terminal = makeTerminal(1)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeMuxTerminalId: terminal.id,
      createdAt: terminal.createdAt,
      updatedAt: terminal.createdAt,
    })
    const api = makeApi({ session, muxTerminals: [terminal] }, () => terminal)
    let resolveList: ((value: MuxSessionSnapshot[]) => void) | undefined
    api.listSessions = async () => new Promise(resolve => { resolveList = resolve })
    const store = new MuxSessionStore()
    store.setConnection("offline")
    const client = new MuxClient({ api, window: new FakeWindow(), store })
    const hydration = client.hydrate()
    assert.equal(client.store.getSnapshot().connection, "offline")
    resolveList?.([{ session, muxTerminals: [terminal] }])
    await hydration
    assert.equal(client.store.getSnapshot().connection, "connected")
    client.dispose()
  })

  it("publishes terminal close before the host request resolves", async () => {
    const terminal = makeTerminal(1)
    const archived = Schema.decodeUnknownSync(MuxTerminal)({
      ...terminal,
      status: "cancelled",
      revision: 2,
      updatedAt: "2026-08-12T00:00:02.000Z",
      archivedAt: "2026-08-12T00:00:02.000Z",
    })
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeMuxTerminalId: terminal.id,
      createdAt: terminal.createdAt,
      updatedAt: terminal.createdAt,
    })
    const api = makeApi({ session, muxTerminals: [terminal] }, () => terminal)
    let resolveClose: ((value: MuxTerminal) => void) | undefined
    api.closeTerminal = async () => new Promise(resolve => { resolveClose = resolve })
    const client = new MuxClient({ api, window: new FakeWindow() })
    await client.hydrate()

    const closing = client.closeTerminal({ _tag: "CloseTerminal", muxTerminalId: terminal.id })
    assert.deepEqual(client.store.getSnapshot().terminalIdsBySession.get(session.id), [])
    assert.equal(client.store.getSnapshot().terminalsById.get(terminal.id)?.revision, 1)
    resolveClose?.(archived)
    await closing
    assert.equal(client.store.getSnapshot().terminalsById.get(terminal.id)?.archivedAt, archived.archivedAt)
    client.dispose()
  })

  it("restores authoritative terminal state after a rejected close", async () => {
    const terminal = makeTerminal(1)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeMuxTerminalId: terminal.id,
      createdAt: terminal.createdAt,
      updatedAt: terminal.createdAt,
    })
    const api = makeApi({ session, muxTerminals: [terminal] }, () => terminal)
    api.closeTerminal = async () => Promise.reject(new Error("close failed"))
    const client = new MuxClient({ api, window: new FakeWindow() })
    await client.hydrate()

    await assert.rejects(
      client.closeTerminal({ _tag: "CloseTerminal", muxTerminalId: terminal.id }),
      /close failed/,
    )
    assert.deepEqual(client.store.getSnapshot().terminalIdsBySession.get(session.id), [terminal.id])
    assert.equal(client.store.getSnapshot().terminalsById.get(terminal.id)?.title, "Shell")
    client.dispose()
  })

  it("reconciles after a protocol replay gap", async () => {
    let listCalls = 0
    const terminal = makeTerminal(1)
    const recovered = makeTerminal(4)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeMuxTerminalId: terminal.id,
      createdAt: terminal.createdAt,
      updatedAt: terminal.createdAt,
    })
    const api = makeApi({ session, muxTerminals: [terminal] }, () => recovered)
    const originalList = api.listSessions
    api.listSessions = async includeArchived => {
      listCalls += 1
      if (listCalls === 1) return originalList(includeArchived)
      return [{ session, muxTerminals: [recovered] }]
    }
    const window = new FakeWindow()
    const client = new MuxClient({ api, window })
    client.start()
    await client.hydrate()
    window.dispatch("yaade:host-replay-gap")
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(listCalls >= 2)
    assert.equal(client.store.getSnapshot().terminalsById.get(terminal.id)?.revision, 4)
    client.dispose()
  })
})
