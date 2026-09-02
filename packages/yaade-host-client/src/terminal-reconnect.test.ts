import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import type { YaadeHostTransport } from "./transport.js"
import { createYaadeApi } from "./create-yaade-api.js"

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
const decode = (value: Uint8Array): string => new TextDecoder().decode(value)

type AttachResult = {
  id: string
  checkpoint?: {
    checkpointVersion: 1
    terminalEpoch: string
    sequence: number
    cols: number
    rows: number
    createdAt: string
    syntheticBytes: Uint8Array
  }
  outputChunks: Uint8Array[]
  output: Uint8Array
  lastSequence: number
  replayNeedsQueryResponses?: boolean
  replayTruncated?: boolean
  archiveAvailable?: boolean
  status: "running"
}

class FakeTransport implements YaadeHostTransport {
  readonly calls: Array<{ channel: string; args: unknown[]; via: "http" | "realtime" }> = []
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private readonly attachResults: AttachResult[] = []
  private readonly replayPages: Array<{
    chunks: Uint8Array[]
    firstSequence: number
    lastSequence: number
    nextSequence: number
    complete: boolean
  }> = []

  queueAttach(result: AttachResult): void {
    this.attachResults.push(result)
  }

  queueReplayPage(page: {
    chunks: Uint8Array[]
    firstSequence: number
    lastSequence: number
    nextSequence: number
    complete: boolean
  }): void {
    this.replayPages.push(page)
  }

  emit(channel: string, ...args: unknown[]): void {
    this.listeners.get(channel)?.forEach(listener => listener(...args))
  }

  private shiftAttach<T>(): T {
    const result = this.attachResults.shift()
    if (!result) throw new Error("missing attach result")
    return result as T
  }

  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    this.calls.push({ channel, args, via: "http" })
    if (channel === "terminal:readReplayPage") {
      const page = this.replayPages.shift()
      if (!page) throw new Error("missing replay page")
      return page as T
    }
    if (channel !== "terminal:attach") throw new Error(`unexpected ${channel}`)
    return this.shiftAttach()
  }

  invokeRealtime<T>(channel: string, ...args: unknown[]): Promise<T> | null {
    this.calls.push({ channel, args, via: "realtime" })
    if (channel === "terminal:detach") return Promise.resolve(null as T)
    if (channel !== "terminal:attach") throw new Error(`unexpected ${channel}`)
    return Promise.resolve(this.shiftAttach())
  }

  on(channel: string, listener: (...args: unknown[]) => void): () => void {
    const listeners = this.listeners.get(channel) ?? new Set()
    listeners.add(listener)
    this.listeners.set(channel, listeners)
    return () => listeners.delete(listener)
  }
}

test("reconnect delta-replays mounted terminals before buffered live data", async () => {
  const transport = new FakeTransport()
  transport.queueAttach({
    id: "pty-1",
    outputChunks: [encode("initial")],
    output: new Uint8Array(),
    lastSequence: 2,
    status: "running",
  })
  const api = createYaadeApi(transport)
  const terminal = api.terminal
  assert.ok(terminal)
  transport.emit("connection:status", "connected")
  await terminal.attach("pty-1")

  const output: string[] = []
  const replayFlags: boolean[] = []
  const replayQueryFlags: boolean[] = []
  const replayTruncatedFlags: boolean[] = []
  terminal.onData(
    "pty-1",
    (data, replay, replayNeedsQueryResponses, replayTruncated) => {
      output.push(decode(data))
      replayFlags.push(replay === true)
      replayQueryFlags.push(replayNeedsQueryResponses === true)
      replayTruncatedFlags.push(replayTruncated === true)
    },
  )
  transport.emit("terminal:data", "pty-1", encode("live-3"), 3)
  transport.emit("connection:status", "disconnected")

  transport.queueAttach({
    id: "pty-1",
    outputChunks: [encode("replay-4")],
    output: new Uint8Array(),
    lastSequence: 4,
    replayNeedsQueryResponses: true,
    replayTruncated: true,
    status: "running",
  })
  transport.emit("connection:status", "connected")
  transport.emit("terminal:data", "pty-1", encode("live-5"), 5)
  await new Promise<void>(resolve => setImmediate(resolve))

  assert.deepEqual(output, ["live-3", "replay-4", "live-5"])
  assert.deepEqual(replayFlags, [false, true, false])
  assert.deepEqual(replayQueryFlags, [false, true, false])
  assert.deepEqual(replayTruncatedFlags, [false, true, false])
  assert.deepEqual(transport.calls.at(-1), {
    channel: "terminal:attach",
    args: ["pty-1", 3, "raw"],
    via: "realtime",
  })
})

