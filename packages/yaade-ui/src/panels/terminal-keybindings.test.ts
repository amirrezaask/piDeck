import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  shouldSuppressMacMetaKey,
  terminalKeybindingData,
} from "./terminal-keybindings.js"

function key(
  value: string,
  modifiers: Partial<KeyboardEvent> = {},
): Parameters<typeof terminalKeybindingData>[0] {
  return {
    type: "keydown",
    key: value,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    ...modifiers,
  }
}

test("maps multiline input without changing unmodified Enter", () => {
  assert.equal(terminalKeybindingData(key("Enter", { shiftKey: true }), "MacIntel"), "\n")
  assert.equal(terminalKeybindingData(key("Enter"), "MacIntel"), null)
})

test("maps macOS word, line, and delete navigation to readline bytes", () => {
  assert.equal(terminalKeybindingData(key("ArrowLeft", { altKey: true }), "MacIntel"), "\u001bb")
  assert.equal(terminalKeybindingData(key("ArrowRight", { altKey: true }), "MacIntel"), "\u001bf")
  assert.equal(terminalKeybindingData(key("ArrowLeft", { metaKey: true }), "MacIntel"), "\u0001")
  assert.equal(terminalKeybindingData(key("ArrowRight", { metaKey: true }), "MacIntel"), "\u0005")
  assert.equal(terminalKeybindingData(key("Backspace", { altKey: true }), "MacIntel"), "\u001b\u007f")
  assert.equal(terminalKeybindingData(key("Backspace", { metaKey: true }), "MacIntel"), "\u0015")
})

test("leaves composition and non-macOS shortcuts to xterm", () => {
  assert.equal(
    terminalKeybindingData(key("ArrowLeft", { altKey: true, isComposing: true }), "MacIntel"),
    null,
  )
  assert.equal(terminalKeybindingData(key("ArrowLeft", { altKey: true }), "Linux"), null)
})

test("suppresses unhandled Apple Command keys in the browser adapter", () => {
  assert.equal(
    shouldSuppressMacMetaKey(key("c", { metaKey: true }), "MacIntel"),
    true,
  )
  assert.equal(
    shouldSuppressMacMetaKey(key("ArrowLeft", { metaKey: true }), "MacIntel"),
    true,
  )
  assert.equal(
    shouldSuppressMacMetaKey(key("c", { metaKey: true }), "Linux"),
    false,
  )
  assert.equal(
    shouldSuppressMacMetaKey(key("Meta", { metaKey: true }), "MacIntel"),
    false,
  )
})
