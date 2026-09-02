import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { ghosttyConsumedModifierBits } from "./keyCodes.js"

function key(
  code: string,
  value: string,
  modifiers: {
    altKey?: boolean
    altGraph?: boolean
    shiftKey?: boolean
  } = {},
): Parameters<typeof ghosttyConsumedModifierBits>[0] {
  return {
    code,
    key: value,
    altKey: modifiers.altKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    getModifierState: name => name === "AltGraph" && (modifiers.altGraph ?? false),
  }
}

test("marks layout-generated Shift text as consumed", () => {
  assert.equal(
    ghosttyConsumedModifierBits(
      key("KeyA", "A", { shiftKey: true }),
      { get: () => "a" },
      "Linux",
    ),
    1,
  )
})

test("marks both Ctrl and Alt consumed for AltGraph text", () => {
  assert.equal(
    ghosttyConsumedModifierBits(
      key("KeyQ", "@", { altGraph: true }),
      { get: () => "q" },
      "Linux",
    ),
    1 << 1 | 1 << 2,
  )
})

test("marks layout-generated macOS Option text as consumed Alt", () => {
  assert.equal(
    ghosttyConsumedModifierBits(
      key("KeyA", "å", { altKey: true }),
      { get: () => "a" },
      "MacIntel",
    ),
    1 << 2,
  )
})
