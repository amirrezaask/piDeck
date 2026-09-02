/**
 * YAADE keybinding catalog — the only file that assigns keys to commands.
 *
 * Dispatch, HUD, shortcut labels, and tests import from here. Do not add
 * chords in components. Prefix commands have one key each; direct layout
 * commands are explicit exceptions.
 *
 * Browser-reserved chords stay unbound in normal keymaps. Shell actions live
 * behind Mod-k (⌘K on macOS, Ctrl+K elsewhere). Press the prefix twice in a
 * terminal to send ^K (kill-line).
 *
 * Removed Terminal Session aliases (do not reintroduce):
 *   prefix p, Mod-k as a direct chord, Mod-Shift-p
 *
 * Not command bindings (stay local, listed so this file is the inventory):
 *   Widget nav     arrows / Home / End / Enter / Space / Escape in listers,
 *                  tab strips, rename fields, sidebar resize
 *   Overlay        Escape closes; terminal overlays handle their own confirmation
 *   Terminal PTY   packages/yaade-ui/src/panels/terminal-keybindings.ts
 *                  (Shift-Enter, Escape, mac Option/Cmd arrows + Backspace)
 */

import { Schema } from "effect"
import {
  chordIsActive,
  clearChord,
  createChordState,
  keyEventMatchesBinding,
  startChord,
  type ChordState,
  type KeyEventLike,
} from "@yaade/workspace"
import { readEffectiveKeymap } from "./effective-keymap.js"
import type { KeymapDefaultCatalog } from "./keymap-profile.js"
import {
  COMMAND_CATALOG,
  COMMAND_IDS,
  commandDescriptor,
  type CommandId,
} from "./commands/catalog.js"

export const SHELL_PREFIX = "Mod-k"
export const MUX_SESSION_PREFIX = SHELL_PREFIX
export const MUX_SESSION_COMMANDS = COMMAND_IDS
export type MuxSessionCommand = CommandId

const MuxSessionCommandSchema = Schema.Literal(...MUX_SESSION_COMMANDS)

export const decodeMuxSessionCommand = Schema.decodeUnknownOption(MuxSessionCommandSchema)
export const isMuxSessionCommand = Schema.is(MuxSessionCommandSchema)

export type MuxSessionPrefixGroupId = "open" | "navigate" | "actions"

export type MuxSessionPrefixBinding = {
  readonly id: string
  readonly key: string
  readonly command: MuxSessionCommand
  readonly desc: string
  readonly group: MuxSessionPrefixGroupId
  /** When false, the binding still works but stays off the HUD. */
  readonly hud?: boolean
  /** Required when a synthetic key represents a range such as 1–9. */
  readonly keyRange?: "terminal-position"
  /** Whether holding the key may repeat the command. Defaults to descriptor policy. */
  readonly repeatable?: boolean
}

export type MuxSessionDirectBinding = {
  readonly id: string
  readonly key: string
  readonly command: MuxSessionCommand
  readonly desc: string
  /** Whether holding the key may repeat the command. Defaults to descriptor policy. */
  readonly repeatable?: boolean
  /** Required when the chord intentionally collides with a browser action. */
  readonly riskyReason?: string
}

export type MuxSessionContextKind = never

export type MuxSessionContextBinding = {
  readonly id: string
  readonly key: string
  readonly command: MuxSessionCommand
  readonly desc: string
  readonly when: readonly MuxSessionContextKind[]
  /** Risky chord — only legal with a written reason. */
  readonly riskyReason?: string
  /** Whether holding the key may repeat the command. Defaults to descriptor policy. */
  readonly repeatable?: boolean
}

function prefixBinding(options: {
  readonly id: string
  readonly key: string
  readonly command: MuxSessionCommand
  readonly group: MuxSessionPrefixGroupId
  readonly hud?: boolean
  readonly keyRange?: "terminal-position"
}): MuxSessionPrefixBinding {
  return {
    ...options,
    desc: commandDescriptor(options.command).title,
  }
}

function directBinding(options: {
  readonly id: string
  readonly key: string
  readonly command: MuxSessionCommand
  readonly riskyReason?: string
}): MuxSessionDirectBinding {
  return {
    ...options,
    desc: commandDescriptor(options.command).title,
  }
}

export const MUX_SESSION_PREFIX_GROUPS: readonly {
  readonly id: MuxSessionPrefixGroupId
  readonly label: string
}[] = [
  { id: "open", label: "Open" },
  { id: "navigate", label: "Navigate" },
  { id: "actions", label: "Actions" },
]

