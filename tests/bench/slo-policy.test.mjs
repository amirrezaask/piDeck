import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { budgetCeiling, validateRefreshProfile } from "./slo-policy.mjs"

const registry = JSON.parse(readFileSync(new URL("./slos.json", import.meta.url), "utf8"))

test("all reference ceilings agree with the selected 60 Hz formula", () => {
  for (const objective of registry.objectives)
    assert.equal(budgetCeiling(objective, 60), objective.ceiling)
})
test("120 Hz proxy budgets retain processing allowances", () => {
  const budgets = registry.objectives.filter((objective) => objective.frameAllowance !== undefined)
  assert.deepEqual(
    budgets.map((objective) => budgetCeiling(objective, 120)),
    [25, 41, 41, 74, 41, 74],
  )
})
test("refresh mismatch cannot turn a slow renderer into a larger budget", () => {
  validateRefreshProfile(60, 59.9, 0.1)
  validateRefreshProfile(120, 119.8, 0.1)
  for (const [selected, measured] of [
    [120, 60],
    [60, 30],
    [0, 0],
    [60, NaN],
  ])
    assert.throws(() => validateRefreshProfile(selected, measured, 0.1))
  assert.throws(() => budgetCeiling({ ceiling: 50 }, 30))
})
test("partial or invalid frame formulas are rejected", () => {
  for (const objective of [
    { ceiling: 50, frameAllowance: 2 },
    { ceiling: 50, processingAllowanceMs: 8 },
    { ceiling: 50, frameAllowance: 0, processingAllowanceMs: 8 },
    { ceiling: 50, frameAllowance: 2, processingAllowanceMs: NaN },
  ])
    assert.throws(() => budgetCeiling(objective, 60))
})
test("each latency workload has independent p95/p99 gates and 100 samples", () => {
  for (const metric of [
    "terminal-key-next-raf-idle",
    "terminal-key-next-raf-loaded-1pane",
    "terminal-key-next-raf-loaded-6pane",
  ]) {
    const objectives = registry.objectives.filter((objective) => objective.metric === metric)
    assert.deepEqual(
      objectives.map((objective) => objective.percentile),
      ["p95", "p99"],
    )
    for (const objective of objectives) {
      assert.equal(objective.iterations, 100)
      assert.equal(objective.warmup, 5)
      assert.ok(registry.workloads.some((workload) => workload.id === objective.corpus))
    }
  }
})
