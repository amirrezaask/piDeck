import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@yaade/ui/styles.css"
import { AppRoot } from "./AppRoot.js"
import { HostPortsProvider } from "./host-ports.js"
import { AppErrorBoundary } from "./AppErrorBoundary.js"
import {
  createMultiServerHostClient,
  consumeHostAuthTokenFromLocation,
  loadStoredServerDefinitions,
} from "@yaade/host-client"
import { applyInitialAppearance } from "./hooks/useAppearanceSettings.js"
import { registerPwa } from "./pwa.js"
import { ServerConnectionsProvider } from "./server-connections.js"
import { isDesktopClient, resolveCurrentHostUrl } from "./client-environment.js"

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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ServerConnectionsProvider manager={serverConnections}>
      <HostPortsProvider ports={serverConnections.ports}>
        <AppErrorBoundary>
          <AppRoot />
        </AppErrorBoundary>
      </HostPortsProvider>
    </ServerConnectionsProvider>
  </StrictMode>,
)

if (!isDesktopClient(window.location)) registerPwa()
