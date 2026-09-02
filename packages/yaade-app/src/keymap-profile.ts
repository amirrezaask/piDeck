/**
 * Keymap profile v1 grammar:
 * - Chords use `Mod|Cmd|Ctrl|Alt|Shift` plus one printable/named key.
 * - `Mod` is the platform primary modifier; `Cmd` is literal Meta.
 * - Prefix overrides use `Leader <key>` and direct overrides use one chord.
 * - Prefix keys are printable with optional Shift; direct plain/Alt/explicit-Ctrl
 *   chords remain PTY-owned. Escape and navigation keys remain widget-local.
 * - Browser-risky chords require persisted confirmation; OS-unavailable and
 *   removed aliases are rejected. A profile is applied only as one whole value.
 */
import { Option, Schema } from "effect"
import { COMMAND_IDS, commandDescriptor, type CommandId } from "./commands/catalog.js"
import type {
  MuxSessionContextBinding,
  MuxSessionDirectBinding,
  MuxSessionPrefixBinding,
  MuxSessionPrefixGroupId,
} from "./keybindings.js"

export const KEYMAP_PROFILE_VERSION = 1
export const MAX_KEYMAP_BINDINGS = 128
export const MAX_KEYMAP_JSON_BYTES = 32 * 1024
export const MAX_KEY_BINDING_LENGTH = 64

export type KeymapPlatform = "mac" | "windows" | "linux"
export type KeymapBindingContext = "global"

export const KeymapOverrideSchema = Schema.Struct({
  command: Schema.Literal(...COMMAND_IDS),
  binding: Schema.NullOr(Schema.String),
  context: Schema.Literal("global"),
  confirmedRisky: Schema.optional(Schema.Boolean),
})
export type KeymapOverride = Schema.Schema.Type<typeof KeymapOverrideSchema>

export const KeymapProfileSchema = Schema.Struct({
  version: Schema.Literal(KEYMAP_PROFILE_VERSION),
  leader: Schema.String,
  bindings: Schema.Array(KeymapOverrideSchema),
  confirmedLeaderRisky: Schema.optional(Schema.Boolean),
})
export type KeymapProfile = Schema.Schema.Type<typeof KeymapProfileSchema>

const KeymapProfileJsonSchema = Schema.parseJson(KeymapProfileSchema)
const VersionProbeJsonSchema = Schema.parseJson(Schema.Struct({ version: Schema.Number }))
const decodeKeymapProfileOption = Schema.decodeUnknownOption(KeymapProfileJsonSchema)
const decodeVersionProbeOption = Schema.decodeUnknownOption(VersionProbeJsonSchema)

export const DEFAULT_KEYMAP_PROFILE: KeymapProfile = {
  version: KEYMAP_PROFILE_VERSION,
  leader: "Mod-k",
  bindings: [],
}

export type KeymapDefaultCatalog = {
  readonly leader: string
  readonly prefixBindings: readonly MuxSessionPrefixBinding[]
  readonly directBindings: readonly MuxSessionDirectBinding[]
  readonly contextBindings: readonly MuxSessionContextBinding[]
}

export type EffectiveKeymap = KeymapDefaultCatalog & {
  readonly source: KeymapProfile
}

export type KeymapRisk =
  | "safe"
  | "browser-risky"
  | "terminal-reserved"
  | "widget-local"
  | "os-unavailable"
  | "banned"

export type KeymapRiskClassification = {
  readonly risk: KeymapRisk
  readonly reason?: string
}

type NormalizedChordParts = {
  readonly modifiers: readonly string[]
  readonly key: string
}

export type KeymapConflictCode =
  | "binding-limit"
  | "binding-too-long"
  | "invalid-leader"
  | "invalid-binding"
  | "immutable-recovery-binding"
  | "duplicate-command"
  | "duplicate-binding"
  | "prefix-ambiguity"
  | "reserved-binding"
  | "risky-confirmation-required"
  | "required-command-unreachable"
  | "unsupported-dynamic-command"

export type KeymapConflict = {
  readonly code: KeymapConflictCode
  readonly message: string
  readonly command?: CommandId
  readonly binding?: string
  readonly risk?: KeymapRisk
}

