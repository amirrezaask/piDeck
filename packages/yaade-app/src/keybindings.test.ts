import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { Option } from "effect"
import {
  MUX_SESSION_DIRECT_BINDINGS,
  MUX_SESSION_PREFIX_BINDINGS,
  clearMuxSessionKeymapState,
  createMuxSessionKeymapState,
  decodeMuxSessionCommand,
  muxSessionDirectShortcutFor,
  muxSessionPrimaryShortcutFor,
  prefixLiteralByte,
  resolveMuxSessionKeydown,
  validateMuxSessionBindings,
  type MuxSessionKeyEvent,
} from "./keybindings.js"

function keyEvent(
  key: string,
  code: string,
  overrides: Partial<MuxSessionKeyEvent> = {},
): MuxSessionKeyEvent {
  return {
    key,
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...overrides,
  }
}

function prefixEvent(overrides: Partial<MuxSessionKeyEvent> = {}): MuxSessionKeyEvent {
  const mac = process.platform === "darwin"
  return keyEvent("k", "KeyK", {
    metaKey: mac,
    ctrlKey: !mac,
    ...overrides,
  })
}

const baseContext = {
  overlayOpen: false,
  inEditable: false,
  inTerminal: true,
  inPrefixButton: false,
  zoomed: false,
}

describe("mux session command boundary", () => {
  it("accepts native menu commands and rejects unknown payloads", () => {
    assert.equal(
      Option.getOrUndefined(decodeMuxSessionCommand("terminal.newTerminal")),
      "terminal.newTerminal",
    )
    assert.equal(
      Option.getOrUndefined(decodeMuxSessionCommand("commandPalette.show")),
      "commandPalette.show",
    )
    assert.equal(
      Option.getOrUndefined(decodeMuxSessionCommand("terminal.deleteEverything")),
      undefined,
    )
    assert.equal(
      Option.getOrUndefined(decodeMuxSessionCommand({ command: "settings.show" })),
      undefined,
    )
  })
})

describe("mux key catalog", () => {
  it("has unique reachable bindings and keeps banned aliases absent", () => {
    assert.deepEqual(validateMuxSessionBindings(), [])
    assert.ok(MUX_SESSION_PREFIX_BINDINGS.length > 0)
    assert.ok(!MUX_SESSION_PREFIX_BINDINGS.some(binding => binding.key === "p"))
    assert.ok(
      !MUX_SESSION_DIRECT_BINDINGS.some(
        binding => binding.key === "Mod-k" || binding.key === "Mod-Shift-p",
      ),
    )
  })

  it("generates primary shortcut labels from descriptor binding ids", () => {
    assert.equal(muxSessionPrimaryShortcutFor("commandPalette.show"), "Mod-k c")
    assert.equal(muxSessionPrimaryShortcutFor("pane.splitRight"), "Mod-d")
    assert.equal(muxSessionPrimaryShortcutFor("settings.show"), "Mod-,")
    assert.equal(muxSessionPrimaryShortcutFor("terminal.jumpLive"), "Mod-k g")
    assert.equal(
      muxSessionPrimaryShortcutFor("terminal.toggleInspectionPause"),
      "Mod-k Shift-G",
    )
  })
})

