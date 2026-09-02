import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import {
  MAX_TERMINAL_FOCUS_BYTES,
  MAX_TERMINAL_FOCUS_ENTRIES,
  TERMINAL_FOCUS_HISTORY_STORAGE_KEY,
  TerminalFocusHistory,
  decodeTerminalFocusHistory,
  loadTerminalFocusHistory,
  saveTerminalFocusHistory,
  type TerminalFocusIdentity,
} from "./terminal-focus-history.js"

function identity(
  terminal: string,
  options: {
    readonly serverId?: string
    readonly session?: string
    readonly tab?: string
    readonly generation?: number
  } = {},
): TerminalFocusIdentity {
  return {
    serverId: options.serverId ?? "current-host",
    sessionId: `ses-${options.session ?? "one"}`,
    tabId: `tab-${options.tab ?? "one"}`,
    terminalId: `term-${terminal}`,
    generation: options.generation ?? 1,
  }
}

class MemoryStorage {
  private value: string | null = null

  getItem(key: string): string | null {
    return key === TERMINAL_FOCUS_HISTORY_STORAGE_KEY ? this.value : null
  }

  setItem(key: string, value: string): void {
    if (key === TERMINAL_FOCUS_HISTORY_STORAGE_KEY) this.value = value
  }
}

class DeniedStorage {
  getItem(): string | null {
    throw new Error("denied")
  }

  setItem(): void {
    throw new Error("denied")
  }
}

describe("TerminalFocusHistory", () => {
  it("records, de-duplicates, ranks, and toggles the previous terminal", () => {
    const history = new TerminalFocusHistory()
    const a = identity("a")
    const b = identity("b")
    const c = identity("c")
    history.recordFocus(a)
    history.recordFocus(b)
    history.recordFocus(b)
    assert.deepEqual(history.rank([a, b, c]), [b, a, c])
    assert.deepEqual(history.previous(b, [a, b, c]), a)

    history.recordFocus(a)
    assert.deepEqual(history.previous(a, [a, b, c]), b)
    history.recordFocus(b)
    assert.deepEqual(history.previous(b, [a, b, c]), a)
  })

  it("qualifies duplicate local IDs by server, Session, Window, and generation", () => {
    const history = new TerminalFocusHistory()
    const local = identity("same", { serverId: "local", session: "same", tab: "same" })
    const remote = identity("same", { serverId: "remote", session: "same", tab: "same" })
    const restarted = identity("same", {
      serverId: "remote",
      session: "same",
      tab: "same",
      generation: 2,
    })
    history.recordFocus(local)
    history.recordFocus(remote)
    assert.deepEqual(history.rank([local, remote]), [remote, local])
    history.prune([local, restarted])
    assert.deepEqual(history.rank([local, restarted]), [local, restarted])
  })

  it("prunes closed, archived, missing, host-removed, and generation-stale entries", () => {
    const history = new TerminalFocusHistory([
      identity("a", { serverId: "local" }),
      identity("b", { serverId: "remote" }),
      identity("c", { generation: 1 }),
    ])
    const available = [identity("a", { serverId: "local" }), identity("c", { generation: 2 })]
    assert.equal(history.prune(available), true)
    assert.deepEqual(history.toProfile().entries, [available[0]])
  })

  it("enforces count and encoded-byte caps", () => {
    const history = new TerminalFocusHistory()
    for (let index = 0; index < 500; index += 1) {
      const suffix = `${"x".repeat(210)}${index}`
      history.recordFocus(identity(suffix, { session: suffix, tab: suffix }))
    }
    const profile = history.toProfile()
    assert.ok(profile.entries.length <= MAX_TERMINAL_FOCUS_ENTRIES)
    assert.ok(new TextEncoder().encode(JSON.stringify(profile)).byteLength <= MAX_TERMINAL_FOCUS_BYTES)
    assert.equal(profile.entries[0]?.terminalId.endsWith("499"), true)
  })
})

describe("terminal focus history persistence", () => {
  it("round-trips session-local identities across reload", () => {
    const storage = new MemoryStorage()
    const history = new TerminalFocusHistory([identity("a"), identity("b")])
    assert.equal(saveTerminalFocusHistory(history, storage), true)
    const loaded = loadTerminalFocusHistory(storage)
    assert.equal(loaded.diagnostic, undefined)
    assert.deepEqual(loaded.history.toProfile(), history.toProfile())
  })

  it("falls back for absent, corrupt, oversized, newer, and denied storage", () => {
    assert.equal(decodeTerminalFocusHistory(null).diagnostic, "absent")
    assert.equal(decodeTerminalFocusHistory("nope").diagnostic, "corrupt")
    assert.equal(
      decodeTerminalFocusHistory(JSON.stringify({ version: 2, entries: [] })).diagnostic,
      "newer-version",
    )
    assert.equal(
      decodeTerminalFocusHistory(" ".repeat(MAX_TERMINAL_FOCUS_BYTES + 1)).diagnostic,
      "oversized",
    )
    assert.equal(loadTerminalFocusHistory(new DeniedStorage()).diagnostic, "storage-denied")
    assert.equal(saveTerminalFocusHistory(new TerminalFocusHistory(), new DeniedStorage()), false)
  })

  it("retains valid identity order across an unrelated server epoch change", () => {
    const saved = new TerminalFocusHistory([identity("a", { serverId: "stable-host" })])
    const decoded = decodeTerminalFocusHistory(JSON.stringify(saved.toProfile())).history
    const available = [identity("a", { serverId: "stable-host" }), identity("b")]
    assert.deepEqual(decoded.rank(available), available)
  })
})
