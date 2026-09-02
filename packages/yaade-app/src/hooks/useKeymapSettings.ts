import { useCallback, useEffect, useRef, useState } from "react"
import type { CommandId } from "../commands/catalog.js"
import { installEffectiveKeymap } from "../effective-keymap.js"
import { DEFAULT_KEYMAP_CATALOG } from "../keybindings.js"
import {
  DEFAULT_KEYMAP_PROFILE,
  compileKeymap,
  decodeKeymapProfileJson,
  encodeKeymapProfileJson,
  keymapPlatform,
  normalizeKeyChord,
  normalizeKeySequence,
  type EffectiveKeymap,
  type KeymapConflict,
  type KeymapPlatform,
  type KeymapProfile,
} from "../keymap-profile.js"
import {
  KEYMAP_STORAGE_KEY,
  decodeStoredKeymapJson,
  loadKeymapSettings,
  persistKeymapSettings,
  shouldApplyStoredKeymap,
  type KeymapDiagnostic,
} from "../keymap-storage.js"

type KeymapSettingsState = {
  readonly profile: KeymapProfile
  readonly effectiveKeymap: EffectiveKeymap
  readonly revision: number
  readonly diagnostic?: KeymapDiagnostic
  readonly conflicts: readonly KeymapConflict[]
  readonly pendingProfile: KeymapProfile | null
}

function initialState(platform: KeymapPlatform): KeymapSettingsState {
  const loaded = loadKeymapSettings(localStorage, DEFAULT_KEYMAP_CATALOG, platform)
  installEffectiveKeymap(loaded.effectiveKeymap)
  return {
    ...loaded,
    conflicts: [],
    pendingProfile: null,
  }
}

function importConflict(message: string): KeymapConflict {
  return { code: "invalid-binding", message }
}

export function useKeymapSettings() {
  const platform = keymapPlatform(navigator.platform)
  const [state, setState] = useState<KeymapSettingsState>(() => initialState(platform))
  const stateRef = useRef(state)
  stateRef.current = state

  const installProfile = useCallback((profile: KeymapProfile): boolean => {
    const compiled = compileKeymap(DEFAULT_KEYMAP_CATALOG, profile, platform)
    if (!compiled.ok) {
      const confirmable = compiled.conflicts.length > 0 && compiled.conflicts.every(
        item => item.code === "risky-confirmation-required",
      )
      setState(previous => ({
        ...previous,
        conflicts: compiled.conflicts,
        pendingProfile: confirmable ? profile : null,
      }))
      return false
    }

    const persisted = persistKeymapSettings(
      localStorage,
      profile,
      stateRef.current.revision,
    )
    const next: KeymapSettingsState = {
      profile,
      effectiveKeymap: compiled.keymap,
      revision: persisted.ok ? persisted.revision : stateRef.current.revision,
      diagnostic: persisted.ok ? undefined : persisted.diagnostic,
      conflicts: [],
      pendingProfile: null,
    }
    installEffectiveKeymap(compiled.keymap)
    stateRef.current = next
    setState(next)
    return true
  }, [platform])

  const setLeader = useCallback((leader: string): boolean => {
    const normalized = normalizeKeyChord(leader)
    if (!normalized) {
      setState(previous => ({
        ...previous,
        conflicts: [importConflict("The leader is not a valid key chord.")],
        pendingProfile: null,
      }))
      return false
    }
    return installProfile({
      ...stateRef.current.profile,
      leader: normalized,
      confirmedLeaderRisky: undefined,
    })
  }, [installProfile])

  const setBinding = useCallback((command: CommandId, binding: string | null): boolean => {
    const normalized = binding === null ? null : normalizeKeySequence(binding)
    if (binding !== null && !normalized) {
      setState(previous => ({
        ...previous,
        conflicts: [importConflict("The binding is outside the supported key grammar.")],
        pendingProfile: null,
      }))
      return false
    }
    return installProfile({
      ...stateRef.current.profile,
      bindings: [
        ...stateRef.current.profile.bindings.filter(item => item.command !== command),
        { command, binding: normalized, context: "global" },
      ],
    })
  }, [installProfile])

  const restoreBinding = useCallback((command: CommandId): boolean =>
    installProfile({
      ...stateRef.current.profile,
      bindings: stateRef.current.profile.bindings.filter(item => item.command !== command),
    }), [installProfile])

  const confirmPending = useCallback((): boolean => {
    const pending = stateRef.current.pendingProfile
    if (!pending) return false
    const riskyCommands = new Set(
      stateRef.current.conflicts.flatMap(item => item.command ? [item.command] : []),
    )
    const confirmLeader = stateRef.current.conflicts.some(item => item.command === undefined)
    return installProfile({
      ...pending,
      confirmedLeaderRisky: confirmLeader ? true : pending.confirmedLeaderRisky,
      bindings: pending.bindings.map(item =>
        riskyCommands.has(item.command) ? { ...item, confirmedRisky: true } : item),
    })
  }, [installProfile])

  const resetKeymap = useCallback((): boolean =>
    installProfile(DEFAULT_KEYMAP_PROFILE), [installProfile])

  const importProfile = useCallback((raw: string): boolean => {
    const decoded = decodeKeymapProfileJson(raw)
    if (!decoded.ok) {
      setState(previous => ({
        ...previous,
        conflicts: [importConflict(
          decoded.diagnostic === "newer-version"
            ? "This keymap was created by a newer YAADE version."
            : decoded.diagnostic === "oversized"
              ? "The imported keymap exceeds the 32 KiB limit."
              : "The imported JSON is not a valid keymap profile.",
        )],
        pendingProfile: null,
      }))
      return false
    }
    return installProfile(decoded.profile)
  }, [installProfile])

  const exportProfile = useCallback(
    () => encodeKeymapProfileJson(stateRef.current.profile),
    [],
  )

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== KEYMAP_STORAGE_KEY || event.newValue === null) return
      const decoded = decodeStoredKeymapJson(event.newValue)
      if (!decoded.ok || !shouldApplyStoredKeymap(stateRef.current.revision, decoded.stored)) return
      const compiled = compileKeymap(DEFAULT_KEYMAP_CATALOG, decoded.stored.profile, platform)
      if (!compiled.ok) return
      const next: KeymapSettingsState = {
        ...decoded.stored,
        effectiveKeymap: compiled.keymap,
        conflicts: [],
        pendingProfile: null,
      }
      installEffectiveKeymap(compiled.keymap)
      stateRef.current = next
      setState(next)
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [platform])

  return {
    profile: state.profile,
    effectiveKeymap: state.effectiveKeymap,
    conflicts: state.conflicts,
    diagnostic: state.diagnostic,
    platform,
    setLeader,
    setBinding,
    restoreBinding,
    confirmPending,
    resetKeymap,
    importProfile,
    exportProfile,
  }
}
