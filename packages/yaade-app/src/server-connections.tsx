import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import type { YaadeServerDefinition } from "@yaade/shared"
import {
  saveStoredServerDefinitions,
  type MultiServerHostClient,
  type MultiServerSnapshot,
  type ServerTestResult,
} from "@yaade/host-client"

export type ServerConnectionsContextValue = {
  readonly manager: MultiServerHostClient
  readonly snapshot: MultiServerSnapshot
  readonly servers: readonly YaadeServerDefinition[]
  readonly updateServers: (servers: readonly YaadeServerDefinition[]) => void
  readonly testServer: (server: YaadeServerDefinition) => Promise<ServerTestResult>
}

const ServerConnectionsContext = createContext<ServerConnectionsContextValue | null>(null)

function saveClientServerDefinitions(
  servers: readonly YaadeServerDefinition[],
): void {
  saveStoredServerDefinitions(servers)
}

export function ServerConnectionsProvider(props: {
  readonly manager: MultiServerHostClient
  readonly children: ReactNode
}) {
  const snapshot = useSyncExternalStore(
    props.manager.subscribe,
    props.manager.getSnapshot,
    props.manager.getSnapshot,
  )
  const [servers, setServers] = useState<readonly YaadeServerDefinition[]>(() =>
    props.manager.getServerDefinitions(),
  )

  const updateServers = useCallback(
    (next: readonly YaadeServerDefinition[]) => {
      setServers([...next])
      props.manager.setServers(next)
      saveClientServerDefinitions(next)
    },
    [props.manager],
  )
  const testServer = useCallback(
    (server: YaadeServerDefinition) => props.manager.testServer(server),
    [props.manager],
  )
  const value = useMemo<ServerConnectionsContextValue>(
    () => ({ manager: props.manager, snapshot, servers, updateServers, testServer }),
    [props.manager, servers, snapshot, testServer, updateServers],
  )

  return (
    <ServerConnectionsContext.Provider value={value}>
      {props.children}
    </ServerConnectionsContext.Provider>
  )
}

export function useServerConnections(): ServerConnectionsContextValue {
  const value = useContext(ServerConnectionsContext)
  if (!value) throw new Error("Server connections are unavailable")
  return value
}
