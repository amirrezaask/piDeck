import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { installEffectiveKeymap, resetEffectiveKeymap } from "./effective-keymap.js"
import {
  DEFAULT_KEYMAP_CATALOG,
  createMuxSessionKeymapState,
  muxSessionPrimaryShortcutFor,
  resolveMuxSessionKeydown,
  type MuxSessionKeyEvent,
} from "./keybindings.js"
import {
  DEFAULT_KEYMAP_PROFILE,
  MAX_KEYMAP_BINDINGS,
  bindingFromKeyboardEvent,
  classifyKeyBinding,
  compileKeymap,
  decodeKeymapProfileJson,
  encodeKeymapProfileJson,
  keymapPlatform,
  normalizeKeyChord,
  normalizeKeySequence,
  type KeymapOverride,
  type KeymapProfile,
} from "./keymap-profile.js"

function profile(
  bindings: readonly KeymapOverride[],
  leader = "Mod-k",
): KeymapProfile {
  return { version: 1, leader, bindings: [...bindings] }
}

function override(
  command: KeymapOverride["command"],
  binding: string | null,
  confirmedRisky?: boolean,
): KeymapOverride {
  return confirmedRisky === undefined
    ? { command, binding, context: "global" }
    : { command, binding, context: "global", confirmedRisky }
}

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

const terminalContext = {
  overlayOpen: false,
  inEditable: false,
  inTerminal: true,
  inPrefixButton: false,
  zoomed: false,
}

