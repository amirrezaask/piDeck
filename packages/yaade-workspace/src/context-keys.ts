export type KeyEventLike = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>

const MODIFIERS = new Set(["Mod", "Cmd", "Ctrl", "Alt", "Shift"])

export type ParsedKeyPart = {
  modifiers: Set<string>
  key: string
}

/** Primary chord modifier: ⌘ on Apple, Ctrl elsewhere. */
export function isMacPlatform(): boolean {
  if (typeof navigator !== "undefined" && navigator.platform) {
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  }
  const proc =
    typeof globalThis !== "undefined"
      ? (globalThis as { process?: { platform?: string } }).process
      : undefined
  return proc?.platform === "darwin"
}

export function parseKeyPart(part: string): ParsedKeyPart {
  const segments = part.split("-").filter(Boolean)
  const modifiers = new Set<string>()
  let key = ""
  for (const segment of segments) {
    if (MODIFIERS.has(segment)) modifiers.add(segment)
    else key = segment
  }
  if (!key && part.endsWith("-")) key = "-"
  return { modifiers, key }
}

export function parseBindingKey(key: string): string[] {
  return key.trim().split(/\s+/).filter(Boolean)
}

function normalizeBindingKey(key: string): string {
  if (key === "Backquote") return "`"
  return key.length === 1 ? key.toLowerCase() : key
}

function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]!.toLowerCase()
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]!
  switch (code) {
    case "Backquote":
      return "`"
    case "Minus":
      return "-"
    case "Equal":
      return "="
    case "BracketLeft":
      return "["
    case "BracketRight":
      return "]"
    case "Backslash":
      return "\\"
    case "Semicolon":
      return ";"
    case "Quote":
      return "'"
    case "Comma":
      return ","
    case "Period":
      return "."
    case "Slash":
      return "/"
    default:
      return null
  }
}

function eventKeyMatches(expected: string, e: KeyEventLike): boolean {
  const want = normalizeBindingKey(expected)
  const fromKey = normalizeBindingKey(e.key)
  if (fromKey === want) return true
  const fromCode = e.code ? keyFromCode(e.code) : null
  if (fromCode != null && normalizeBindingKey(fromCode) === want) return true
  return false
}

export function keyEventMatchesBindingPart(
  e: KeyEventLike,
  part: string,
): boolean {
  const { modifiers, key } = parseKeyPart(part)
  const needsShift = modifiers.has("Shift")
  const needsAlt = modifiers.has("Alt")
  const needsMod = modifiers.has("Mod")
  const needsCmd = modifiers.has("Cmd")
  const needsCtrl = modifiers.has("Ctrl")

  if (needsShift !== e.shiftKey) return false
  if (needsAlt !== e.altKey) return false

  const hasMeta = e.metaKey
  const hasCtrl = e.ctrlKey
  const mac = isMacPlatform()

  // Mod = platform primary (⌘ mac / Ctrl elsewhere). Cmd always means meta.
  let wantMeta = needsCmd
  let wantCtrl = needsCtrl
  if (needsMod) {
    if (mac) wantMeta = true
    else wantCtrl = true
  }

  if (wantMeta && wantCtrl) {
    if (!hasMeta || !hasCtrl) return false
  } else if (wantMeta) {
    if (!hasMeta) return false
  } else if (wantCtrl) {
    if (!hasCtrl || hasMeta) return false
  } else {
    if (hasMeta || hasCtrl) return false
  }

  return eventKeyMatches(key, e)
}

export function keyEventMatchesBinding(e: KeyEventLike, key: string): boolean {
  const parts = parseBindingKey(key)
  if (parts.length !== 1) return false
  return keyEventMatchesBindingPart(e, parts[0]!)
}

export type ChordState = {
  prefix: string | null
  expiresAt: number
}

/**
 * Long enough for a prefix key to double as a menu (the which-key panel is
 * visible for this window), short enough that a stray prefix press does not
 * leave the shell swallowing input.
 */
export const CHORD_TIMEOUT_MS = 2500

export function createChordState(): ChordState {
  return { prefix: null, expiresAt: 0 }
}

export function chordIsActive(state: ChordState, now = Date.now()): boolean {
  return state.prefix != null && now < state.expiresAt
}

export function startChord(state: ChordState, prefix: string, now = Date.now()): void {
  state.prefix = prefix
  state.expiresAt = now + CHORD_TIMEOUT_MS
}

export function clearChord(state: ChordState): void {
  state.prefix = null
  state.expiresAt = 0
}
