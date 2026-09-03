import { describe, expect, it } from "vitest"
import { clientSurface } from "./routes.js"

describe("unified client routing", () => {
  it.each([
    ["/agents", "agents"],
    ["/agents/new", "agents"],
    ["/tasks", "tasks"],
    ["/tasks/projects/project-1", "tasks"],
    ["/terminals", "terminals"],
    ["/terminals/session", "terminals"],
    ["/__yaade/glass-gallery", "terminals"],
    ["/", "redirect"],
    ["/unknown", "redirect"],
  ] as const)("maps %s to %s", (pathname, expected) => {
    expect(clientSurface(pathname)).toBe(expected)
  })
})
