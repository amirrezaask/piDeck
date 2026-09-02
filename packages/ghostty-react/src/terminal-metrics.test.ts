import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { TERMINAL_METRIC_STAGES, TerminalStageMetrics } from "./terminal-metrics.js"

test("terminal stage snapshots are bounded, versioned, and payload-free", () => {
  const metrics = new TerminalStageMetrics()
  for (let id = 0; id < 300; id += 1) {
    metrics.start(id, "parsed", id)
    metrics.finish(id, id + (id % 10))
  }
  metrics.mark("presented")
  const snapshot = metrics.snapshot()
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.sampleCount, 256)
  assert.equal(snapshot.counters.parsed, 300)
  assert.equal(snapshot.counters.presented, 1)
  assert.deepEqual(Object.keys(snapshot.counters), TERMINAL_METRIC_STAGES)
  assert.equal(JSON.stringify(snapshot).includes("payload"), false)
  assert.ok(snapshot.p99Ms >= snapshot.p50Ms)
})
