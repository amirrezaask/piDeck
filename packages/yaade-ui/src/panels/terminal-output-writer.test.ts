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

test("custom task IDs cannot be cancelled through the shared scheduler", () => {
  assert.throws(
    () => createTerminalOutputWriter({ write: () => {}, schedule: () => 1 }),
    /matching cancel/,
  )
  assert.throws(
    () => createTerminalOutputWriter({ write: () => {}, cancel: () => {} }),
    /matching cancel/,
  )
})

test("coalesces multiple byte parts into one write", () => {
  const writes: Uint8Array[] = []
  const scheduled: Array<() => void> = []
  const writer = createTerminalOutputWriter({
    write: (data, done) => {
      writes.push(data)
      done?.()
    },
    schedule: (callback) => {
      scheduled.push(callback)
      return scheduled.length
    },
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
    refreshAfterPaint: () => {
      refreshes += 1
    },
    schedule: (callback) => {
      scheduled.push(callback)
      return scheduled.length
    },
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
    write: (data, done) => {
      writes.push(data)
      done?.()
    },
    schedule: (callback) => {
      scheduled.push(callback)
      return scheduled.length
    },
    cancel: () => {},
    maxBytesPerFlush: 4,
    interactiveMaxBytes: 0,
  })
  writer.enqueue(bytes("abcdefgh"), () => {
    acknowledgements += 1
  })
  scheduled[0]!()
  assert.deepEqual(writes.map(text), ["abcd"])
  assert.equal(acknowledgements, 0)
  scheduled[1]!()
  assert.deepEqual(writes.map(text), ["abcd", "efgh"])
  assert.equal(acknowledgements, 1)
})

test("a maximum host frame parses in one task", () => {
  const writes: Uint8Array[] = []
  const scheduled: Array<() => void> = []
  const writer = createTerminalOutputWriter({
    write: (data, done) => {
      writes.push(data)
      done?.()
    },
    schedule: (callback) => {
      scheduled.push(callback)
      return scheduled.length
    },
    cancel: () => {},
    maxBytesPerFlush: GHOSTTY_OUTPUT_MAX_BYTES_PER_FLUSH,
    interactiveMaxBytes: 0,
  })
  writer.enqueue(bytes("x".repeat(64 * 1024)))
  scheduled[0]!()
  assert.deepEqual(
    writes.map((data) => data.byteLength),
    [64 * 1024],
  )
})

test("discard never acknowledges unparsed bytes", () => {
  let acknowledgements = 0
  const writer = createTerminalOutputWriter({
    write: () => assert.fail("discarded bytes must not parse"),
    schedule: () => 1,
    cancel: () => {},
  })
  writer.enqueue(bytes("pending"), () => {
    acknowledgements += 1
  })
  writer.discardPending()
  writer.flush()
  assert.equal(acknowledgements, 0)
})

test("flood dispatch waits for parser credit, not a presentation frame", () => {
  const writes: Uint8Array[] = []
  const tasks: Array<() => void> = []
  const completions: Array<() => void> = []
  const writer = createTerminalOutputWriter({
    write: (data, done) => {
      writes.push(data)
      completions.push(done!)
    },
    schedule: (callback) => {
      tasks.push(callback)
      return tasks.length
    },
    cancel: () => {},
    maxBytesPerFlush: 4,
    interactiveMaxBytes: 0,
  })
  writer.enqueue(bytes("abcdefghijkl"))
  tasks[0]!()
  writer.flush()
  assert.deepEqual(writes.map(text), ["abcd"])
  assert.equal(tasks.length, 1)
  completions[0]!()
  assert.equal(tasks.length, 2)
  tasks[1]!()
  assert.deepEqual(writes.map(text), ["abcd", "efgh"])
  completions[0]!() // duplicate credit must not release the second command
  writer.flush()
  assert.equal(writes.length, 2)
})

