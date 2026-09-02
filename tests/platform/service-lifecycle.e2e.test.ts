import { expect, test } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { waitUntil } from "../runtime/harness/wait.js"
import { createDurableRuntimeHarness } from "../runtime/harness/index.js"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const RUST_HOST_ENTRY = path.join(
  REPO_ROOT,
  process.platform === "win32"
    ? "apps/server/target/debug/yaade.exe"
    : "apps/server/target/debug/yaade",
)

type ServiceOptions = {
  readonly dataDir: string
  readonly serviceName: string
  readonly args: readonly string[]
}

type ServiceStatus = {
  readonly installed: boolean
  readonly running: boolean
  readonly message: string
}

function servicePath(serviceName: string): string {
  if (process.platform === "linux") {
    return path.join(os.homedir(), ".config", "systemd", "user", `${serviceName}.service`)
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "LaunchAgents", `${serviceName}.plist`)
  }
  return path.join(os.homedir(), "AppData", "Local", "YAADE", `${serviceName}.xml`)
}

async function serviceCommand(
  action: "install" | "uninstall" | "start" | "stop",
  options: ServiceOptions,
): Promise<ServiceStatus> {
  const child = spawn(
    RUST_HOST_ENTRY,
    [action, "--service-name", options.serviceName, ...options.args],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  )
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", chunk => { stdout += chunk.toString() })
  child.stderr.on("data", chunk => { stderr += chunk.toString() })
  const code = await new Promise<number | null>(resolve => child.once("exit", resolve))
  if (code !== 0) throw new Error(`Rust service ${action} failed (${code}): ${stderr}`)
  // SAFETY: the Rust CLI serializes UserServiceStatus for every service command.
  return JSON.parse(stdout) as ServiceStatus
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's address API returns a documented string/object union.
      if (!address || typeof address === "string") {
        return reject(new Error("no test port"))
      }
      server.close(error => (error ? reject(error) : resolve(address.port)))
    })
  })
}

test.describe("O — service lifecycle", { tag: "@p2" }, () => {
  test("O01 user-service install/start/status/stop/uninstall leaves user data", async ({ page: _page }, testInfo) => {
    test.skip(Boolean(process.env.CI) && !process.env.YAADE_SERVICE_E2E, "user-service install is release/cross-platform, not pull-request CI")
    test.skip(process.platform === "win32" && !process.env.YAADE_SERVICE_E2E, "Windows scheduled-task install needs an interactive runner")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-service-e2e-"))
    const dataDir = path.join(root, "data")
    const workspace = path.join(root, "workspace")
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(workspace, { recursive: true })
    const marker = path.join(dataDir, "user-marker.txt")
    fs.writeFileSync(marker, "keep\n")
    const port = await freePort()
    const serviceName = `com.yaade.e2e.${randomUUID().slice(0, 8)}`
    const options: ServiceOptions = {
      dataDir,
      serviceName,
      args: [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--data-dir",
        dataDir,
        "--allowed-roots",
        `${REPO_ROOT},${root}`,
        "--static-dir",
        path.join(REPO_ROOT, "apps/web/dist"),
        workspace,
      ],
    }
    try {
      const installed = await serviceCommand("install", options)
      expect(installed.installed).toBe(true)
      expect(fs.existsSync(servicePath(serviceName))).toBe(true)
      if (!installed.running) {
        test.skip(true, `platform service manager did not start the unit: ${installed.message}`)
      }
      await waitUntil(
        () => fs.existsSync(path.join(dataDir, "runtime.json")),
        20_000,
        "runtime manifest after install",
      )
      await serviceCommand("stop", options)
      expect(fs.readFileSync(marker, "utf8")).toBe("keep\n")
      await serviceCommand("start", options)
      await waitUntil(
        () => fs.existsSync(path.join(dataDir, "runtime.json")),
        20_000,
        "runtime manifest after restart",
      )
    } catch (error) {
      await testInfo.attach("service-data", {
        body: fs.existsSync(dataDir) ? fs.readdirSync(dataDir).join("\n") : "missing",
        contentType: "text/plain",
      }).catch(() => undefined)
      throw error
    } finally {
      await serviceCommand("uninstall", options)
      expect(fs.existsSync(servicePath(serviceName))).toBe(false)
      expect(fs.readFileSync(marker, "utf8")).toBe("keep\n")
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("O02 client discovers an auto-started daemon", async ({ page: _page }, testInfo) => {
    test.skip(Boolean(process.env.CI) && !process.env.YAADE_SERVICE_E2E, "user-service install is release/cross-platform, not pull-request CI")
    test.skip(process.platform === "win32" && !process.env.YAADE_SERVICE_E2E, "Windows scheduled-task install needs an interactive runner")
    const harness = await createDurableRuntimeHarness()
    const port = harness.port
    const serviceName = `com.yaade.e2e.${randomUUID().slice(0, 8)}`
    const options: ServiceOptions = {
      dataDir: harness.dataDir,
      serviceName,
      args: [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--data-dir",
        harness.dataDir,
        "--allowed-roots",
        `${REPO_ROOT},${harness.root}`,
        "--static-dir",
        path.join(REPO_ROOT, "apps/web/dist"),
        harness.workspace,
      ],
    }
    try {
      const installed = await serviceCommand("install", options)
      if (!installed.running) {
        test.skip(true, `platform service manager did not start the unit: ${installed.message}`)
      }
      await waitUntil(
        () => fs.existsSync(path.join(harness.dataDir, "runtime.json")),
        20_000,
        "auto-started runtime manifest",
      )
      await waitUntil(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/terminal/health`)
          return response.ok
        } catch {
          return false
        }
      }, 20_000, "auto-started daemon health")
      // SAFETY: runtime.json is emitted by the Rust host and the assertions below validate the fields used here.
      const manifest = JSON.parse(
        fs.readFileSync(path.join(harness.dataDir, "runtime.json"), "utf8"),
      ) as { serverId?: string; port?: number }
      expect(manifest.port).toBe(port)
      expect(manifest.serverId).toBeTruthy()
      const browser = await harness.startBrowser()
      await browser.page.waitForFunction(() => window.__yaadeTest != null, null, {
        timeout: 30_000,
      })
      const health = await fetch(`http://127.0.0.1:${port}/terminal/health`)
      expect(health.ok).toBe(true)
      // SAFETY: this is the host's typed health endpoint and only its asserted identity field is consumed.
      const body = (await health.json()) as { identity?: { serverId?: string } }
      expect(body.identity?.serverId).toBe(manifest.serverId)
    } catch (error) {
      await harness.retainDiagnostics(testInfo.outputDir).catch(() => undefined)
      throw error
    } finally {
      await serviceCommand("uninstall", options)
      await harness.close()
    }
  })
})
