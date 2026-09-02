import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { FairWorkerScheduler, WORKER_SCHEDULER_LIMITS } from "./fair-scheduler.js"

const turn = () => new Promise<void>(resolve => queueMicrotask(resolve))

test("fair worker scheduler preserves terminal order and bounds ownership", async () => {
  const sent: Array<[string, number]> = []
  const scheduler = new FairWorkerScheduler<number>((id, value) => sent.push([id, value]))
  scheduler.enqueue("hidden", 1, 1, { visible: false, focused: false }, 1)
  scheduler.enqueue("hidden", 2, 1, { visible: false, focused: false }, 2)
  scheduler.enqueue("focused", 1, 1, { visible: true, focused: true }, 1)
  scheduler.enqueue("focused", 2, 1, { visible: true, focused: true }, 2)
  await turn()
  assert.deepEqual(sent, [["hidden", 1], ["focused", 1]])
  scheduler.complete("focused", 1)
  scheduler.complete("hidden", 1)
  await turn()
  assert.deepEqual(sent.filter(([id]) => id === "hidden").map(([, value]) => value), [1, 2])
  assert.deepEqual(sent.filter(([id]) => id === "focused").map(([, value]) => value), [1, 2])
  scheduler.complete("focused", 2); scheduler.complete("hidden", 2)
  assert.deepEqual(scheduler.snapshot(), { bytes: 0, commands: 0, inFlight: 0 })
})

test("fair worker scheduler prioritizes a focused large write without starving hidden work", async () => {
  const sent: string[] = []
  const scheduler = new FairWorkerScheduler<string>(id => sent.push(id))
  scheduler.enqueue("hidden", "hidden", 1024 * 1024, { visible: false, focused: false }, 1)
  scheduler.enqueue("focused", "focused", 1024 * 1024, { visible: true, focused: true }, 1)
  for (let turnIndex = 0; turnIndex < 20 && sent.length < 2; turnIndex += 1) await turn()
  assert.deepEqual(sent, ["focused", "hidden"])
})

test("stale completion cannot release a replacement generation", async () => {
  const scheduler = new FairWorkerScheduler(() => undefined)
  scheduler.enqueue("terminal", 1, 1, { visible: true, focused: true }, "1:1")
  await turn()
  scheduler.cancel("terminal")
  scheduler.enqueue("terminal", 2, 1, { visible: true, focused: true }, "2:1")
  await turn()
  scheduler.complete("terminal", "1:1")
  assert.equal(scheduler.snapshot().inFlight, 1)
  scheduler.complete("terminal", "2:1")
  assert.equal(scheduler.snapshot().inFlight, 0)
})

test("fair worker scheduler rejects aggregate byte overflow", () => {
  const scheduler = new FairWorkerScheduler(() => undefined)
  assert.throws(() => scheduler.enqueue(
    "terminal", 1, WORKER_SCHEDULER_LIMITS.maxBytes + 1,
    { visible: true, focused: true },
    1,
  ), /scheduler is full/)
})
