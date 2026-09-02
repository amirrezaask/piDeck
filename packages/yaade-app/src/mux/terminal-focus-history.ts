import { Option, Schema } from "effect"

export const TERMINAL_FOCUS_HISTORY_VERSION = 1
export const TERMINAL_FOCUS_HISTORY_STORAGE_KEY = "yaade:terminal-focus-history-v1"
export const MAX_TERMINAL_FOCUS_ENTRIES = 128
export const MAX_TERMINAL_FOCUS_BYTES = 32 * 1024

const ServerId = Schema.String.pipe(
  Schema.maxLength(48),
  Schema.pattern(/^[A-Za-z0-9_-]+$/),
)
const SessionResourceId = Schema.String.pipe(
  Schema.maxLength(256),
  Schema.pattern(/^ses-[A-Za-z0-9_-]+$/),
)
const TabResourceId = Schema.String.pipe(
  Schema.maxLength(256),
  Schema.pattern(/^tab-[A-Za-z0-9_-]+$/),
)
const TerminalResourceId = Schema.String.pipe(
  Schema.maxLength(256),
  Schema.pattern(/^term-[A-Za-z0-9_-]+$/),
)

export const TerminalFocusIdentitySchema = Schema.Struct({
  serverId: ServerId,
  sessionId: SessionResourceId,
  tabId: TabResourceId,
  terminalId: TerminalResourceId,
  generation: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
})
export type TerminalFocusIdentity = Schema.Schema.Type<typeof TerminalFocusIdentitySchema>

export const TerminalFocusHistoryProfileSchema = Schema.Struct({
  version: Schema.Literal(TERMINAL_FOCUS_HISTORY_VERSION),
  entries: Schema.Array(TerminalFocusIdentitySchema),
})
export type TerminalFocusHistoryProfile = Schema.Schema.Type<
  typeof TerminalFocusHistoryProfileSchema
>

const HistoryJsonSchema = Schema.parseJson(TerminalFocusHistoryProfileSchema)
const VersionProbeJsonSchema = Schema.parseJson(Schema.Struct({ version: Schema.Number }))
const decodeHistoryOption = Schema.decodeUnknownOption(HistoryJsonSchema)
const decodeVersionProbeOption = Schema.decodeUnknownOption(VersionProbeJsonSchema)

export type TerminalFocusHistoryDiagnostic =
  | "absent"
  | "corrupt"
  | "oversized"
  | "newer-version"
  | "storage-denied"

export type TerminalFocusHistoryLoadResult = {
  readonly history: TerminalFocusHistory
  readonly diagnostic?: TerminalFocusHistoryDiagnostic
}

export function terminalFocusIdentityKey(identity: TerminalFocusIdentity): string {
  return [
    identity.serverId,
    identity.sessionId,
    identity.tabId,
    identity.terminalId,
    identity.generation,
  ].join("\u001f")
}

function profileBytes(entries: readonly TerminalFocusIdentity[]): number {
  return new TextEncoder().encode(JSON.stringify({
    version: TERMINAL_FOCUS_HISTORY_VERSION,
    entries,
  })).byteLength
}

/** Bounded, content-free navigation history. Input order supplies stable fallback order. */
export class TerminalFocusHistory {
  private entries: TerminalFocusIdentity[]

  constructor(entries: readonly TerminalFocusIdentity[] = []) {
    this.entries = []
    for (const identity of [...entries].reverse()) this.recordFocus(identity)
  }

  recordFocus(identity: TerminalFocusIdentity): boolean {
    const key = terminalFocusIdentityKey(identity)
    const next = [identity, ...this.entries.filter(item => terminalFocusIdentityKey(item) !== key)]
    while (
      next.length > MAX_TERMINAL_FOCUS_ENTRIES ||
      profileBytes(next) > MAX_TERMINAL_FOCUS_BYTES
    ) {
      next.pop()
    }
    if (
      next.length === this.entries.length &&
      next.every((item, index) => terminalFocusIdentityKey(item) === terminalFocusIdentityKey(this.entries[index]!))
    ) {
      return false
    }
    this.entries = next
    return true
  }