export type CompileKeymapResult =
  | { readonly ok: true; readonly keymap: EffectiveKeymap }
  | { readonly ok: false; readonly conflicts: readonly KeymapConflict[] }

export type DecodeKeymapProfileResult =
  | { readonly ok: true; readonly profile: KeymapProfile }
  | {
      readonly ok: false
      readonly diagnostic: "empty" | "oversized" | "invalid" | "newer-version"
    }

const MODIFIER_ORDER = ["Mod", "Cmd", "Ctrl", "Alt", "Shift"] as const
const MODIFIER_NAMES = new Map(
  MODIFIER_ORDER.flatMap(modifier => [
    [modifier.toLowerCase(), modifier],
    [modifier === "Cmd" ? "meta" : modifier.toLowerCase(), modifier],
  ]),
)
const NAMED_KEYS = new Map<string, string>([
  ["esc", "Escape"],
  ["escape", "Escape"],
  ["enter", "Enter"],
  ["return", "Enter"],
  ["space", "Space"],
  ["tab", "Tab"],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["home", "Home"],
  ["end", "End"],
  ["arrowup", "ArrowUp"],
  ["arrowdown", "ArrowDown"],
  ["arrowleft", "ArrowLeft"],
  ["arrowright", "ArrowRight"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
])
const WIDGET_LOCAL_KEYS = new Set([
  "Escape",
  "Enter",
  "Space",
  "Tab",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
])
const PRIMARY_UNAVAILABLE_KEYS = new Set([
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "=",
  "-",
  "f",
  "l",
  "n",
  "p",
  "q",
  "r",
  "t",
  "w",
])

function normalizedKey(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 1 && trimmed !== " ") return trimmed.toLowerCase()
  const named = NAMED_KEYS.get(trimmed.toLowerCase())
  if (named) return named
  if (/^f(?:[1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase()
  return null
}

export function normalizeKeyChord(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_KEY_BINDING_LENGTH || /\s/.test(trimmed)) return null
  const rawSegments = trimmed.split("-")
  const rawKey = trimmed.endsWith("-") ? "-" : rawSegments.pop()
  const modifierSegments = trimmed.endsWith("-")
    ? rawSegments.filter(segment => segment.length > 0)
    : rawSegments
  if (!rawKey) return null
  const modifiers = new Set<string>()
  for (const rawModifier of modifierSegments) {
    const modifier = MODIFIER_NAMES.get(rawModifier.toLowerCase())
    if (!modifier || modifiers.has(modifier)) return null
    modifiers.add(modifier)
  }
  if (modifiers.has("Mod") && (modifiers.has("Cmd") || modifiers.has("Ctrl"))) return null
  const key = normalizedKey(rawKey)
  if (!key) return null
  const prefix = MODIFIER_ORDER.filter(modifier => modifiers.has(modifier))
  return [...prefix, key].join("-")
}

function normalizePrefixKey(value: string): string | null {
  const chord = normalizeKeyChord(value)
  if (!chord) return null
  const segments = chord.split("-")
  const key = segments.at(-1)
  const modifiers = segments.slice(0, -1)
  if (!key || modifiers.some(modifier => modifier !== "Shift")) return null
  if (WIDGET_LOCAL_KEYS.has(key) || key.length !== 1) return null
  return modifiers.length === 0 ? key : `Shift-${key.toUpperCase()}`
}

export function normalizeKeySequence(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_KEY_BINDING_LENGTH) return null
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) return normalizeKeyChord(parts[0]!)
  if (parts.length !== 2 || parts[0]!.toLowerCase() !== "leader") return null
  const key = normalizePrefixKey(parts[1]!)
  return key ? `Leader ${key}` : null
}

function chordParts(binding: string): NormalizedChordParts {
  const segments = binding.split("-")
  const key = segments.at(-1) ?? ""
  return { modifiers: segments.slice(0, -1), key }
}

function canonicalChordForPlatform(binding: string, platform: KeymapPlatform): string {
  const { modifiers, key } = chordParts(binding)
  const resolved = modifiers.map(modifier => {
    if (modifier !== "Mod") return modifier
    return platform === "mac" ? "Cmd" : "Ctrl"
  })
  return [...resolved, key].join("-")
}