test("interactive parsing needs no display-clock scheduler", async () => {
  const writes: Uint8Array[] = []
  let frameCount = 0
  const writer = createTerminalOutputWriter({
    write: (data, done) => {
      writes.push(data)
      done?.()
    },
    schedule: () => {
      frameCount += 1
      return frameCount
    },
    cancel: () => {},
  })
  writer.enqueue(bytes("query\x1b[0c"))
  await Promise.resolve()
  assert.deepEqual(writes.map(text), ["query\x1b[0c"])
  assert.equal(frameCount, 0)
})

test("explicit flush keeps the parser quantum bounded", () => {
  const writes: Uint8Array[] = []
  const writer = createTerminalOutputWriter({
    write: (data, done) => {
      writes.push(data)
      done?.()
    },
    schedule: () => 1,
    cancel: () => {},
    maxBytesPerFlush: 2,
  })
  writer.enqueue(bytes("attach-replay-full"))
  writer.flush()
  assert.deepEqual(writes.map(text), ["at"])
  writer.dispose()
})

test("replay bypasses the live byte cap", () => {
  const replayWrites: Uint8Array[][] = []
  const writer = createTerminalOutputWriter({
    write: () => assert.fail("replay must use replay writer"),
    writeReplay: (chunks, done) => {
      replayWrites.push([...chunks])
      done?.()
    },
    maxPendingBytes: 8,
  })
  writer.enqueueReplay(bytes("A".repeat(64 * 1024)))
  writer.enqueueReplay(bytes("B".repeat(64 * 1024)))
  writer.flush()
  assert.deepEqual(
    replayWrites[0]!.map((chunk) => chunk.byteLength),
    [64 * 1024, 64 * 1024],
  )
})

test("overflow rejects the stream and requests resync without parsing a gap", () => {
  const scheduled: Array<() => void> = []
  const writes: Uint8Array[] = []
  const acknowledgements: string[] = []
  let resyncs = 0
  const writer = createTerminalOutputWriter({
    write: (data, done) => {
      writes.push(data)
      done?.()
    },
    schedule: (callback) => {
      scheduled.push(callback)
      return scheduled.length
    },
    cancel: () => {},
    maxPendingBytes: 8,
    interactiveMaxBytes: 0,
    onOverflow: () => {
      resyncs += 1
    },
  })
  writer.enqueue(bytes("AAAAAAAA"), () => acknowledgements.push("a"))
  writer.enqueue(bytes("BBBB"), () => acknowledgements.push("b"))
  scheduled[0]!()
  assert.deepEqual(writes.map(text), [])
  assert.equal(resyncs, 1)
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
    write: (data, done) => {
      writes.push(data)
      done?.()
    },
    schedule: (callback) => {
      rafCalls += 1
      queueMicrotask(callback)
      return rafCalls
    },
    cancel: () => {},
  })
  writer.enqueue(new Uint8Array([0xff, 0xe2]))
  await Promise.resolve()
  assert.deepEqual([...writes[0]!], [0xff, 0xe2])
  assert.equal(rafCalls, 0)
})

