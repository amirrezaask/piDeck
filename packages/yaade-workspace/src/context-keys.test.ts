import { describe, it } from "vite-plus/test"
import assert from "node:assert/strict"
import {
  keyEventMatchesBinding,
  keyEventMatchesBindingPart,
  parseBindingKey,
} from "./context-keys.js"

function keyEvent(init: {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  code?: string
}): KeyboardEvent {
  return {
    key: init.key,
    code: init.code ?? init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as KeyboardEvent
}

describe("keyEventMatchesBindingPart", () => {
  it("matches Cmd-f", () => {
    assert.equal(keyEventMatchesBindingPart(keyEvent({ key: "f", metaKey: true }), "Cmd-f"), true)
  })

  it("matches Ctrl-g without meta", () => {
    assert.equal(keyEventMatchesBindingPart(keyEvent({ key: "g", ctrlKey: true }), "Ctrl-g"), true)
    assert.equal(
      keyEventMatchesBindingPart(keyEvent({ key: "g", metaKey: true, ctrlKey: true }), "Ctrl-g"),
      false,
    )
  })

  it("rejects Cmd-g for Ctrl-g binding", () => {
    assert.equal(keyEventMatchesBindingPart(keyEvent({ key: "g", metaKey: true }), "Ctrl-g"), false)
  })

  it("matches Cmd-Alt-f", () => {
    assert.equal(
      keyEventMatchesBindingPart(keyEvent({ key: "f", metaKey: true, altKey: true }), "Cmd-Alt-f"),
      true,
    )
  })

  it("falls back to the physical code when a modifier changes event.key", () => {
    assert.equal(
      keyEventMatchesBindingPart(
        keyEvent({ key: "∂", code: "KeyD", metaKey: true }),
        "Cmd-d",
      ),
      true,
    )
  })

  it("matches Ctrl-backquote", () => {
    assert.equal(
      keyEventMatchesBindingPart(keyEvent({ key: "`", ctrlKey: true, code: "Backquote" }), "Ctrl-`"),
      true,
    )
  })

  it("matches Cmd-- (zoom out minus key)", () => {
    assert.equal(
      keyEventMatchesBindingPart(keyEvent({ key: "-", metaKey: true, code: "Minus" }), "Cmd--"),
      true,
    )
    assert.equal(
      keyEventMatchesBindingPart(keyEvent({ key: "Minus", metaKey: true, code: "Minus" }), "Cmd--"),
      true,
    )
  })

  it("matches Mod-backslash", () => {
    const mac = process.platform === "darwin"
    assert.equal(
      keyEventMatchesBindingPart(
        keyEvent({ key: "\\", metaKey: mac, ctrlKey: !mac, code: "Backslash" }),
        "Mod-\\",
      ),
      true,
    )
    assert.equal(
      keyEventMatchesBindingPart(
        keyEvent({
          key: "\\",
          metaKey: mac,
          ctrlKey: !mac,
          shiftKey: true,
          code: "Backslash",
        }),
        "Mod-Shift-\\",
      ),
      true,
    )
  })

  it("Mod uses platform primary modifier", () => {
    const mac = process.platform === "darwin"
    assert.equal(
      keyEventMatchesBindingPart(
        keyEvent({ key: "n", metaKey: true, ctrlKey: false }),
        "Mod-n",
      ),
      mac,
    )
    assert.equal(
      keyEventMatchesBindingPart(
        keyEvent({ key: "n", metaKey: false, ctrlKey: true }),
        "Mod-n",
      ),
      !mac,
    )
  })
})

describe("keyEventMatchesBinding", () => {
  it("rejects chord strings as single binding", () => {
    assert.equal(keyEventMatchesBinding(keyEvent({ key: "k", metaKey: true }), "Cmd-k Cmd-o"), false)
  })
})

describe("parseBindingKey", () => {
  it("splits chord parts", () => {
    assert.deepEqual(parseBindingKey("Cmd-k Cmd-o"), ["Cmd-k", "Cmd-o"])
  })
})
