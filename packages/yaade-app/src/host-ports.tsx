import { createContext, useContext, type ReactNode } from "react"
import type { YaadeHostPorts } from "@yaade/workspace"

const HostPortsContext = createContext<YaadeHostPorts | null>(null)

export function HostPortsProvider(props: {
  readonly ports: YaadeHostPorts
  readonly children: ReactNode
}) {
  return (
    <HostPortsContext.Provider value={props.ports}>
      {props.children}
    </HostPortsContext.Provider>
  )
}

export function useHostPorts(): YaadeHostPorts {
  const ports = useContext(HostPortsContext)
  if (!ports) throw new Error("Host ports are unavailable")
  return ports
}
