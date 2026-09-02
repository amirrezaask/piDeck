let waitingWorker: ServiceWorker | null = null
let reloadForUpdate = false

export function registerPwa(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadForUpdate) location.reload()
  })

  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(registration => {
    const announceWaiting = () => {
      if (!registration.waiting) return
      waitingWorker = registration.waiting
      window.dispatchEvent(new Event("yaade:pwa-update"))
    }

    announceWaiting()
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing
      if (!installing) return
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          announceWaiting()
        }
      })
    })

    const checkForUpdate = () => {
      if (document.visibilityState === "visible") void registration.update()
    }
    document.addEventListener("visibilitychange", checkForUpdate)
  }).catch(() => {
    // A service worker is progressive enhancement. The live host remains usable.
  })
}

export function isPwaUpdateReady(): boolean {
  return waitingWorker !== null
}

export function applyPwaUpdate(): void {
  if (!waitingWorker) return
  reloadForUpdate = true
  waitingWorker.postMessage("SKIP_WAITING")
}
