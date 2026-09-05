import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { createTerminalDispatchTasks } from "./terminal-dispatch-tasks.js"
import { createTerminalOutputWriter } from "./terminal-output-writer.js"

test("six busy writers share FIFO turns, one bounded quantum per pane", () => {
  const turns: Array<() => void> = []
  const tasks = createTerminalDispatchTasks((run) => {
    turns.push(run)
  })
  const writes: number[] = []
  const writers = Array.from({ length: 6 }, (_, pane) =>
    createTerminalOutputWriter({
      ...tasks,
      interactiveMaxBytes: 0,
      maxBytesPerFlush: 2,
      write: (data, done) => {
        assert.equal(data.byteLength, 2)
        writes.push(pane)
        done?.()
      },
    }),
  )
  for (const writer of writers) writer.enqueue(new Uint8Array(6))
  for (let turn = 0; turn < 18; turn += 1) {
    assert.equal(turns.length, 1)
    turns.shift()!()
    assert.equal(writes.length, turn + 1)
  }
  assert.deepEqual(
    writes,
    [...Array(3)].flatMap(() => [0, 1, 2, 3, 4, 5]),
  )
  assert.equal(turns.length, 0)
  for (const writer of writers) writer.dispose()
})

test("cancelled callbacks release capacity and cannot run in a later turn", () => {
  const turns: Array<() => void> = []
  const tasks = createTerminalDispatchTasks((run) => {
    turns.push(run)
  })
  const ids = Array.from({ length: 1024 }, () => tasks.schedule(() => assert.fail("cancelled")))
  assert.throws(() => tasks.schedule(() => {}), /capacity/)
  for (const id of ids) tasks.cancel(id)
  let ran = false
  tasks.schedule(() => {
    ran = true
  })
  assert.equal(turns.length, 1)
  turns.shift()!()
  assert.equal(ran, true)
  assert.equal(turns.length, 0)
})

test("a failed callback does not strand another pane", () => {
  const turns: Array<() => void> = []
  const tasks = createTerminalDispatchTasks((run) => {
    turns.push(run)
  })
  let ran = false
  tasks.schedule(() => {
    throw new Error("pane failed")
  })
  tasks.schedule(() => {
    ran = true
  })
  assert.throws(() => turns.shift()!(), /pane failed/)
  turns.shift()!()
  assert.equal(ran, true)
})

test("host scheduling failure releases the rejected callback", () => {
  const turns: Array<() => void> = []
  let reject = true
  const tasks = createTerminalDispatchTasks((run) => {
    if (reject) throw new Error("host unavailable")
    turns.push(run)
  })
  assert.throws(() => tasks.schedule(() => assert.fail("rejected")), /host unavailable/)
  reject = false
  let ran = false
  tasks.schedule(() => {
    ran = true
  })
  turns.shift()!()
  assert.equal(ran, true)
})