export const MUX_SESSION_PREFIX_BINDINGS: readonly MuxSessionPrefixBinding[] = [
  prefixBinding({ id: "prefix.commands", key: "c", command: "commandPalette.show", group: "open" }),
  prefixBinding({ id: "prefix.terminal.new", key: "t", command: "terminal.newTerminal", group: "open" }),
  prefixBinding({ id: "prefix.terminal.switch", key: "u", command: "terminal.switch", group: "open" }),
  prefixBinding({
    id: "prefix.terminal.switchPrevious",
    key: "b",
    command: "terminal.switchPrevious",
    group: "navigate",
  }),
  prefixBinding({ id: "prefix.session.switch", key: "/", command: "session.switch", group: "open" }),
  prefixBinding({ id: "prefix.session.new", key: "s", command: "session.new", group: "open" }),
  prefixBinding({ id: "prefix.tab.new", key: "w", command: "tab.new", group: "open" }),
  prefixBinding({ id: "prefix.settings.show", key: ",", command: "settings.show", group: "open" }),
  prefixBinding({
    id: "prefix.keymap.reset",
    key: "Shift-R",
    command: "keymap.reset",
    group: "actions",
  }),
  prefixBinding({ id: "prefix.terminal.next", key: "n", command: "terminal.next", group: "navigate" }),
  prefixBinding({ id: "prefix.terminal.previous", key: "Shift-N", command: "terminal.previous", group: "navigate" }),
  prefixBinding({ id: "prefix.tab.next", key: "]", command: "tab.next", group: "navigate" }),
  prefixBinding({ id: "prefix.tab.previous", key: "[", command: "tab.previous", group: "navigate" }),
  prefixBinding({
    id: "prefix.terminal.jump",
    key: "1–9",
    command: "terminal.jump",
    group: "navigate",
    keyRange: "terminal-position",
  }),
  prefixBinding({ id: "prefix.terminal.jumpLive", key: "g", command: "terminal.jumpLive", group: "navigate" }),
  prefixBinding({
    id: "prefix.terminal.toggleInspectionPause",
    key: "Shift-G",
    command: "terminal.toggleInspectionPause",
    group: "actions",
  }),
  prefixBinding({ id: "prefix.pane.zoom", key: "z", command: "pane.zoom", group: "actions" }),
  prefixBinding({ id: "prefix.terminal.close", key: "x", command: "terminal.close", group: "actions" }),
  prefixBinding({ id: "prefix.tab.close", key: "q", command: "tab.close", group: "actions" }),
  prefixBinding({ id: "prefix.session.close", key: "Shift-X", command: "session.close", group: "actions" }),
]

/**
 * Direct layout chords are deliberately supported even though browsers label
 * them as risky: Chromium delivers these keydowns and the app has visible
 * pointer fallbacks. Structural commands never repeat on hold.
 */
export const MUX_SESSION_DIRECT_BINDINGS: readonly MuxSessionDirectBinding[] = [
  directBinding({
    id: "direct.pane.splitRight",
    key: "Mod-d",
    command: "pane.splitRight",
    riskyReason: "Mod-d is the terminal multiplexer split chord.",
  }),
  directBinding({
    id: "direct.pane.splitDown",
    key: "Mod-Shift-d",
    command: "pane.splitDown",
    riskyReason: "Mod-Shift-d is the terminal multiplexer split chord.",
  }),
  directBinding({
    id: "direct.sidebar.toggle",
    key: "Mod-b",
    command: "sidebar.toggle",
    riskyReason: "Mod-b is the terminal multiplexer sidebar toggle chord.",
  }),
  directBinding({
    id: "direct.settings.show",
    key: "Mod-,",
    command: "settings.show",
  }),
]

export const MUX_SESSION_CONTEXT_BINDINGS: readonly MuxSessionContextBinding[] = []

export const DEFAULT_KEYMAP_CATALOG: KeymapDefaultCatalog = {
  leader: MUX_SESSION_PREFIX,
  prefixBindings: MUX_SESSION_PREFIX_BINDINGS,
  directBindings: MUX_SESSION_DIRECT_BINDINGS,
  contextBindings: MUX_SESSION_CONTEXT_BINDINGS,
}

/** Commands intentionally available through both prefix and direct chords. */
export const MUX_SESSION_DUAL_PATH_COMMANDS: readonly MuxSessionCommand[] = ["settings.show"]

function currentKeymap(keymap?: KeymapDefaultCatalog): KeymapDefaultCatalog {
  return keymap ?? readEffectiveKeymap() ?? DEFAULT_KEYMAP_CATALOG
}

export type MuxSessionKeyEvent = KeyEventLike &
  Pick<KeyboardEvent, "repeat" | "isComposing">

export type MuxSessionKeymapState = ChordState

export function createMuxSessionKeymapState(): MuxSessionKeymapState {
  return createChordState()
}

export function clearMuxSessionKeymapState(state: MuxSessionKeymapState): void {
  clearChord(state)
}

