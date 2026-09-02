import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  TerminalGeometryCoordinator,
  type TerminalGeometryClock,
  type TerminalGeometryCommit,
} from "./terminal-geometry-coordinator.js"

function fakeClock(): TerminalGeometryClock & { flush(): void; pending(): number } {
  let id = 0
  const callbacks = new Map<number, () => void>()
  return {
    requestFrame(callback) {
      const handle = ++id
      callbacks.set(handle, callback)
      return handle
    },
    cancelFrame(handle) { callbacks.delete(handle) },
    flush() {
      const current = [...callbacks.values()]
      callbacks.clear()
      for (const callback of current) callback()
    },
    pending: () => callbacks.size,
  }
}

const sample = {
  cssWidth: 808,
  cssHeight: 408,
  pixelRatio: 2,
  cellWidth: 10,
  cellHeight: 20,
}

test("coalesces observer and DPR bursts to one latest commit per frame", () => {
  const clock = fakeClock()
  const commits: TerminalGeometryCommit[] = []
  const coordinator = new TerminalGeometryCoordinator({
    padding: 4,
    clock,
    onCommit: commit => commits.push(commit),
  })
  coordinator.observe(sample)
  coordinator.observe({ ...sample, cssWidth: 708 })
  coordinator.observe({ ...sample, cssWidth: 608, pixelRatio: 1.5 })
  assert.equal(clock.pending(), 1)
  clock.flush()
  assert.equal(commits.length, 1)
  assert.deepEqual(commits[0], {
    ...sample,
    cssWidth: 608,
    pixelRatio: 1.5,
    generation: 1,
    cols: 60,
    rows: 20,
  })
})

test("deduplicates identical geometry and commits final reverse resize", () => {
  const clock = fakeClock()
  const commits: TerminalGeometryCommit[] = []
  const coordinator = new TerminalGeometryCoordinator({
    padding: 4,
    clock,
    onCommit: commit => commits.push(commit),
  })
  assert.equal(coordinator.commitNow(sample), true)
  assert.equal(coordinator.commitNow(sample), false)
  coordinator.observe({ ...sample, cssWidth: 500 })
  coordinator.observe(sample)
  clock.flush()
  assert.equal(commits.length, 1)
  assert.equal(commits[0]?.generation, 1)
})

test("rejects zero-size samples and cancels pending work on disposal", () => {
  const clock = fakeClock()
  let commits = 0
  const coordinator = new TerminalGeometryCoordinator({
    padding: 4,
    clock,
    onCommit: () => { commits += 1 },
  })
  assert.equal(coordinator.observe({ ...sample, cssWidth: 0 }), false)
  coordinator.observe(sample)
  coordinator.dispose()
  clock.flush()
  assert.equal(commits, 0)
})
