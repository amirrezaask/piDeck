let observer: MutationObserver | null = null
const subscribers = new Set<() => void>()

function ensure(): void {
  if (observer) return
  observer = new MutationObserver(() => {
    for (const cb of subscribers) cb()
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class"],
  })
}

/** Subscribe to `document.documentElement[style]` mutations via a single shared observer. */
export function subscribeRootStyle(cb: () => void): () => void {
  ensure()
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
    if (subscribers.size === 0 && observer) {
      observer.disconnect()
      observer = null
    }
  }
}
