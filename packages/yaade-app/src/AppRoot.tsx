import { lazy, Suspense, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@yaade/ui/primitives"
import { basicTestBridge } from "./basic-test-bridge.js"
import { TerminalMultiplexer } from "./mux/TerminalMultiplexer.js"
import { applyPwaUpdate, isPwaUpdateReady } from "./pwa.js"

const GlassMaterialGallery = lazy(() => import("@yaade/ui/gallery"))

/** The Session shell is now the only browser app surface. */
export function AppRoot() {
  const [updateReady, setUpdateReady] = useState(isPwaUpdateReady)
  window.__yaadeTest ??= basicTestBridge()

  useEffect(() => {
    return () => {
      delete window.__yaadeTest
    }
  }, [])

  useEffect(() => {
    const onUpdate = () => setUpdateReady(true)
    if (isPwaUpdateReady()) onUpdate()
    window.addEventListener("yaade:pwa-update", onUpdate)
    return () => window.removeEventListener("yaade:pwa-update", onUpdate)
  }, [])

  if (location.pathname === "/__yaade/glass-gallery") {
    return (
      <Suspense fallback={null}>
        <GlassMaterialGallery />
      </Suspense>
    )
  }
  return (
    <>
      <TerminalMultiplexer />
      {updateReady ? (
        <aside
          className="yaade-pwa-update fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-sm items-center gap-3 rounded-[var(--yaade-island-radius)] border border-border bg-popover/95 p-2 pl-3 text-popover-foreground shadow-xl backdrop-blur-xl"
          role="status"
          data-yaade-pwa-update=""
        >
          <p className="min-w-0 flex-1 text-xs">A YAADE update is ready.</p>
          <Button
            type="button"
            size="sm"
            onClick={applyPwaUpdate}
          >
            <RefreshCw data-icon="inline-start" />
            Reload
          </Button>
        </aside>
      ) : null}
    </>
  )
}