function isPrimaryModifier(modifiers: readonly string[], platform: KeymapPlatform): boolean {
  return modifiers.includes("Mod") ||
    (platform === "mac" ? modifiers.includes("Cmd") : modifiers.includes("Ctrl"))
}

export function classifyKeyBinding(
  binding: string,
  kind: "leader" | "direct" | "prefix",
  platform: KeymapPlatform,
): KeymapRiskClassification {
  if (kind === "prefix") {
    const normalized = normalizePrefixKey(binding)
    if (!normalized) {
      return { risk: "widget-local", reason: "Leader keys must be one printable key." }
    }
    if (normalized.toLowerCase() === "p") {
      return { risk: "banned", reason: "Prefix p is a removed alias and stays reserved." }
    }
    return { risk: "safe" }
  }

  const normalized = normalizeKeyChord(binding)
  if (!normalized) return { risk: "widget-local", reason: "The chord is outside the key grammar." }
  const { modifiers, key } = chordParts(normalized)
  if (WIDGET_LOCAL_KEYS.has(key)) {
    return { risk: "widget-local", reason: `${key} remains local to terminal and list widgets.` }
  }
  if (kind === "leader") {
    if (!/^(?:Mod|Ctrl)-[a-z]$/.test(normalized)) {
      return {
        risk: "terminal-reserved",
        reason: "Leaders must be Mod-letter or Ctrl-letter chords with an exact control byte.",
      }
    }
  } else {
    if (normalized === "Mod-k" || normalized === "Mod-Shift-p") {
      return { risk: "banned", reason: `${normalized} is a removed direct alias.` }
    }
    if (
      !isPrimaryModifier(modifiers, platform) ||
      modifiers.includes("Alt") ||
      (modifiers.includes("Ctrl") && !modifiers.includes("Mod"))
    ) {
      return {
        risk: "terminal-reserved",
        reason: "Plain, Alt, and explicit terminal Ctrl chords pass through to the PTY.",
      }
    }
  }

  if (modifiers.includes("Cmd") && platform !== "mac") {
    return { risk: "os-unavailable", reason: "Cmd bindings are unavailable on this platform." }
  }
  if (isPrimaryModifier(modifiers, platform) && PRIMARY_UNAVAILABLE_KEYS.has(key)) {
    return {
      risk: "os-unavailable",
      reason: `${normalized} is reserved by the browser or operating system.`,
    }
  }
  if (
    kind === "leader" &&
    (normalized === "Mod-k" || normalized.startsWith("Ctrl-"))
  ) {
    return { risk: "safe" }
  }
  if (normalized === "Mod-,") return { risk: "safe" }
  return {
    risk: "browser-risky",
    reason: `${normalized} may replace a browser shortcut and needs explicit confirmation.`,
  }
}

function groupFor(command: CommandId): MuxSessionPrefixGroupId {
  switch (commandDescriptor(command).category) {
    case "navigation":
      return "navigate"
    case "session":
      return "open"
    default:
      return "actions"
  }
}

function conflict(
  code: KeymapConflictCode,
  message: string,
  options: {
    readonly command?: CommandId
    readonly binding?: string
    readonly risk?: KeymapRisk
  } = {},
): KeymapConflict {
  return { code, message, ...options }
}