export function muxSessionLeader(keymap?: KeymapDefaultCatalog): string {
  return currentKeymap(keymap).leader
}

export function muxSessionPrefixBindingKey(
  key: string,
  prefix?: string,
): string {
  return `${prefix ?? muxSessionLeader()} ${key}`
}

export function muxSessionShortcutFor(
  command: string,
  keymap?: KeymapDefaultCatalog,
): string | undefined {
  const current = currentKeymap(keymap)
  const binding = current.prefixBindings.find(
    item => item.command === command && item.hud !== false,
  )
  return binding ? muxSessionPrefixBindingKey(binding.key, current.leader) : undefined
}

export function muxSessionDirectShortcutFor(
  command: string,
  keymap?: KeymapDefaultCatalog,
): string | undefined {
  return currentKeymap(keymap).directBindings.find(item => item.command === command)?.key
}

export function muxSessionPrimaryShortcutFor(
  command: MuxSessionCommand,
  keymap?: KeymapDefaultCatalog,
): string | undefined {
  const current = currentKeymap(keymap)
  const bindingId = commandDescriptor(command).bindingId
  if (bindingId) {
    const direct = current.directBindings.find(binding => binding.id === bindingId)
    if (direct) return direct.key
    const prefix = current.prefixBindings.find(binding => binding.id === bindingId)
    if (prefix) return muxSessionPrefixBindingKey(prefix.key, current.leader)
  }
  return muxSessionShortcutFor(command, keymap) ?? muxSessionDirectShortcutFor(command, keymap)
}

export function muxSessionHudBindings(
  keymap?: KeymapDefaultCatalog,
): readonly MuxSessionPrefixBinding[] {
  return currentKeymap(keymap).prefixBindings.filter(item => item.hud !== false)
}

export function serializeMuxSessionPrefixKey(
  event: Pick<KeyEventLike, "key" | "shiftKey">,
): string {
  if (event.shiftKey && event.key.length === 1) {
    return `Shift-${event.key.toUpperCase()}`
  }
  if (event.key.length === 1) return event.key.toLowerCase()
  return event.key
}

export function isMuxSessionJumpKey(key: string): boolean {
  return /^[1-9]$/.test(key)
}

export function matchMuxSessionPrefixBinding(
  key: string,
  keymap?: KeymapDefaultCatalog,
): MuxSessionPrefixBinding | undefined {
  const bindings = currentKeymap(keymap).prefixBindings
  if (isMuxSessionJumpKey(key)) {
    return bindings.find(binding => binding.keyRange === "terminal-position")
  }
  return bindings.find(binding => binding.keyRange == null && binding.key === key)
}

export function matchMuxSessionDirectBinding(
  event: KeyEventLike,
  keymap?: KeymapDefaultCatalog,
): MuxSessionDirectBinding | undefined {
  return currentKeymap(keymap).directBindings.find(
    item => keyEventMatchesBinding(event, item.key),
  )
}

export function matchMuxSessionContextBinding(
  _event: KeyEventLike,
  _kind: string | undefined,
  _keymap?: KeymapDefaultCatalog,
): MuxSessionContextBinding | undefined {
  return undefined
}

export type MuxSessionKeydownContext = {
  readonly overlayOpen: boolean
  readonly inEditable: boolean
  readonly inTerminal: boolean
  readonly inPrefixButton: boolean
  readonly zoomed: boolean
  /** Whether a layout with a toggleable vertical sidebar is active. */
  readonly sidebarLayout?: boolean
  readonly contextKind?: string
}

export type MuxSessionKeydownResult =
  | { readonly type: "prefix-started"; readonly prefix: string }
  | {
      readonly type: "command"
      readonly command: MuxSessionCommand
      readonly jumpIndex?: number
    }
  | { readonly type: "prefix-literal"; readonly byte: string }
  | { readonly type: "prefix-cancelled" }
  | { readonly type: "consume" }

function commandResult(
  binding:
    | MuxSessionPrefixBinding
    | MuxSessionDirectBinding
    | MuxSessionContextBinding,
  event: MuxSessionKeyEvent,
  jumpIndex?: number,
): MuxSessionKeydownResult {
  const repeatable = binding.repeatable ?? commandDescriptor(binding.command).repeat === "allow"
  if (!repeatable && event.repeat) return { type: "consume" }
  return jumpIndex == null
    ? { type: "command", command: binding.command }
    : { type: "command", command: binding.command, jumpIndex }
}

/**
 * Resolve one keydown without touching React or the DOM. The caller owns
 * preventDefault/stopPropagation and command execution.
 */