  previous(
    current: TerminalFocusIdentity | null,
    available: readonly TerminalFocusIdentity[],
  ): TerminalFocusIdentity | null {
    const currentKey = current ? terminalFocusIdentityKey(current) : null
    const ranked = this.rank(available)
    return ranked.find(identity => terminalFocusIdentityKey(identity) !== currentKey) ?? null
  }

  rank(available: readonly TerminalFocusIdentity[]): readonly TerminalFocusIdentity[] {
    const availableByKey = new Map(available.map(identity => [terminalFocusIdentityKey(identity), identity]))
    const ranked: TerminalFocusIdentity[] = []
    const used = new Set<string>()
    for (const saved of this.entries) {
      const key = terminalFocusIdentityKey(saved)
      const current = availableByKey.get(key)
      if (!current || used.has(key)) continue
      ranked.push(current)
      used.add(key)
    }
    for (const identity of available) {
      const key = terminalFocusIdentityKey(identity)
      if (used.has(key)) continue
      ranked.push(identity)
      used.add(key)
    }
    return ranked
  }

  prune(available: readonly TerminalFocusIdentity[]): boolean {
    const keys = new Set(available.map(terminalFocusIdentityKey))
    const next = this.entries.filter(identity => keys.has(terminalFocusIdentityKey(identity)))
    if (next.length === this.entries.length) return false
    this.entries = next
    return true
  }

  has(identity: TerminalFocusIdentity): boolean {
    const key = terminalFocusIdentityKey(identity)
    return this.entries.some(item => terminalFocusIdentityKey(item) === key)
  }

  toProfile(): TerminalFocusHistoryProfile {
    return {
      version: TERMINAL_FOCUS_HISTORY_VERSION,
      entries: [...this.entries],
    }
  }
}

export function decodeTerminalFocusHistory(
  raw: string | null,
): TerminalFocusHistoryLoadResult {
  if (raw === null) return { history: new TerminalFocusHistory(), diagnostic: "absent" }
  if (new TextEncoder().encode(raw).byteLength > MAX_TERMINAL_FOCUS_BYTES) {
    return { history: new TerminalFocusHistory(), diagnostic: "oversized" }
  }
  const decoded = decodeHistoryOption(raw)
  if (Option.isSome(decoded) && decoded.value.entries.length <= MAX_TERMINAL_FOCUS_ENTRIES) {
    return { history: new TerminalFocusHistory(decoded.value.entries) }
  }
  const version = decodeVersionProbeOption(raw)
  return {
    history: new TerminalFocusHistory(),
    diagnostic:
      Option.isSome(version) && version.value.version > TERMINAL_FOCUS_HISTORY_VERSION
        ? "newer-version"
        : "corrupt",
  }
}

export function loadTerminalFocusHistory(
  storage?: Pick<Storage, "getItem"> | null,
): TerminalFocusHistoryLoadResult {
  try {
    const target = storage === undefined ? globalThis.sessionStorage : storage
    if (!target) {
      return { history: new TerminalFocusHistory(), diagnostic: "storage-denied" }
    }
    return decodeTerminalFocusHistory(target.getItem(TERMINAL_FOCUS_HISTORY_STORAGE_KEY))
  } catch {
    return { history: new TerminalFocusHistory(), diagnostic: "storage-denied" }
  }
}

export function saveTerminalFocusHistory(
  history: TerminalFocusHistory,
  storage?: Pick<Storage, "setItem"> | null,
): boolean {
  try {
    const target = storage === undefined ? globalThis.sessionStorage : storage
    if (!target) return false
    target.setItem(TERMINAL_FOCUS_HISTORY_STORAGE_KEY, JSON.stringify(history.toProfile()))
    return true
  } catch {
    return false
  }
}