describe("keymap grammar and policy", () => {
  it("normalizes aliases, modifier order, leader sequences, and platforms", () => {
    assert.equal(normalizeKeyChord("shift-mod-G"), "Mod-Shift-g")
    assert.equal(normalizeKeyChord("meta-,"), "Cmd-,")
    assert.equal(normalizeKeyChord("Mod--"), "Mod--")
    assert.equal(normalizeKeySequence("leader Shift-g"), "Leader Shift-G")
    assert.equal(normalizeKeySequence("Leader Escape"), null)
    assert.equal(normalizeKeyChord("Mod-Ctrl-k"), null)
    assert.equal(keymapPlatform("MacIntel"), "mac")
    assert.equal(keymapPlatform("Win32"), "windows")
    assert.equal(keymapPlatform("X11", "linux"), "linux")
  })

  it("captures physical platform modifiers without executable input", () => {
    assert.equal(
      bindingFromKeyboardEvent(
        { key: "g", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
        "mac",
      ),
      "Mod-g",
    )
    assert.equal(
      bindingFromKeyboardEvent(
        { key: "G", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        "linux",
      ),
      "Mod-Shift-g",
    )
  })

  it("classifies terminal, widget, browser, OS, and removed bindings", () => {
    assert.equal(classifyKeyBinding("g", "direct", "mac").risk, "terminal-reserved")
    assert.equal(classifyKeyBinding("Escape", "direct", "mac").risk, "widget-local")
    assert.equal(classifyKeyBinding("Mod-x", "direct", "mac").risk, "browser-risky")
    assert.equal(classifyKeyBinding("Mod-l", "direct", "mac").risk, "os-unavailable")
    assert.equal(classifyKeyBinding("Mod-k", "direct", "mac").risk, "banned")
    assert.equal(classifyKeyBinding("p", "prefix", "mac").risk, "banned")
    assert.equal(classifyKeyBinding("Ctrl-b", "leader", "mac").risk, "safe")
  })
})

describe("keymap compiler", () => {
  it("compiles immutable defaults and a custom leader atomically", () => {
    const defaults = compileKeymap(DEFAULT_KEYMAP_CATALOG, DEFAULT_KEYMAP_PROFILE, "mac")
    assert.equal(defaults.ok, true)
    if (!defaults.ok) return
    assert.equal(defaults.keymap.leader, "Mod-k")
    assert.equal(muxSessionPrimaryShortcutFor("commandPalette.show", defaults.keymap), "Mod-k c")

    const custom = compileKeymap(
      DEFAULT_KEYMAP_CATALOG,
      profile([override("commandPalette.show", "Leader o")], "Ctrl-b"),
      "mac",
    )
    assert.equal(custom.ok, true)
    if (!custom.ok) return
    assert.equal(custom.keymap.leader, "Ctrl-b")
    assert.equal(muxSessionPrimaryShortcutFor("commandPalette.show", custom.keymap), "Ctrl-b o")
    assert.equal(DEFAULT_KEYMAP_CATALOG.leader, "Mod-k")
  })

  it("atomically feeds shortcut labels from one installed snapshot", () => {
    const compiled = compileKeymap(
      DEFAULT_KEYMAP_CATALOG,
      profile([override("commandPalette.show", "Leader o")], "Ctrl-b"),
      "mac",
    )
    assert.equal(compiled.ok, true)
    if (!compiled.ok) return
    try {
      installEffectiveKeymap(compiled.keymap)
      assert.equal(muxSessionPrimaryShortcutFor("commandPalette.show"), "Ctrl-b o")
    } finally {
      resetEffectiveKeymap()
    }
    assert.equal(muxSessionPrimaryShortcutFor("commandPalette.show"), "Mod-k c")
  })

  it("dispatches only the effective leader and sends its literal exactly", () => {
    const compiled = compileKeymap(
      DEFAULT_KEYMAP_CATALOG,
      profile([override("commandPalette.show", "Leader o")], "Ctrl-b"),
      "mac",
    )
    assert.equal(compiled.ok, true)
    if (!compiled.ok) return
    const state = createMuxSessionKeymapState()
    assert.deepEqual(
      resolveMuxSessionKeydown(
        keyEvent("b", "KeyB", { ctrlKey: true }),
        state,
        terminalContext,
        100,
        compiled.keymap,
      ),
      { type: "prefix-started", prefix: "Ctrl-b" },
    )
    assert.deepEqual(
      resolveMuxSessionKeydown(
        keyEvent("o", "KeyO"),
        state,
        terminalContext,
        101,
        compiled.keymap,
      ),
      { type: "command", command: "commandPalette.show" },
    )

    resolveMuxSessionKeydown(
      keyEvent("b", "KeyB", { ctrlKey: true }),
      state,
      terminalContext,
      102,
      compiled.keymap,
    )
    assert.deepEqual(
      resolveMuxSessionKeydown(
        keyEvent("b", "KeyB", { ctrlKey: true }),
        state,
        terminalContext,
        103,
        compiled.keymap,
      ),
      { type: "prefix-literal", byte: "\u0002" },
    )
  })

  it("reports duplicates, leader ambiguity, limits, and dynamic ranges", () => {
    const duplicate = compileKeymap(
      DEFAULT_KEYMAP_CATALOG,
      profile([
        override("session.new", "Leader y"),
        override("tab.new", "Leader y"),
      ]),
      "linux",
    )
    assert.equal(duplicate.ok, false)
    if (!duplicate.ok) {
      assert.ok(duplicate.conflicts.some(item => item.code === "duplicate-binding"))
    }

    const ambiguous = compileKeymap(
      DEFAULT_KEYMAP_CATALOG,
      profile([override("session.new", "Ctrl-b", true)], "Ctrl-b"),
      "linux",
    )
    assert.equal(ambiguous.ok, false)
    if (!ambiguous.ok) {
      assert.ok(ambiguous.conflicts.some(item => item.code === "prefix-ambiguity"))
    }

    const tooMany = compileKeymap(
      DEFAULT_KEYMAP_CATALOG,
      profile(Array.from({ length: MAX_KEYMAP_BINDINGS + 1 }, () =>
        override("session.new", null))),
      "linux",
    )
    assert.equal(tooMany.ok, false)
    if (!tooMany.ok) {
      assert.ok(tooMany.conflicts.some(item => item.code === "binding-limit"))
    }

    const range = compileKeymap(
      DEFAULT_KEYMAP_CATALOG,
      profile([override("terminal.jump", "Leader j")]),
      "linux",
    )
    assert.equal(range.ok, false)
    if (!range.ok) {
      assert.ok(range.conflicts.some(item => item.code === "unsupported-dynamic-command"))
    }

    const recovery = compileKeymap(
      DEFAULT_KEYMAP_CATALOG,
      profile([override("settings.show", "Leader z")]),
      "mac",
    )
    assert.equal(recovery.ok, false)
    if (!recovery.ok) {
      assert.ok(recovery.conflicts.some(item => item.code === "immutable-recovery-binding"))
    }
  })

  it("requires risky confirmation and rejects unavailable or removed chords", () => {
    const risky = compileKeymap(
      DEFAULT_KEYMAP_CATALOG,
      profile([override("session.new", "Mod-x")]),
      "mac",
    )
    assert.equal(risky.ok, false)
    if (!risky.ok) {
      assert.ok(risky.conflicts.some(item => item.code === "risky-confirmation-required"))
    }
    assert.equal(
      compileKeymap(
        DEFAULT_KEYMAP_CATALOG,
        profile([override("session.new", "Mod-x", true)]),
        "mac",
      ).ok,
      true,
    )
    for (const binding of ["Mod-l", "Mod-k", "Mod-Shift-p", "Ctrl-c", "Escape"]) {
      const result = compileKeymap(
        DEFAULT_KEYMAP_CATALOG,
        profile([override("session.new", binding, true)]),
        "mac",
      )
      assert.equal(result.ok, false, binding)
      if (!result.ok) {
        assert.ok(result.conflicts.some(item => item.code === "reserved-binding"), binding)
      }
    }
  })

  it("preserves keyboard recovery paths", () => {
    for (const command of ["commandPalette.show", "settings.show", "keymap.reset"] as const) {
      const result = compileKeymap(
        DEFAULT_KEYMAP_CATALOG,
        profile([override(command, null)]),
        "linux",
      )
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.ok(result.conflicts.some(item => item.code === "required-command-unreachable"))
      }
    }
  })
})

describe("keymap profile codec", () => {
  it("round-trips bounded data and rejects unknown command IDs", () => {
    const source = profile([override("session.new", "Leader y")], "Ctrl-b")
    assert.deepEqual(decodeKeymapProfileJson(encodeKeymapProfileJson(source)), {
      ok: true,
      profile: source,
    })
    assert.deepEqual(
      decodeKeymapProfileJson(
        '{"version":1,"leader":"Mod-k","bindings":[{"command":"shell.exec","binding":"Leader x","context":"global"}]}',
      ),
      { ok: false, diagnostic: "invalid" },
    )
  })

  it("diagnoses missing, malformed, oversized, and newer data", () => {
    assert.deepEqual(decodeKeymapProfileJson(null), { ok: false, diagnostic: "empty" })
    assert.deepEqual(decodeKeymapProfileJson("{"), { ok: false, diagnostic: "invalid" })
    assert.deepEqual(
      decodeKeymapProfileJson('{"version":2,"leader":"Mod-k","bindings":[]}'),
      { ok: false, diagnostic: "newer-version" },
    )
    assert.deepEqual(
      decodeKeymapProfileJson(" ".repeat(32 * 1024 + 1)),
      { ok: false, diagnostic: "oversized" },
    )
  })
})