export function resolveMuxSessionKeydown(
  event: MuxSessionKeyEvent,
  state: MuxSessionKeymapState,
  context: MuxSessionKeydownContext,
  now = Date.now(),
  keymap?: KeymapDefaultCatalog,
): MuxSessionKeydownResult | null {
  const current = currentKeymap(keymap)
  if (event.isComposing) {
    clearChord(state)
    return null
  }
  if (context.overlayOpen || context.inEditable || context.inPrefixButton) {
    clearChord(state)
    return null
  }

  const prefixActive = chordIsActive(state, now)
  if (!prefixActive && state.prefix != null) clearChord(state)

  if (prefixActive) {
    if (
      event.key === "Meta" ||
      event.key === "Control" ||
      event.key === "Alt" ||
      event.key === "Shift"
    ) {
      return { type: "consume" }
    }
    if (event.key === "Escape") {
      clearChord(state)
      return { type: "prefix-cancelled" }
    }
    if (keyEventMatchesBinding(event, current.leader)) {
      if (event.repeat) return { type: "consume" }
      clearChord(state)
      const byte = context.inTerminal ? prefixLiteralByte(current.leader) : null
      return byte ? { type: "prefix-literal", byte } : { type: "prefix-cancelled" }
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      clearChord(state)
      return { type: "consume" }
    }
    const key = serializeMuxSessionPrefixKey(event)
    const binding = matchMuxSessionPrefixBinding(key, current)
    clearChord(state)
    if (!binding) return { type: "consume" }
    const jumpIndex = isMuxSessionJumpKey(key) ? Number(key) - 1 : undefined
    return commandResult(binding, event, jumpIndex)
  }

  if (keyEventMatchesBinding(event, current.leader)) {
    if (event.repeat) return { type: "consume" }
    startChord(state, current.leader, now)
    return { type: "prefix-started", prefix: current.leader }
  }

  const contextBinding = matchMuxSessionContextBinding(event, context.contextKind, current)
  if (contextBinding) return commandResult(contextBinding, event)

  const directBinding = matchMuxSessionDirectBinding(event, current)
  if (directBinding?.command === "sidebar.toggle" && context.sidebarLayout === false) {
    return null
  }
  return directBinding ? commandResult(directBinding, event) : null
}

/**
 * Control byte a `Ctrl-<letter>` / `Mod-<letter>` prefix would have sent to
 * the PTY, so pressing the prefix twice passes it through (tmux send-prefix).
 */
export function prefixLiteralByte(prefix = SHELL_PREFIX): string | null {
  const match = /^(?:Ctrl|Mod)-([a-z])$/i.exec(prefix.trim())
  if (!match) return null
  const letter = match[1]!.toLowerCase()
  const code = letter.charCodeAt(0) - 96
  if (code < 1 || code > 26) return null
  return String.fromCharCode(code)
}

export function validateMuxSessionBindings(): readonly string[] {
  const issues: string[] = []
  const bindingIds = new Set<string>()
  const directKeys = new Set<string>()
  const prefixKeys = new Set<string>()
  const commandPaths = new Map<MuxSessionCommand, number>()

  const record = (id: string, key: string, command: MuxSessionCommand, keys: Set<string>) => {
    if (bindingIds.has(id)) issues.push(`duplicate binding id: ${id}`)
    bindingIds.add(id)
    if (keys.has(key)) issues.push(`duplicate binding key: ${key}`)
    keys.add(key)
    commandPaths.set(command, (commandPaths.get(command) ?? 0) + 1)
  }

  for (const binding of MUX_SESSION_PREFIX_BINDINGS) {
    record(binding.id, binding.key, binding.command, prefixKeys)
    if (binding.key === "p") issues.push("banned prefix binding: p")
  }
  for (const binding of MUX_SESSION_DIRECT_BINDINGS) {
    record(binding.id, binding.key, binding.command, directKeys)
    if (binding.key === "Mod-k" || binding.key === "Mod-Shift-p") {
      issues.push(`banned direct binding: ${binding.key}`)
    }
    if (binding.riskyReason !== undefined && !binding.riskyReason.trim()) {
      issues.push(`missing risky binding reason: ${binding.id}`)
    }
  }
  for (const binding of MUX_SESSION_CONTEXT_BINDINGS) {
    record(binding.id, binding.key, binding.command, directKeys)
  }

  for (const [command, count] of commandPaths) {
    if (count > 1 && !MUX_SESSION_DUAL_PATH_COMMANDS.includes(command)) {
      issues.push(`undeclared dual-path command: ${command}`)
    }
  }
  for (const descriptor of COMMAND_CATALOG) {
    if (descriptor.bindingId && !bindingIds.has(descriptor.bindingId)) {
      issues.push(`missing descriptor binding: ${descriptor.id} -> ${descriptor.bindingId}`)
    }
  }
  return issues
}