export function compileKeymap(
  defaults: KeymapDefaultCatalog,
  profile: KeymapProfile,
  platform: KeymapPlatform,
): CompileKeymapResult {
  const conflicts: KeymapConflict[] = []
  if (profile.bindings.length > MAX_KEYMAP_BINDINGS) {
    conflicts.push(conflict("binding-limit", `Profiles may contain at most ${MAX_KEYMAP_BINDINGS} overrides.`))
  }
  if (JSON.stringify(profile).length > MAX_KEYMAP_JSON_BYTES) {
    conflicts.push(conflict("binding-limit", "The keymap profile exceeds the 32 KiB limit."))
  }

  const leader = normalizeKeyChord(profile.leader)
  if (!leader) {
    conflicts.push(conflict("invalid-leader", "The leader is not a valid key chord.", { binding: profile.leader }))
  } else {
    const classification = classifyKeyBinding(leader, "leader", platform)
    if (classification.risk === "browser-risky" && profile.confirmedLeaderRisky !== true) {
      conflicts.push(conflict(
        "risky-confirmation-required",
        classification.reason ?? "The leader needs confirmation.",
        { binding: leader, risk: classification.risk },
      ))
    } else if (classification.risk !== "safe" && classification.risk !== "browser-risky") {
      conflicts.push(conflict(
        "reserved-binding",
        classification.reason ?? "The leader is reserved.",
        { binding: leader, risk: classification.risk },
      ))
    }
  }

  const overridesByCommand = new Map<CommandId, KeymapOverride>()
  for (const override of profile.bindings) {
    if (overridesByCommand.has(override.command)) {
      conflicts.push(conflict(
        "duplicate-command",
        `${commandDescriptor(override.command).title} has more than one override.`,
        { command: override.command },
      ))
    } else {
      overridesByCommand.set(override.command, override)
    }
  }

  const prefixBindings = defaults.prefixBindings
    .filter(binding => !overridesByCommand.has(binding.command))
    .map(binding => ({ ...binding }))
  const directBindings = defaults.directBindings
    .filter(binding => !overridesByCommand.has(binding.command))
    .map(binding => ({ ...binding }))
  const contextBindings = defaults.contextBindings
    .filter(binding => !overridesByCommand.has(binding.command))
    .map(binding => ({ ...binding }))

  for (const override of overridesByCommand.values()) {
    if (override.command === "settings.show") {
      conflicts.push(conflict(
        "immutable-recovery-binding",
        "Open settings keeps Mod-, as an immutable keyboard recovery path.",
        { command: override.command, binding: override.binding ?? undefined },
      ))
      continue
    }
    if (override.binding === null) continue
    if (override.command === "terminal.jump") {
      conflicts.push(conflict(
        "unsupported-dynamic-command",
        "Terminal position jump keeps its 1–9 range binding.",
        { command: override.command, binding: override.binding },
      ))
      continue
    }
    if (override.binding.length > MAX_KEY_BINDING_LENGTH) {
      conflicts.push(conflict(
        "binding-too-long",
        "Bindings may be at most 64 characters.",
        { command: override.command, binding: override.binding },
      ))
      continue
    }
    const sequence = normalizeKeySequence(override.binding)
    if (!sequence) {
      conflicts.push(conflict(
        "invalid-binding",
        `${commandDescriptor(override.command).title} has an invalid binding.`,
        { command: override.command, binding: override.binding },
      ))
      continue
    }
    if (sequence.startsWith("Leader ")) {
      const key = sequence.slice("Leader ".length)
      const classification = classifyKeyBinding(key, "prefix", platform)
      if (classification.risk !== "safe") {
        conflicts.push(conflict(
          "reserved-binding",
          classification.reason ?? "The leader key is reserved.",
          { command: override.command, binding: sequence, risk: classification.risk },
        ))
        continue
      }
      prefixBindings.push({
        id: `override.${override.command}`,
        key,
        command: override.command,
        desc: commandDescriptor(override.command).title,
        group: groupFor(override.command),
      })
      continue
    }

    const classification = classifyKeyBinding(sequence, "direct", platform)
    if (classification.risk === "browser-risky" && override.confirmedRisky !== true) {
      conflicts.push(conflict(
        "risky-confirmation-required",
        classification.reason ?? "The binding needs confirmation.",
        {
          command: override.command,
          binding: sequence,
          risk: classification.risk,
        },
      ))
      continue
    }
    if (classification.risk !== "safe" && classification.risk !== "browser-risky") {
      conflicts.push(conflict(
        "reserved-binding",
        classification.reason ?? "The binding is reserved.",
        {
          command: override.command,
          binding: sequence,
          risk: classification.risk,
        },
      ))
      continue
    }
    directBindings.push({
      id: `override.${override.command}`,
      key: sequence,
      command: override.command,
      desc: commandDescriptor(override.command).title,
      riskyReason: classification.risk === "browser-risky" ? classification.reason : undefined,
    })
  }

  const prefixKeys = new Map<string, CommandId>()
  for (const binding of prefixBindings) {
    const key = normalizePrefixKey(binding.key) ?? binding.key
    const previous = prefixKeys.get(key)
    if (previous) {
      conflicts.push(conflict(
        "duplicate-binding",
        `${binding.key} is already assigned to ${commandDescriptor(previous).title}.`,
        { command: binding.command, binding: binding.key },
      ))
    } else {
      prefixKeys.set(key, binding.command)
    }
  }

  const directKeys = new Map<string, CommandId>()
  for (const binding of directBindings) {
    const key = canonicalChordForPlatform(normalizeKeyChord(binding.key) ?? binding.key, platform)
    const previous = directKeys.get(key)
    if (previous) {
      conflicts.push(conflict(
        "duplicate-binding",
        `${binding.key} is already assigned to ${commandDescriptor(previous).title}.`,
        { command: binding.command, binding: binding.key },
      ))
    } else {
      directKeys.set(key, binding.command)
    }
  }

  if (leader) {
    const leaderKey = canonicalChordForPlatform(leader, platform)
    const ambiguous = directKeys.get(leaderKey)
    if (ambiguous) {
      conflicts.push(conflict(
        "prefix-ambiguity",
        `${leader} cannot be both the leader and ${commandDescriptor(ambiguous).title}.`,
        { command: ambiguous, binding: leader },
      ))
    }
  }

  for (const required of ["commandPalette.show", "settings.show", "keymap.reset"] as const) {
    const reachable = prefixBindings.some(binding => binding.command === required) ||
      directBindings.some(binding => binding.command === required)
    if (!reachable) {
      conflicts.push(conflict(
        "required-command-unreachable",
        `${commandDescriptor(required).title} must keep a keyboard recovery path.`,
        { command: required },
      ))
    }
  }

  if (conflicts.length > 0 || !leader) return { ok: false, conflicts }
  return {
    ok: true,
    keymap: {
      source: profile,
      leader,
      prefixBindings,
      directBindings,
      contextBindings,
    },
  }
}

