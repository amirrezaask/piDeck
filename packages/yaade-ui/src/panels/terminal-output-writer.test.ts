import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  createTerminalOutputWriter,
  GHOSTTY_OUTPUT_MAX_BYTES_PER_FLUSH,
} from "./terminal-output-writer.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const bytes = (value: string): Uint8Array => encoder.encode(value)
const text = (value: Uint8Array): string => decoder.decode(value)

test("coalesces multiple byte parts into one write", () => {
  const writes: Uint8Array[] = []
  const scheduled: Array<() => void> = []
  const writer = createTerminalOutputWriter({
    write: (data, done) => { writes.push(data); done?.() },
    schedule: callback => { scheduled.push(callback); return scheduled.length },
    cancel: () => {},
    interactiveMaxBytes: 0,
  })
  writer.enqueue(bytes("a"))
  writer.enqueue(bytes("b"))
  writer.enqueue(bytes("c"))
  scheduled[0]!()
  assert.deepEqual(writes.map(text), ["abc"])
})

test("marks byte cursor visibility sequences for one refresh", () => {
  let refreshes = 0
  const scheduled: Array<() => void> = []
  const writer = createTerminalOutputWriter({
    write: (_data, done) => done?.(),
    refreshAfterPaint: () => { refreshes += 1 },
    schedule: callback => { scheduled.push(callback); return scheduled.length },
    cancel: () => {},
    interactiveMaxBytes: 0,
  })
  writer.enqueue(bytes("hello"))
  writer.enqueue(bytes("\x1b[?25l"))
  writer.enqueue(bytes("\x1b[?25h"))
  scheduled[0]!()
  assert.equal(refreshes, 1)
})

test("slices bytes and acknowledges only the final parser slice", () => {
  const writes: Uint8Array[] = []
  const scheduled: Array<() => void> = []
  let acknowledgements = 0
  const writer = createTerminalOutputWriter({
    write: (data, done) => { writes.push(data); done?.() },
    schedule: callback => { scheduled.push(callback); return scheduled.length },
    cancel: () => {},
    maxBytesPerFlush: 4,
    interactiveMaxBytes: 0,
  })
  writer.enqueue(bytes("abcdefgh"), () => { acknowledgements += 1 })
  scheduled[0]!()
  assert.deepEqual(writes.map(text), ["abcd"])
  assert.equal(acknowledgements, 0)
  scheduled[1]!()
  assert.deepEqual(writes.map(text), ["abcd", "efgh"])
  assert.equal(acknowledgements, 1)
})

test("a maximum host frame parses in one visual frame", () => {
  const writes: Uint8Array[] = []
  const scheduled: Array<() => void> = []
  const writer = createTerminalOutputWriter({
    write: (data, done) => { writes.push(data); done?.() },
    schedule: callback => { scheduled.push(callback); return scheduled.length },
    cancel: () => {},
    maxBytesPerFlush: GHOSTTY_OUTPUT_MAX_BYTES_PER_FLUSH,
    interactiveMaxBytes: 0,
  })
  writer.enqueue(bytes("x".repeat(64 * 1024)))
  scheduled[0]!()
  assert.deepEqual(writes.map(data => data.byteLength), [64 * 1024])
})

test("discard never acknowledges unparsed bytes", () => {
  let acknowledgements = 0
  const writer = createTerminalOutputWriter({
    write: () => assert.fail("discarded bytes must not parse"),
    schedule: () => 1,
    cancel: () => {},
  })
  writer.enqueue(bytes("pending"), () => { acknowledgements += 1 })
  writer.discardPending()
  writer.flush()
  assert.equal(acknowledgements, 0)
})

