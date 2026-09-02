import type { EffectiveKeymap } from "./keymap-profile.js"

let activeKeymap: EffectiveKeymap | null = null

export function installEffectiveKeymap(keymap: EffectiveKeymap): void {
  activeKeymap = keymap
}

export function readEffectiveKeymap(): EffectiveKeymap | null {
  return activeKeymap
}

/** Test-only reset; production always replaces snapshots atomically. */
export function resetEffectiveKeymap(): void {
  activeKeymap = null
}
