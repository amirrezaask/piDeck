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

test("sample eviction cannot lose pending parse or posted accounting", () => {
  const scheduler = new TerminalFrameScheduler(() => 1, 2)
  const tokens = [scheduler.received(1), scheduler.received(1), scheduler.received(1)]
  scheduler.posted(3)
  for (const token of tokens) scheduler.parsed(token)
  scheduler.parsed(tokens[0]!) // duplicate callback
  scheduler.presented()
  const snapshot = scheduler.snapshot()
  assert.equal(snapshot.retainedSamples, 2)
  assert.equal(snapshot.receivedBytes, 3)
  assert.equal(snapshot.postedBytes, 3)
  assert.equal(snapshot.parsedBytes, 3)
  assert.equal(snapshot.presentedBytes, 3)
  assert.equal(snapshot.pendingBytes, 0)
})

test("generation reset fences stale callbacks even after timing eviction", () => {
  const scheduler = new TerminalFrameScheduler(() => 1, 0)
  const stale = scheduler.received(3)
  scheduler.resetGeneration()
  const current = scheduler.received(2)
  scheduler.parsed(stale)
  scheduler.posted(2)
  scheduler.parsed(current)
  assert.equal(scheduler.snapshot().parsedBytes, 2)
  assert.equal(scheduler.snapshot().postedBytes, 2)
  assert.equal(scheduler.snapshot().pendingBytes, 0)
})

test("next-rAF byte proxy uses submission cut, not later parse completions", () => {
  let time = 0
  const scheduler = new TerminalFrameScheduler(() => time, 1)
  scheduler.parsed(scheduler.received(2))
  scheduler.submitted()
  time = 10
  scheduler.parsed(scheduler.received(3))
  scheduler.presented({
    surfaceInstanceId: 1, runtimeGeneration: 1, rendererGeneration: 1,
    modelFrameId: 1, geometryGeneration: 1, modelAppliedAt: 1,
    renderStartedAt: 2, submittedAt: 3, nextPaintObservedAt: 16,
  })
  assert.equal(scheduler.snapshot().parsedBytes, 5)
  assert.equal(scheduler.snapshot().presentedBytes, 2)
  assert.equal(scheduler.snapshot().receivedToPresentedP95, 0)
})

test("an older observation cannot credit a newer submission's bytes", () => {
  const scheduler = new TerminalFrameScheduler(() => 1, 0)
  scheduler.parsed(scheduler.received(2))
  const firstCut = scheduler.submitted()
  scheduler.parsed(scheduler.received(3))
  const secondCut = scheduler.submitted()
  const sample = {
    surfaceInstanceId: 1, runtimeGeneration: 1, rendererGeneration: 1,
    modelFrameId: 1, geometryGeneration: 1, modelAppliedAt: 1,
    renderStartedAt: 2, submittedAt: 3, nextPaintObservedAt: 16,
  }
  scheduler.presented({ ...sample, parsedBytesAtSubmission: firstCut })
  assert.equal(scheduler.counters().presentedBytes, 2)
  scheduler.presented({ ...sample, parsedBytesAtSubmission: secondCut })
  assert.equal(scheduler.counters().presentedBytes, 5)
  scheduler.presented({ ...sample, parsedBytesAtSubmission: firstCut })
  assert.equal(scheduler.counters().presentedBytes, 5)
})
