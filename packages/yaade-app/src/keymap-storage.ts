import { Option, Schema } from "effect"
import {
  DEFAULT_KEYMAP_PROFILE,
  KEYMAP_PROFILE_VERSION,
  KeymapProfileSchema,
  MAX_KEYMAP_JSON_BYTES,
  compileKeymap,
  type EffectiveKeymap,
  type KeymapDefaultCatalog,
  type KeymapPlatform,
  type KeymapProfile,
} from "./keymap-profile.js"

export const KEYMAP_STORAGE_KEY = "yaade-keymap-profile-v1"

export type KeymapStorage = Pick<Storage, "getItem" | "setItem">
export type KeymapDiagnostic =
  | "invalid-storage"
  | "newer-version"
  | "oversized"
  | "compile-conflict"
  | "storage-denied"

export type StoredKeymapProfile = {
  readonly revision: number
  readonly profile: KeymapProfile
}

export type LoadedKeymapSettings = StoredKeymapProfile & {
  readonly effectiveKeymap: EffectiveKeymap
  readonly diagnostic?: KeymapDiagnostic
}

const StoredKeymapProfileSchema = Schema.Struct({
  revision: Schema.Number,
  profile: KeymapProfileSchema,
})
const StoredKeymapJsonSchema = Schema.parseJson(StoredKeymapProfileSchema)
const StoredVersionProbeJsonSchema = Schema.parseJson(Schema.Struct({
  revision: Schema.Number,
  profile: Schema.Struct({ version: Schema.Number }),
}))
const decodeStoredOption = Schema.decodeUnknownOption(StoredKeymapJsonSchema)
const decodeStoredVersionOption = Schema.decodeUnknownOption(StoredVersionProbeJsonSchema)

function defaultEffectiveKeymap(defaults: KeymapDefaultCatalog): EffectiveKeymap {
  const compiled = compileKeymap(defaults, DEFAULT_KEYMAP_PROFILE, "linux")
  return compiled.ok
    ? compiled.keymap
    : { ...defaults, source: DEFAULT_KEYMAP_PROFILE }
}

function fallback(
  defaults: KeymapDefaultCatalog,
  diagnostic?: KeymapDiagnostic,
): LoadedKeymapSettings {
  const base = {
    revision: 0,
    profile: DEFAULT_KEYMAP_PROFILE,
    effectiveKeymap: defaultEffectiveKeymap(defaults),
  }
  return diagnostic ? { ...base, diagnostic } : base
}

export function decodeStoredKeymapJson(
  raw: string,
):
  | { readonly ok: true; readonly stored: StoredKeymapProfile }
  | { readonly ok: false; readonly diagnostic: KeymapDiagnostic } {
  if (new TextEncoder().encode(raw).byteLength > MAX_KEYMAP_JSON_BYTES) {
    return { ok: false, diagnostic: "oversized" }
  }
  const decoded = decodeStoredOption(raw)
  if (Option.isSome(decoded)) {
    const stored = decoded.value
    return Number.isSafeInteger(stored.revision) && stored.revision >= 0
      ? { ok: true, stored }
      : { ok: false, diagnostic: "invalid-storage" }
  }
  const version = decodeStoredVersionOption(raw)
  return Option.isSome(version) && version.value.profile.version > KEYMAP_PROFILE_VERSION
    ? { ok: false, diagnostic: "newer-version" }
    : { ok: false, diagnostic: "invalid-storage" }
}

export function loadKeymapSettings(
  storage: KeymapStorage,
  defaults: KeymapDefaultCatalog,
  platform: KeymapPlatform,
): LoadedKeymapSettings {
  let raw: string | null
  try {
    raw = storage.getItem(KEYMAP_STORAGE_KEY)
  } catch {
    return fallback(defaults, "storage-denied")
  }
  if (raw === null) return fallback(defaults)
  const decoded = decodeStoredKeymapJson(raw)
  if (!decoded.ok) return fallback(defaults, decoded.diagnostic)
  const compiled = compileKeymap(defaults, decoded.stored.profile, platform)
  if (!compiled.ok) return fallback(defaults, "compile-conflict")
  return {
    ...decoded.stored,
    effectiveKeymap: compiled.keymap,
  }
}

export function persistKeymapSettings(
  storage: KeymapStorage,
  profile: KeymapProfile,
  previousRevision: number,
  now = Date.now(),
):
  | { readonly ok: true; readonly revision: number; readonly serialized: string }
  | { readonly ok: false; readonly diagnostic: "oversized" | "storage-denied" } {
  const revision = Math.max(previousRevision + 1, Math.trunc(now))
  const serialized = JSON.stringify({ revision, profile })
  if (new TextEncoder().encode(serialized).byteLength > MAX_KEYMAP_JSON_BYTES) {
    return { ok: false, diagnostic: "oversized" }
  }
  try {
    storage.setItem(KEYMAP_STORAGE_KEY, serialized)
    return { ok: true, revision, serialized }
  } catch {
    return { ok: false, diagnostic: "storage-denied" }
  }
}

export function shouldApplyStoredKeymap(
  currentRevision: number,
  incoming: StoredKeymapProfile,
): boolean {
  return incoming.revision > currentRevision
}