test("a new renderer receives full paged replay before buffered live output", async () => {
  const transport = new FakeTransport()
  transport.queueAttach({
    id: "pty-remount",
    outputChunks: [encode("old-tail")],
    output: new Uint8Array(),
    lastSequence: 2,
    archiveAvailable: true,
    status: "running",
  })
  const terminal = createYaadeApi(transport).terminal
  transport.emit("connection:status", "connected")
  await terminal.attach("pty-remount")

  transport.queueAttach({
    id: "pty-remount",
    outputChunks: [encode("bounded-tail")],
    output: new Uint8Array(),
    lastSequence: 4,
    archiveAvailable: true,
    status: "running",
  })
  transport.queueReplayPage({
    chunks: [encode("history-1"), encode("history-2"), encode("history-3"), encode("history-4"), encode("history-5")],
    firstSequence: 1,
    lastSequence: 5,
    nextSequence: 5,
    complete: true,
  })

  const preview: string[] = []
  const replay: string[] = []
  const attached = await terminal.attach("pty-remount", {
    replay: "full",
    onReplayPreview: chunk => {
      preview.push(decode(chunk.data))
    },
    onReplay: chunk => {
      replay.push(decode(chunk.data))
      transport.emit("terminal:data", "pty-remount", encode("duplicate-live-5"), 5)
      transport.emit("terminal:data", "pty-remount", encode("live-6"), 6)
    },
  })
  const live: string[] = []
  terminal.onData("pty-remount", data => live.push(decode(data)))

  assert.deepEqual(preview, ["bounded-tail"])
  assert.deepEqual(replay, [
    "history-1history-2history-3history-4history-5",
  ])
  assert.deepEqual(live, ["live-6"])
  assert.deepEqual(attached?.outputChunks, [])
  assert.equal(attached?.output.byteLength, 0)
  assert.deepEqual(
    transport.calls.filter(call => call.channel === "terminal:attach").at(-1),
    {
      channel: "terminal:attach",
      args: ["pty-remount", 0, "raw"],
      via: "realtime",
    },
  )
})

test("a cold archive fetches its newest page before ordered history replay", async () => {
  const transport = new FakeTransport()
  transport.queueAttach({
    id: "pty-cold-preview",
    outputChunks: [],
    output: new Uint8Array(),
    lastSequence: 4,
    archiveAvailable: true,
    status: "running",
  })
  transport.queueReplayPage({
    chunks: [encode("history-3"), encode("history-4")],
    firstSequence: 3,
    lastSequence: 4,
    nextSequence: 3,
    complete: false,
  })
  transport.queueReplayPage({
    chunks: [encode("history-1"), encode("history-2"), encode("history-3"), encode("history-4")],
    firstSequence: 1,
    lastSequence: 4,
    nextSequence: 4,
    complete: true,
  })

  const delivery: string[] = []
  await createYaadeApi(transport).terminal.attach("pty-cold-preview", {
    replay: "full",
    onReplayPreview: chunk => {
      delivery.push(`preview:${decode(chunk.data)}`)
    },
    onReplay: chunk => {
      delivery.push(`replay:${decode(chunk.data)}`)
    },
  })

  assert.deepEqual(delivery, [
    "preview:history-3history-4",
    "replay:history-1history-2history-3history-4",
  ])
  assert.deepEqual(
    transport.calls.filter(call => call.channel === "terminal:readReplayPage"),
    [
      {
        channel: "terminal:readReplayPage",
        args: ["pty-cold-preview", 0, 256 * 1024, "backward"],
        via: "http",
      },
      {
        channel: "terminal:readReplayPage",
        args: ["pty-cold-preview", 0, 256 * 1024],
        via: "http",
      },
    ],
  )
})

test("a newest-screen checkpoint previews without skipping older scrollback", async () => {
  const transport = new FakeTransport()
  transport.queueAttach({
    id: "pty-checkpoint-preview",
    checkpoint: {
      checkpointVersion: 1,
      terminalEpoch: "epoch-1",
      sequence: 3,
      cols: 80,
      rows: 24,
      createdAt: "2026-01-01T00:00:00.000Z",
      syntheticBytes: encode("current-screen"),
    },
    outputChunks: [encode("current-delta")],
    output: new Uint8Array(),
    lastSequence: 4,
    archiveAvailable: true,
    status: "running",
  })
  transport.queueReplayPage({
    chunks: [encode("history-1"), encode("history-2"), encode("history-3"), encode("history-4")],
    firstSequence: 1,
    lastSequence: 4,
    nextSequence: 4,
    complete: true,
  })

  const delivery: string[] = []
  await createYaadeApi(transport).terminal.attach("pty-checkpoint-preview", {
    replay: "full",
    onReplayPreview: chunk => {
      delivery.push(`preview:${decode(chunk.data)}`)
    },
    onReplay: chunk => {
      delivery.push(`replay:${decode(chunk.data)}`)
    },
  })

  assert.deepEqual(delivery, [
    "preview:current-screencurrent-delta",
    "replay:history-1history-2history-3history-4",
  ])
  assert.deepEqual(
    transport.calls.filter(call => call.channel === "terminal:readReplayPage").at(-1),
    {
      channel: "terminal:readReplayPage",
      args: ["pty-checkpoint-preview", 0, 256 * 1024],
      via: "http",
    },
  )
})