describe("prefix mux session bindings", () => {
  it("starts, dispatches, and clears the prefix state", () => {
    const state = createMuxSessionKeymapState()
    assert.deepEqual(resolveMuxSessionKeydown(prefixEvent(), state, baseContext, 100), {
      type: "prefix-started",
      prefix: "Mod-k",
    })
    assert.deepEqual(
      resolveMuxSessionKeydown(keyEvent("c", "KeyC"), state, baseContext, 101),
      { type: "command", command: "commandPalette.show" },
    )
    assert.equal(state.prefix, null)
  })

  it("supports terminal position ranges", () => {
    const state = createMuxSessionKeymapState()
    resolveMuxSessionKeydown(prefixEvent(), state, baseContext, 100)
    assert.deepEqual(
      resolveMuxSessionKeydown(keyEvent("3", "Digit3"), state, baseContext, 101),
      { type: "command", command: "terminal.jump", jumpIndex: 2 },
    )
  })

  it("dispatches jump-to-live and inspection pause without key repeat", () => {
    const jump = createMuxSessionKeymapState()
    resolveMuxSessionKeydown(prefixEvent(), jump, baseContext, 100)
    assert.deepEqual(
      resolveMuxSessionKeydown(keyEvent("g", "KeyG"), jump, baseContext, 101),
      { type: "command", command: "terminal.jumpLive" },
    )

    const pause = createMuxSessionKeymapState()
    resolveMuxSessionKeydown(prefixEvent(), pause, baseContext, 100)
    assert.deepEqual(
      resolveMuxSessionKeydown(
        keyEvent("G", "KeyG", { shiftKey: true, repeat: true }),
        pause,
        baseContext,
        101,
      ),
      { type: "consume" },
    )
  })

  it("cancels on Escape and consumes an unknown second key", () => {
    const cancelled = createMuxSessionKeymapState()
    resolveMuxSessionKeydown(prefixEvent(), cancelled, baseContext, 100)
    assert.deepEqual(
      resolveMuxSessionKeydown(keyEvent("Escape", "Escape"), cancelled, baseContext, 101),
      { type: "prefix-cancelled" },
    )

    const unknown = createMuxSessionKeymapState()
    resolveMuxSessionKeydown(prefixEvent(), unknown, baseContext, 100)
    assert.deepEqual(
      resolveMuxSessionKeydown(keyEvent("v", "KeyV"), unknown, baseContext, 101),
      { type: "consume" },
    )
    assert.equal(unknown.prefix, null)
  })

  it("lets a key pass through after the prefix timeout", () => {
    const state = createMuxSessionKeymapState()
    resolveMuxSessionKeydown(prefixEvent(), state, baseContext, 100)
    assert.equal(
      resolveMuxSessionKeydown(keyEvent("c", "KeyC"), state, baseContext, 3_000),
      null,
    )
    assert.equal(state.prefix, null)
  })

  it("sends the prefix literal only from a terminal", () => {
    const terminal = createMuxSessionKeymapState()
    const mac = process.platform === "darwin"
    resolveMuxSessionKeydown(prefixEvent(), terminal, baseContext, 100)
    assert.deepEqual(
      resolveMuxSessionKeydown(
        keyEvent(mac ? "Meta" : "Control", mac ? "MetaLeft" : "ControlLeft", {
          metaKey: mac,
          ctrlKey: !mac,
        }),
        terminal,
        baseContext,
        101,
      ),
      { type: "consume" },
    )
    assert.deepEqual(resolveMuxSessionKeydown(prefixEvent(), terminal, baseContext, 102), {
      type: "prefix-literal",
      byte: "\u000b",
    })
    assert.equal(prefixLiteralByte(), "\u000b")

    const shell = createMuxSessionKeymapState()
    resolveMuxSessionKeydown(prefixEvent(), shell, { ...baseContext, inTerminal: false }, 100)
    assert.deepEqual(
      resolveMuxSessionKeydown(
        prefixEvent(),
        shell,
        { ...baseContext, inTerminal: false },
        101,
      ),
      { type: "prefix-cancelled" },
    )
  })

  it("does not turn a held prefix into a literal", () => {
    const state = createMuxSessionKeymapState()
    resolveMuxSessionKeydown(prefixEvent(), state, baseContext, 100)
    assert.deepEqual(
      resolveMuxSessionKeydown(prefixEvent({ repeat: true }), state, baseContext, 101),
      { type: "consume" },
    )
    assert.equal(state.prefix, "Mod-k")
    clearMuxSessionKeymapState(state)
  })

  it("preserves editable, overlay, composition, and ordinary terminal passthrough", () => {
    for (const context of [
      { ...baseContext, inEditable: true, inTerminal: false },
      { ...baseContext, overlayOpen: true },
      { ...baseContext, inPrefixButton: true },
    ]) {
      assert.equal(
        resolveMuxSessionKeydown(prefixEvent(), createMuxSessionKeymapState(), context),
        null,
      )
    }
    assert.equal(
      resolveMuxSessionKeydown(
        prefixEvent({ isComposing: true }),
        createMuxSessionKeymapState(),
        baseContext,
      ),
      null,
    )
    assert.equal(
      resolveMuxSessionKeydown(
        keyEvent("a", "KeyA"),
        createMuxSessionKeymapState(),
        baseContext,
      ),
      null,
    )
  })
})

describe("direct mux session bindings", () => {
  it("uses the primary modifier plus B only with a vertical sidebar", () => {
    const mac = process.platform === "darwin"
    const event = keyEvent("b", "KeyB", { metaKey: mac, ctrlKey: !mac })
    assert.equal(muxSessionDirectShortcutFor("sidebar.toggle"), "Mod-b")
    assert.deepEqual(
      resolveMuxSessionKeydown(event, createMuxSessionKeymapState(), {
        ...baseContext,
        sidebarLayout: true,
      }),
      { type: "command", command: "sidebar.toggle" },
    )
    assert.equal(
      resolveMuxSessionKeydown(event, createMuxSessionKeymapState(), {
        ...baseContext,
        sidebarLayout: false,
      }),
      null,
    )
  })

  it("suppresses structural key repeat", () => {
    const mac = process.platform === "darwin"
    assert.deepEqual(
      resolveMuxSessionKeydown(
        keyEvent("d", "KeyD", { metaKey: mac, ctrlKey: !mac, repeat: true }),
        createMuxSessionKeymapState(),
        baseContext,
      ),
      { type: "consume" },
    )
  })

  it("uses the primary modifier plus comma to open settings", () => {
    const mac = process.platform === "darwin"
    assert.equal(muxSessionDirectShortcutFor("settings.show"), "Mod-,")
    assert.deepEqual(
      resolveMuxSessionKeydown(
        keyEvent(",", "Comma", { metaKey: mac, ctrlKey: !mac }),
        createMuxSessionKeymapState(),
        baseContext,
      ),
      { type: "command", command: "settings.show" },
    )
  })
})
