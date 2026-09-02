/** Minimal DOM root accessor — safe for Node typecheck of @yaade/shared. */
type CssRoot = {
  style: { setProperty(name: string, value: string): void }
  classList: { toggle(token: string, force?: boolean): boolean }
  dataset: Record<string, string | undefined>
}

export function getDocumentElement(): CssRoot | null {
  const doc = (globalThis as { document?: { documentElement?: CssRoot } }).document
  return doc?.documentElement ?? null
}