test("flow credit is acknowledged only after a consuming renderer parses data", () => {
  const transport = new FakeTransport()
  const terminal = createYaadeApi(transport).terminal
  transport.emit("connection:status", "connected")
  let acknowledgeConsumed: (() => void) | undefined
  let transportAcknowledgements = 0
  terminal.onData(
    "pty-consumed",
    (_data, _replay, _queries, _truncated, acknowledge) => {
      acknowledgeConsumed = acknowledge
    },
    { acknowledgement: "consumption" },
  )
  transport.emit(
    "terminal:data",
    "pty-consumed",
    encode("payload"),
    1,
    () => {
      transportAcknowledgements += 1
    },
  )
  assert.equal(transportAcknowledgements, 0)
  acknowledgeConsumed?.()
  assert.equal(transportAcknowledgements, 1)
  acknowledgeConsumed?.()
  assert.equal(transportAcknowledgements, 1)
})

test("an incomplete archive resets to the bounded tail instead of exposing a gap", async () => {
  const transport = new FakeTransport()
  transport.queueAttach({
    id: "pty-gap",
    outputChunks: [encode("bounded-tail")],
    output: new Uint8Array(),
    lastSequence: 4,
    archiveAvailable: true,
    status: "running",
  })
  transport.queueReplayPage({
    chunks: [encode("archive-prefix")],
    firstSequence: 1,
    lastSequence: 2,
    nextSequence: 2,
    complete: false,
  })
  transport.queueReplayPage({
    chunks: [],
    firstSequence: 0,
    lastSequence: 2,
    nextSequence: 2,
    complete: false,
  })
  const replay: Array<{ data: string; truncated: boolean }> = []
  await createYaadeApi(transport).terminal.attach("pty-gap", {
    replay: "full",
    onReplay: chunk => {
      replay.push({
        data: decode(chunk.data),
        truncated: chunk.replayTruncated,
      })
    },
  })
  assert.deepEqual(replay, [
    { data: "archive-prefix", truncated: false },
    { data: "bounded-tail", truncated: true },
  ])
})

test("removing the last renderer detaches its server stream", async () => {
  const transport = new FakeTransport()
  const terminal = createYaadeApi(transport).terminal
  const unsubscribe = terminal.onData("pty-hidden", () => undefined)
  unsubscribe()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(transport.calls.at(-1), {
    channel: "terminal:detach",
    args: ["pty-hidden"],
    via: "realtime",
  })
})

test("archived reconnect history is delivered page by page", async () => {
  const transport = new FakeTransport()
  transport.queueAttach({
    id: "pty-archive",
    outputChunks: [],
    output: new Uint8Array(),
    lastSequence: 1,
    status: "running",
  })
  const terminal = createYaadeApi(transport).terminal
  transport.emit("connection:status", "connected")
  await terminal.attach("pty-archive")
  const output: string[] = []
  terminal.onData("pty-archive", data => output.push(decode(data)))
  transport.emit("connection:status", "disconnected")
  transport.queueAttach({
    id: "pty-archive",
    outputChunks: [encode("bounded-ring-copy")],
    output: new Uint8Array(),
    lastSequence: 4,
    replayTruncated: true,
    archiveAvailable: true,
    status: "running",
  })
  transport.queueReplayPage({
    chunks: [encode("archive-2")],
    firstSequence: 2,
    lastSequence: 2,
    nextSequence: 2,
    complete: false,
  })
  transport.queueReplayPage({
    chunks: [encode("archive-3"), encode("archive-4")],
    firstSequence: 3,
    lastSequence: 4,
    nextSequence: 4,
    complete: true,
  })
  transport.emit("connection:status", "connected")
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(output, ["archive-2", "archive-3archive-4"])
  assert.equal(
    transport.calls.filter(call => call.channel === "terminal:readReplayPage").length,
    2,
  )
})
