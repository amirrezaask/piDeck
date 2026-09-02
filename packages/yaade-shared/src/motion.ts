/** Non-React reduced-motion probe (CodeMirror plugins, layout morph rAF). */
export function prefersReducedMotion(): boolean {
  const g = globalThis as typeof globalThis & {
    matchMedia?: (query: string) => { matches: boolean; addEventListener?: (type: string, fn: () => void) => void; removeEventListener?: (type: string, fn: () => void) => void }
    document?: { documentElement: { dataset: Record<string, string | undefined> } }
  }
  const override = g.document?.documentElement.dataset.yaadeReducedMotion
  if (override === "true") return true
  if (override === "false") return false
  if (typeof g.matchMedia !== "function") return false
  return g.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function onReducedMotionChange(listener: (reduced: boolean) => void): () => void {
  const g = globalThis as typeof globalThis & {
    matchMedia?: (query: string) => {
      matches: boolean
      addEventListener: (type: string, fn: () => void) => void
      removeEventListener: (type: string, fn: () => void) => void
    }
    document?: { documentElement: { dataset: Record<string, string | undefined> } }
    MutationObserver?: new (callback: () => void) => {
      observe(target: unknown, options: { attributes: boolean; attributeFilter: string[] }): void
      disconnect(): void
    }
  }
  const mq = typeof g.matchMedia === "function"
    ? g.matchMedia("(prefers-reduced-motion: reduce)")
    : null
  const handler = () => listener(prefersReducedMotion())
  mq?.addEventListener("change", handler)
  const root = g.document?.documentElement
  const observer = root && g.MutationObserver
    ? new g.MutationObserver(handler)
    : null
  observer?.observe(root!, {
    attributes: true,
    attributeFilter: ["data-yaade-reduced-motion", "data-yaade-reduced-motion"],
  })
  return () => {
    mq?.removeEventListener("change", handler)
    observer?.disconnect()
  }
}
