import { useEffect } from "react"
import {
  createMultiServerHostClient,
  consumeHostAuthTokenFromLocation,
  loadStoredServerDefinitions,
} from "@yaade/host-client"
import "@yaade/ui/styles.css"
import { AppErrorBoundary } from "./AppErrorBoundary.js"
import { AppRoot } from "./AppRoot.js"
import { isDesktopClient, resolveCurrentHostUrl } from "./client-environment.js"
import { HostPortsProvider } from "./host-ports.js"
import { applyInitialAppearance } from "./hooks/useAppearanceSettings.js"
import { registerPwa } from "./pwa.js"
import { ServerConnectionsProvider } from "./server-connections.js"

const startupWindow = window as Window & { __yaadeStartupBootstrapAt?: number }
startupWindow.__yaadeStartupBootstrapAt ??= performance.now()
consumeHostAuthTokenFromLocation()
applyInitialAppearance()

const currentServer = {
  id: "current-host",
  name: "This client",
  url: resolveCurrentHostUrl(window.location),
}
const serverConnections = createMultiServerHostClient({
  currentServer,
  servers: loadStoredServerDefinitions(),
  globalTarget: {
    setYaade: value => {
      window.yaade = value
    },
  },
})
window.yaade = serverConnections.ports

let pwaRegistered = false

/** Complete terminal client surface for embedding in the unified browser client. */
export function TerminalClient() {
  useEffect(() => {
    if (pwaRegistered || isDesktopClient(window.location)) return
    pwaRegistered = true
    registerPwa()
  }, [])

  return (
    <ServerConnectionsProvider manager={serverConnections}>
      <HostPortsProvider ports={serverConnections.ports}>
        <AppErrorBoundary>
          <AppRoot />
        </AppErrorBoundary>
      </HostPortsProvider>
    </ServerConnectionsProvider>
  )
}