test("large replay is sliced and holds live bytes until parser completion", () => {
  const tasks: Array<() => void> = []
  const writes: number[] = []
  let complete: (() => void) | undefined
  let replayAck = 0
  const writer = createTerminalOutputWriter({
    write: (data) => {
      writes.push(-data.byteLength)
    },
    writeReplay: (chunks, done) => {
      writes.push(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
      complete = done
    },
    maxBytesPerFlush: 256 * 1024,
    interactiveMaxBytes: 0,
    schedule: (callback) => {
      tasks.push(callback)
      return tasks.length
    },
    cancel: () => {},
  })
  writer.enqueueReplay(new Uint8Array(16 * 1024 * 1024), () => {
    replayAck += 1
  })
  writer.flush()
  writer.enqueue(new Uint8Array(1))
  for (let slice = 0; slice < 64; slice += 1) {
    assert.equal(writes.length, slice + 1)
    assert.equal(replayAck, 0)
    complete!()
    tasks.shift()!()
  }
  assert.equal(replayAck, 1)
  assert.equal(writes.at(-1), -1)
  assert.ok(writes.slice(0, -1).every((bytes) => bytes === 256 * 1024))
  writer.dispose()
})

test("stale completions cannot release a replacement stream's credit", () => {
  const completions: Array<() => void> = []
  let acknowledged = 0
  const writer = createTerminalOutputWriter({
    write: (_data, done) => {
      completions.push(done!)
    },
    schedule: () => 1,
    cancel: () => {},
    interactiveMaxBytes: 0,
  })
  writer.enqueue(bytes("old"), () => {
    acknowledged += 100
  })
  writer.flush()
  writer.suspend()
  writer.enqueue(bytes("gap"))
  writer.flush()
  assert.equal(completions.length, 1)
  writer.discardPending()
  writer.enqueue(bytes("new"), () => {
    acknowledged += 1
  })
  writer.flush()
  completions[0]!()
  writer.enqueue(bytes("later"))
  writer.flush()
  assert.equal(completions.length, 2)
  completions[1]!()
  assert.equal(acknowledged, 1)
  writer.dispose()
})

test("ACK-triggered small writes yield instead of chaining microtasks", async () => {
  const tasks: Array<() => void> = []
  let writes = 0
  const writer = createTerminalOutputWriter({
    schedule: (run) => {
      tasks.push(run)
      return tasks.length
    },
    cancel: () => {},
    write: (_data, done) => {
      writes += 1
      done?.()
    },
  })
  writer.enqueue(bytes("first"), () => writer.enqueue(bytes("second")))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(writes, 1)
  assert.equal(tasks.length, 1)
  tasks[0]!()
  assert.equal(writes, 2)
  writer.dispose()
})

test("cancelled task cannot dispatch a replacement scheduled after explicit flush", () => {
  const tasks: Array<() => void> = []
  let writes = 0
  const writer = createTerminalOutputWriter({
    schedule: (run) => {
      tasks.push(run)
      return tasks.length
    },
    cancel: () => {}, // Simulate a host callback already dequeued for execution.
    interactiveMaxBytes: 0,
    write: (_data, done) => {
      writes += 1
      done?.()
    },
  })
  writer.enqueue(bytes("first"))
  writer.flush()
  writer.enqueue(bytes("second"))
  tasks[0]!()
  assert.equal(writes, 1)
  tasks[1]!()
  assert.equal(writes, 2)
  writer.dispose()
})

test("a rejected parser command fences the stream until a replacement snapshot", () => {
  let reject = true
  let resyncs = 0
  let acknowledgements = 0
  const writer = createTerminalOutputWriter({
    schedule: () => 1,
    cancel: () => {},
    interactiveMaxBytes: 0,
    onOverflow: () => {
      resyncs += 1
    },
    write: (_data, done) => {
      if (reject) throw new Error("worker command rejected")
      done?.()
    },
  })
  writer.enqueue(bytes("old"), () => {
    acknowledgements += 100
  })
  writer.flush()
  assert.equal(resyncs, 1)
  assert.equal(acknowledgements, 0)
  reject = false
  writer.enqueue(bytes("gap"), () => {
    acknowledgements += 100
  })
  writer.flush()
  assert.equal(acknowledgements, 0)
  writer.discardPending()
  writer.enqueue(bytes("new"), () => {
    acknowledgements += 1
  })
  writer.flush()
  assert.equal(acknowledgements, 1)
  writer.dispose()
})

test("task admission failure requests resync instead of losing dispatch silently", () => {
  let resyncs = 0
  const writer = createTerminalOutputWriter({
    schedule: () => {
      throw new Error("full")
    },
    cancel: () => {},
    interactiveMaxBytes: 0,
    onOverflow: () => {
      resyncs += 1
    },
    write: () => assert.fail("desynchronized"),
  })
  writer.enqueue(bytes("first"))
  writer.enqueue(bytes("later"))
  writer.flush()
  assert.equal(resyncs, 1)
  writer.dispose()
})