export function decodeKeymapProfileJson(raw: string | null): DecodeKeymapProfileResult {
  if (raw === null) return { ok: false, diagnostic: "empty" }
  if (new TextEncoder().encode(raw).byteLength > MAX_KEYMAP_JSON_BYTES) {
    return { ok: false, diagnostic: "oversized" }
  }
  if (raw.trim() === "") return { ok: false, diagnostic: "empty" }
  const decoded = decodeKeymapProfileOption(raw)
  if (Option.isSome(decoded)) return { ok: true, profile: decoded.value }
  const version = decodeVersionProbeOption(raw)
  return Option.isSome(version) && version.value.version > KEYMAP_PROFILE_VERSION
    ? { ok: false, diagnostic: "newer-version" }
    : { ok: false, diagnostic: "invalid" }
}

export function encodeKeymapProfileJson(profile: KeymapProfile): string {
  return JSON.stringify(profile, null, 2)
}

export function keymapPlatform(navigatorPlatform: string, processPlatform = ""): KeymapPlatform {
  if (/Mac|iPhone|iPad|iPod/i.test(navigatorPlatform) || processPlatform === "darwin") return "mac"
  return /Win/i.test(navigatorPlatform) || processPlatform === "win32" ? "windows" : "linux"
}

export function bindingFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: KeymapPlatform,
): string | null {
  const key = event.key === " " ? "Space" : normalizedKey(event.key)
  if (!key || key === "Escape") return null
  const modifiers: string[] = []
  if (platform === "mac" ? event.metaKey : event.ctrlKey) modifiers.push("Mod")
  if (platform === "mac" && event.ctrlKey) modifiers.push("Ctrl")
  if (platform !== "mac" && event.metaKey) modifiers.push("Cmd")
  if (event.altKey) modifiers.push("Alt")
  if (event.shiftKey) modifiers.push("Shift")
  return normalizeKeyChord([...modifiers, key].join("-"))
}
