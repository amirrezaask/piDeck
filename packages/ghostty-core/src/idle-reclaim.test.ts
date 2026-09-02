import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { shouldReclaimIdleCapacity } from "./idle-reclaim.js"

const eligible = {
  now: 120_000,
  allocatedBytes: 8 * 1024 * 1024,
  targetBytes: 1024 * 1024,
  inFlight: 0,
  queued: 0,
  lastActivityAt: 0,
  lastResizeAt: 0,
}

test("idle reclamation requires ownership, hysteresis, and cooldown", () => {
  assert.equal(shouldReclaimIdleCapacity(eligible), true)
  assert.equal(shouldReclaimIdleCapacity({ ...eligible, inFlight: 1 }), false)
  assert.equal(shouldReclaimIdleCapacity({ ...eligible, queued: 1 }), false)
  assert.equal(shouldReclaimIdleCapacity({ ...eligible, lastActivityAt: 100_000 }), false)
  assert.equal(shouldReclaimIdleCapacity({ ...eligible, lastResizeAt: 100_000 }), false)
  assert.equal(shouldReclaimIdleCapacity({ ...eligible, allocatedBytes: 3 * 1024 * 1024 }), false)
  assert.equal(shouldReclaimIdleCapacity({ ...eligible, allocatedBytes: 1_500_000 }), false)
})