test("frame fallback parses output while animation frames are suspended", () => {
  const writes: Uint8Array[] = []
  const frames: Array<() => void> = []
  const fallbacks: Array<() => void> = []
  const cancelled: number[] = []
  const writer = createTerminalOutputWriter({
    write: (data, done) => { writes.push(data); done?.() },
    schedule: callback => { frames.push(callback); return frames.length },
    cancel: id => cancelled.push(id),
    scheduleFrameFallback: callback => { fallbacks.push(callback); return fallbacks.length },
    cancelFrameFallback: () => {},
    interactiveMaxBytes: 0,
  })
  const query = `${"x".repeat(1024)}\x1b[0c`
  writer.enqueue(bytes(query))
  fallbacks[0]!()
  assert.deepEqual(writes.map(text), [query])
  assert.deepEqual(cancelled, [1])
})

test("inactive frame clock uses the microtask parser path", async () => {
  const writes: Uint8Array[] = []
  let frameCount = 0
  const writer = createTerminalOutputWriter({
    write: (data, done) => { writes.push(data); done?.() },
    schedule: () => { frameCount += 1; return frameCount },
    cancel: () => {},
    frameClockActive: () => false,
    interactiveMaxBytes: 0,
  })
  writer.enqueue(bytes("query\x1b[0c"))
  await Promise.resolve()
  assert.deepEqual(writes.map(text), ["query\x1b[0c"])
  assert.equal(frameCount, 0)
})

test("flush bypasses frame cap for attach replay", () => {
  const writes: Uint8Array[] = []
  const writer = createTerminalOutputWriter({
    write: (data, done) => { writes.push(data); done?.() },
    schedule: () => 1,
    cancel: () => {},
    maxBytesPerFlush: 2,
  })
  writer.enqueue(bytes("attach-replay-full"))
  writer.flush()
  assert.deepEqual(writes.map(text), ["attach-replay-full"])
})

test("replay bypasses the live byte cap", () => {
  const replayWrites: Uint8Array[][] = []
  const writer = createTerminalOutputWriter({
    write: () => assert.fail("replay must use replay writer"),
    writeReplay: (chunks, done) => { replayWrites.push([...chunks]); done?.() },
    maxPendingBytes: 8,
  })
  writer.enqueueReplay(bytes("A".repeat(64 * 1024)))
  writer.enqueueReplay(bytes("B".repeat(64 * 1024)))
  writer.flush()
  assert.deepEqual(replayWrites[0]!.map(chunk => chunk.byteLength), [64 * 1024, 64 * 1024])
})

test("sheds oldest bytes and suppresses cumulative ACK until replay", () => {
  const scheduled: Array<() => void> = []
  const writes: Uint8Array[] = []
  const acknowledgements: string[] = []
  const writer = createTerminalOutputWriter({
    write: (data, done) => { writes.push(data); done?.() },
    schedule: callback => { scheduled.push(callback); return scheduled.length },
    cancel: () => {},
    maxPendingBytes: 8,
    interactiveMaxBytes: 0,
  })
  writer.enqueue(bytes("AAAAAAAA"), () => acknowledgements.push("a"))
  writer.enqueue(bytes("BBBB"), () => acknowledgements.push("b"))
  scheduled[0]!()
  assert.deepEqual(writes.map(text), ["BBBB"])
  assert.deepEqual(acknowledgements, [])
  writer.discardPending()
  writer.enqueue(bytes("C"), () => acknowledgements.push("c"))
  scheduled.at(-1)!()
  assert.deepEqual(acknowledgements, ["c"])
})

test("interactive bytes flush on a microtask without rAF", async () => {
  const writes: Uint8Array[] = []
  let rafCalls = 0
  const writer = createTerminalOutputWriter({
    write: (data, done) => { writes.push(data); done?.() },
    schedule: callback => { rafCalls += 1; queueMicrotask(callback); return rafCalls },
    cancel: () => {},
  })
  writer.enqueue(new Uint8Array([0xff, 0xe2]))
  await Promise.resolve()
  assert.deepEqual([...writes[0]!], [0xff, 0xe2])
  assert.equal(rafCalls, 0)
})
