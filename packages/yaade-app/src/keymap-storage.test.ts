import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { DEFAULT_KEYMAP_CATALOG } from "./keybindings.js"
import {
  DEFAULT_KEYMAP_PROFILE,
  MAX_KEYMAP_JSON_BYTES,
  type KeymapProfile,
} from "./keymap-profile.js"
import {
  KEYMAP_STORAGE_KEY,
  decodeStoredKeymapJson,
  loadKeymapSettings,
  persistKeymapSettings,
  shouldApplyStoredKeymap,
  type KeymapStorage,
} from "./keymap-storage.js"

class MemoryStorage implements KeymapStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const conflictedProfile: KeymapProfile = {
  version: 1,
  leader: "Mod-k",
  bindings: [
    {
      command: "commandPalette.show",
      binding: null,
      context: "global",
    },
  ],
}

describe("keymap persistence", () => {
  it("falls back deterministically for absent and corrupt storage", () => {
    const empty = loadKeymapSettings(new MemoryStorage(), DEFAULT_KEYMAP_CATALOG, "linux")
    assert.deepEqual(empty.profile, DEFAULT_KEYMAP_PROFILE)
    assert.equal(empty.diagnostic, undefined)

    const corrupt = new MemoryStorage()
    corrupt.setItem(KEYMAP_STORAGE_KEY, "{")
    const loaded = loadKeymapSettings(corrupt, DEFAULT_KEYMAP_CATALOG, "linux")
    assert.equal(loaded.diagnostic, "invalid-storage")
    assert.deepEqual(loaded.profile, DEFAULT_KEYMAP_PROFILE)
  })

  it("diagnoses oversized, newer, and conflicting stored profiles", () => {
    assert.deepEqual(decodeStoredKeymapJson("x".repeat(MAX_KEYMAP_JSON_BYTES + 1)), {
      ok: false,
      diagnostic: "oversized",
    })
    assert.deepEqual(
      decodeStoredKeymapJson(
        '{"revision":2,"profile":{"version":2,"leader":"Mod-k","bindings":[]}}',
      ),
      { ok: false, diagnostic: "newer-version" },
    )

    const storage = new MemoryStorage()
    storage.setItem(
      KEYMAP_STORAGE_KEY,
      JSON.stringify({ revision: 4, profile: conflictedProfile }),
    )
    const loaded = loadKeymapSettings(storage, DEFAULT_KEYMAP_CATALOG, "linux")
    assert.equal(loaded.diagnostic, "compile-conflict")
    assert.equal(loaded.revision, 0)
  })

  it("handles denied reads and writes without failing startup", () => {
    const denied: KeymapStorage = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
    }
    assert.equal(
      loadKeymapSettings(denied, DEFAULT_KEYMAP_CATALOG, "mac").diagnostic,
      "storage-denied",
    )
    assert.deepEqual(
      persistKeymapSettings(denied, DEFAULT_KEYMAP_PROFILE, 0, 10),
      { ok: false, diagnostic: "storage-denied" },
    )
  })

  it("persists bounded data with monotonic revisions", () => {
    const storage = new MemoryStorage()
    const first = persistKeymapSettings(storage, DEFAULT_KEYMAP_PROFILE, 12, 5)
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.revision, 13)
    const decoded = decodeStoredKeymapJson(storage.getItem(KEYMAP_STORAGE_KEY) ?? "")
    assert.equal(decoded.ok, true)
    if (decoded.ok) assert.equal(decoded.stored.revision, 13)
  })

  it("applies only a newer cross-tab revision", () => {
    const incoming = { revision: 8, profile: DEFAULT_KEYMAP_PROFILE }
    assert.equal(shouldApplyStoredKeymap(7, incoming), true)
    assert.equal(shouldApplyStoredKeymap(8, incoming), false)
    assert.equal(shouldApplyStoredKeymap(9, incoming), false)
  })
})
