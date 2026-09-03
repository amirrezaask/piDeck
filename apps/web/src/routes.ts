export type ClientSurface = "agents" | "tasks" | "terminals" | "redirect"

export function clientSurface(pathname: string): ClientSurface {
  if (pathname === "/agents" || pathname.startsWith("/agents/")) return "agents"
  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) return "tasks"
  if (
    pathname === "/terminals" ||
    pathname.startsWith("/terminals/") ||
    pathname.startsWith("/__yaade/")
  ) {
    return "terminals"
  }
  return "redirect"
}
