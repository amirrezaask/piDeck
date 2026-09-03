import { lazy, Suspense, useEffect } from "react"
import { clientSurface } from "./routes.js"

const AgentSurface = lazy(() => import("./agent-surface.js"))
const TaskSurface = lazy(() => import("./task-surface.js"))
const TerminalSurface = lazy(() => import("./terminal-surface.js"))

function DefaultRoute() {
  useEffect(() => {
    window.location.replace("/agents")
  }, [])
  return null
}

export function App() {
  const surface = clientSurface(window.location.pathname)

  return (
    <Suspense fallback={<div role="status" aria-label="Loading client" />}>
      {surface === "agents" ? <AgentSurface /> : null}
      {surface === "tasks" ? <TaskSurface /> : null}
      {surface === "terminals" ? <TerminalSurface /> : null}
      {surface === "redirect" ? <DefaultRoute /> : null}
    </Suspense>
  )
}
