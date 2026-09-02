import { expect } from "@playwright/test"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { test } from "../../fixtures/e2e.js"
import { pressMuxPrefix } from "./_launch.js"

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's address API returns a documented string/object union.
      if (!address || typeof address === "string") {
        reject(new Error("could not allocate a port"))
        return
      }
      server.close(error => (error ? reject(error) : resolve(address.port)))
    })
  })
}

async function waitForHealth(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("remote host exited before startup")
    try {
      if ((await fetch(`${url}/terminal/health`)).ok) return
    } catch {
      // The host is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error("remote host did not become healthy")
}

async function startRemoteHost(): Promise<{
  readonly urls: readonly string[]
  readonly close: () => Promise<void>
}> {
  const port = await freePort()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-remote-e2e-"))
  const dataDir = path.join(root, "data")
  const url = `http://127.0.0.1:${port}`
  const token = "remote-e2e-token"
  const hostExecutable = path.join(
    process.cwd(),
    process.platform === "win32"
      ? "apps/server/target/debug/yaade.exe"
      : "apps/server/target/debug/yaade",
  )
  const child = spawn(
    hostExecutable,
    [
      "serve",
      root,
      "--host",
      "0.0.0.0",
      "--port",
      String(port),
      "--data-dir",
      dataDir,
      "--token",
      token,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        YAADE_ALLOWED_ROOTS: root,
        YAADE_CORS_ORIGINS: "*",
      },
      stdio: "ignore",
    },
  )
  await waitForHealth(url, child)
  const response = await fetch(`${url}/terminal/api/v1/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel: "mux:createSession",
      args: ["Remote session"],
      clientId: "server-connections-e2e",
    }),
  })
  if (!response.ok) throw new Error(`could not create remote session (${response.status})`)

  return {
    urls: [url, `http://localhost:${port}`],
    close: async () => {
      if (child.exitCode === null) child.kill("SIGTERM")
      await new Promise<void>(resolve => {
        if (child.exitCode !== null) {
          resolve()
          return
        }
        child.once("exit", () => resolve())
        setTimeout(resolve, 2_000)
      })
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

test("settings manage multiple remote server definitions and aggregate sessions", async ({ launchApp }) => {
  const remote = await startRemoteHost()
  let closeApp: (() => Promise<void>) | undefined
  try {
    const launched = await launchApp({ withTerminal: false })
    closeApp = () => launched.app.close()
    const { page } = launched
    await page.getByRole("button", { name: "Settings" }).click()
    await expect(page.locator("[data-yaade-settings-overlay]")).toBeVisible()
    await page.getByRole("tab", { name: "Servers" }).click()

    const panel = page.locator('[data-yaade-server-settings=""]')
    await expect(panel.getByText("No remote servers yet.", { exact: false })).toBeVisible()
    const addServer = async (name: string, url: string) => {
      await panel.getByRole("button", { name: "Add server" }).click()
      await page.locator("#yaade-server-name").fill(name)
      await page.locator("#yaade-server-url").fill(url)
      await page.locator("#yaade-server-token").fill("remote-e2e-token")
      await page.getByRole("button", { name: "Save server" }).click()
    }

    await addServer("Build machine", remote.urls[0]!)
    await expect(panel.getByText("1 configured", { exact: true })).toBeVisible()
    await addServer("Staging machine", remote.urls[1]!)

    await expect(panel.locator('[data-yaade-server]')).toHaveCount(2)
    await expect(panel.getByText("Build machine", { exact: true })).toBeVisible()
    await expect(panel.getByText("Staging machine", { exact: true })).toBeVisible()
    await expect(panel.getByText("2 configured", { exact: true })).toBeVisible()
    await expect(panel.locator('[data-yaade-server] [data-variant="success"]')).toHaveCount(2)

    await page.getByRole("button", { name: /Close settings/ }).click()
    const switcher = page.getByRole("button", { name: /Switch session/ })
    await switcher.click()
    const remoteSessions = page.locator('[data-yaade-palette-surface="sessions"] [role="option"]')
    await expect.poll(() => remoteSessions.count()).toBeGreaterThanOrEqual(3)
    await expect(remoteSessions.getByText("Build machine").first()).toBeVisible()
    await expect(remoteSessions.getByText("Staging machine").first()).toBeVisible()

    await remoteSessions.filter({ hasText: "Build machine" }).first().click()
    await expect(page.locator('[data-yaade-palette-surface="sessions"]')).toHaveCount(0)
    await expect(page.locator('[data-yaade-shell="terminal-multiplexer"]')).toBeVisible()
    await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible({ timeout: 30_000 })

    await pressMuxPrefix(page, "u")
    const terminals = page.locator('[data-yaade-palette-surface="terminals"]')
    await expect(terminals).toBeVisible()
    await expect(terminals.getByText("Build machine", { exact: false }).first()).toBeVisible()
    await expect(terminals.getByText("Staging machine", { exact: false }).first()).toBeVisible()
    const qualifiedIds = await terminals
      .locator("[data-yaade-terminal-switcher-terminal]")
      .evaluateAll(rows => rows.map(row => row.getAttribute("data-yaade-terminal-switcher-terminal")))
    expect(new Set(qualifiedIds).size).toBe(qualifiedIds.length)
  } finally {
    if (closeApp) await closeApp().catch(() => undefined)
    await remote.close()
  }
})
