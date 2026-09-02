import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import {
  TerminalViewportActivityPolicy,
  type TerminalViewportActivityFacts,
} from "./viewport-activity.js"

function facts(
  overrides: Partial<TerminalViewportActivityFacts> = {},
): TerminalViewportActivityFacts {
  return {
    viewportActive: true,
    totalRows: 100,
    viewportOffset: 80,
    geometryGeneration: 1,
    contentGeneration: 1,
    alternateScreen: false,
    ...overrides,
  }
}

describe("terminal viewport activity", () => {
  it("counts only proven appended rows while inspection stays anchored", () => {
    const policy = new TerminalViewportActivityPolicy()
    policy.observe(facts())
    policy.observe(facts({ viewportActive: false, viewportOffset: 64 }))
    assert.deepEqual(policy.current, { mode: "inspecting", unseenRows: 0 })

    policy.observe(facts({
      viewportActive: false,
      viewportOffset: 64,
      totalRows: 105,
      contentGeneration: 2,
    }))
    assert.deepEqual(policy.current, { mode: "inspecting", unseenRows: 5 })

    policy.observe(facts({
      viewportActive: false,
      viewportOffset: 64,
      totalRows: 105,
      contentGeneration: 3,
    }))
    assert.deepEqual(policy.current, { mode: "inspecting", unseenRows: 5 })
  })

  it("invalidates exactness after reflow or retention", () => {
    const reflow = new TerminalViewportActivityPolicy()
    reflow.observe(facts())
    reflow.observe(facts({ viewportActive: false, viewportOffset: 50 }))
    reflow.observe(facts({
      viewportActive: false,
      viewportOffset: 50,
      totalRows: 104,
      contentGeneration: 2,
    }))
    reflow.observe(facts({
      viewportActive: false,
      viewportOffset: 50,
      totalRows: 106,
      contentGeneration: 2,
      geometryGeneration: 2,
    }))
    assert.deepEqual(reflow.current, { mode: "inspecting", unseenRows: null })

    const retention = new TerminalViewportActivityPolicy()
    retention.observe(facts())
    retention.observe(facts({ viewportActive: false, viewportOffset: 10 }))
    retention.observe(facts({
      viewportActive: false,
      viewportOffset: 9,
      contentGeneration: 2,
    }))
    assert.deepEqual(retention.current, { mode: "inspecting", unseenRows: null })
  })

  it("treats output at a saturated retention floor as unknown", () => {
    const policy = new TerminalViewportActivityPolicy()
    policy.observe(facts())
    policy.observe(facts({ viewportActive: false, viewportOffset: 0 }))
    policy.observe(facts({
      viewportActive: false,
      viewportOffset: 0,
      contentGeneration: 2,
    }))
    assert.deepEqual(policy.current, { mode: "inspecting", unseenRows: null })
  })

  it("pauses inspection, resumes it, and jumps live", () => {
    const policy = new TerminalViewportActivityPolicy()
    policy.observe(facts())
    policy.observe(facts({ viewportActive: false, viewportOffset: 60 }))
    policy.pause()
    assert.deepEqual(policy.current, { mode: "paused", unseenRows: 0 })
    policy.resume()
    assert.deepEqual(policy.current, { mode: "inspecting", unseenRows: 0 })
    policy.pause()
    policy.jumpToLive()
    assert.deepEqual(policy.current, { mode: "live", unseenRows: 0 })
  })

  it("resets for alternate screen and coalesces duplicate publications", () => {
    const policy = new TerminalViewportActivityPolicy()
    const publications: string[] = []
    const unsubscribe = policy.subscribe(activity => {
      publications.push(`${activity.mode}:${activity.unseenRows}`)
    })
    policy.observe(facts())
    policy.observe(facts({ viewportActive: false, viewportOffset: 60 }))
    policy.observe(facts({ viewportActive: false, viewportOffset: 60 }))
    policy.observe(facts({
      viewportActive: false,
      viewportOffset: 60,
      alternateScreen: true,
    }))
    unsubscribe()
    policy.observe(facts({ viewportActive: false, viewportOffset: 60 }))
    assert.deepEqual(publications, ["live:0", "inspecting:0", "live:0"])
  })

  it("saturates counts without overflowing safe integers", () => {
    const policy = new TerminalViewportActivityPolicy()
    policy.observe(facts({ totalRows: 0, viewportOffset: 0 }))
    policy.observe(facts({
      viewportActive: false,
      totalRows: 0,
      viewportOffset: 0,
    }))
    policy.observe(facts({
      viewportActive: false,
      totalRows: Number.MAX_SAFE_INTEGER,
      viewportOffset: 0,
      contentGeneration: 2,
    }))
    assert.deepEqual(policy.current, {
      mode: "inspecting",
      unseenRows: Number.MAX_SAFE_INTEGER,
    })
  })
})
