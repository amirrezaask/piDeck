import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { createTerminalInputWriter } from "./terminal-input-writer.js"

test("coalesces same-turn input and preserves write order", async () => {
  const writes: string[] = []
  const writer = createTerminalInputWriter(
    async data => {
      writes.push(data)
    },
    error => assert.fail(String(error)),
  )

  writer.enqueue("a")
  writer.enqueue("b")
  await writer.flush()
  writer.enqueue("c")
  await writer.flush()

  assert.deepEqual(writes, ["ab", "c"])
})

test("reports rejected writes without producing an unhandled rejection", async () => {
  const errors: unknown[] = []
  const writer = createTerminalInputWriter(
    async () => {
      throw new Error("offline")
    },
    error => errors.push(error),
  )

  writer.enqueue("input")
  await writer.flush()
  // Fire-and-forget: rejection lands on a microtask after send.
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(errors.length, 1)
})

test("preserves ordering between text and binary terminal input", async () => {
  const writes: string[] = []
  const writer = createTerminalInputWriter(
    async data => {
      writes.push(`text:${data}`)
    },
    error => assert.fail(String(error)),
    async data => {
      writes.push(`binary:${data}`)
    },
  )

  writer.enqueue("a")
  writer.enqueueBinary("\x80\xff")
  writer.enqueue("b")
  await writer.flush()

  assert.deepEqual(writes, ["text:a", "binary:\x80\xff", "text:b"])
})

test("does not let a later async write overtake an earlier one", async () => {
  const writes: string[] = []
  const resolvers: Array<() => void> = []
  const writer = createTerminalInputWriter(
    data => {
      writes.push(data)
      return new Promise<void>(resolve => resolvers.push(resolve))
    },
    error => assert.fail(String(error)),
  )

  writer.enqueue("first")
  const firstFlush = writer.flush()
  writer.enqueue("second")
  const secondFlush = writer.flush()
  await Promise.resolve()
  assert.deepEqual(writes, ["first"])
  resolvers[0]!()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(writes, ["first", "second"])
  resolvers[1]!()
  await Promise.all([firstFlush, secondFlush])
})
