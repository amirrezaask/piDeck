import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { TerminalFrameScheduler } from "./terminal-frame-scheduler.js"

test("tracks received, posted, parsed, and presented as distinct stages", () => {
  let time = 0
  const scheduler = new TerminalFrameScheduler(() => time, 8)
  const first = scheduler.received(4)
  time = 2
  scheduler.posted(4)
  time = 7
  scheduler.parsed(first)
  let snapshot = scheduler.snapshot()
  assert.equal(snapshot.receivedBytes, 4)
  assert.equal(snapshot.postedBytes, 4)
  assert.equal(snapshot.parsedBytes, 4)
  assert.equal(snapshot.presentedBytes, 0)
  assert.equal(snapshot.receivedToParsedP95, 7)
  time = 11
  scheduler.presented()
  snapshot = scheduler.snapshot()
  assert.equal(snapshot.presentedBytes, 4)
  assert.equal(snapshot.receivedToPresentedP95, 11)
})

test("retains bounded payload-free metrics", () => {
  const scheduler = new TerminalFrameScheduler(() => 1, 3)
  for (let index = 0; index < 10; index += 1) {
    const token = scheduler.received(1)
    scheduler.posted(1)
    scheduler.parsed(token)
    scheduler.presented()
  }
  const snapshot = scheduler.snapshot()
  assert.equal(snapshot.retainedSamples, 3)
  assert.equal(snapshot.receivedBytes, 10)
  assert.equal("data" in snapshot, false)
})

test("records monotonic generation-aware presentation stages", () => {
  let time = 10
  const scheduler = new TerminalFrameScheduler(() => time)
  const token = scheduler.received(8)
  time = 12
  scheduler.posted(8)
  time = 14
  scheduler.parsed(token)
  scheduler.presented({
    surfaceInstanceId: 3,
    runtimeGeneration: 2,
    rendererGeneration: 4,
    modelFrameId: 9,
    geometryGeneration: 5,
    modelAppliedAt: 15,
    renderStartedAt: 16,
    submittedAt: 17,
    nextPaintObservedAt: 18,
  })
  const snapshot = scheduler.snapshot()
  assert.equal(snapshot.parsedToSubmittedP95, 3)
  assert.equal(snapshot.receivedToPresentedP95, 8)
  assert.equal(snapshot.frameDelayP95, 1)
  assert.equal(snapshot.lastSubmittedModelFrame, 9)
  assert.equal(snapshot.lastNextPaintObservedFrame, 9)
})

test("does not present or release pending bytes before parse", () => {
  const scheduler = new TerminalFrameScheduler(() => 1)
  scheduler.received(12)
  scheduler.posted(12)
  scheduler.presented()
  const snapshot = scheduler.snapshot()
  assert.equal(snapshot.pendingBytes, 12)
  assert.equal(snapshot.parsedBytes, 0)
  assert.equal(snapshot.presentedBytes, 0)
})
