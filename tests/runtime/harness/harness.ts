import { chromium, type BrowserContext, type Page } from "@playwright/test"
import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ApiHandle, BrowserHandle } from "./types.js"
import { waitForHttpOk, waitUntil } from "./wait.js"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const HOST_SERVER_ENTRY = path.join(
  REPO_ROOT,
  process.platform === "win32"
    ? "apps/server/target/debug/yaade.exe"
    : "apps/server/target/debug/yaade",
)
type TestServerProcess = ChildProcessByStdio<null, Readable, Readable>

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's address API returns a documented string/object union.
      if (!address || typeof address === "string") return reject(new Error("no test port"))
      server.close(error => (error ? reject(error) : resolve(address.port)))
    })
  })
}

function attachLogs(proc: TestServerProcess): () => string {
  let logs = ""
  proc.stdout.on("data", chunk => { logs += chunk.toString() })
  proc.stderr.on("data", chunk => { logs += chunk.toString() })
  return () => logs
}

async function waitForExit(proc: TestServerProcess, timeoutMs: number): Promise<void> {
  if (proc.exitCode !== null) return
  await new Promise<void>(resolve => {
    const force = setTimeout(resolve, timeoutMs)
    proc.once("exit", () => {
      clearTimeout(force)
      resolve()
    })
  })
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone */
  }
}

export type DurableRuntimeHarness = {
  readonly root: string
  readonly dataDir: string
  readonly workspace: string
  readonly origin: string
  readonly port: number
  api: ApiHandle | null
  startApi(): Promise<ApiHandle>
  stopApi(signal?: NodeJS.Signals): Promise<void>
  restartApi(signal?: NodeJS.Signals): Promise<ApiHandle>
  startBrowser(userDataDir?: string, startPath?: string): Promise<BrowserHandle>
  retainDiagnostics(outputDir: string): Promise<void>
  close(): Promise<void>
}

export async function createDurableRuntimeHarness(
  options: { env?: Record<string, string> } = {},
): Promise<DurableRuntimeHarness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-runtime-e2e-"))
  const dataDir = path.join(root, "data")
  const workspace = path.join(root, "workspace")
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, "README.md"), "runtime e2e workspace\n")
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const browsers: BrowserHandle[] = []
  let apiProc: TestServerProcess | null = null
  let apiLogs = () => ""
  let apiHandle: ApiHandle | null = null
  let closed = false

  const sharedEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    YAADE_ALLOWED_ROOTS: `${REPO_ROOT},${root}`,
    YAADE_E2E: "1",
    YAADE_STATIC_DIR: path.join(REPO_ROOT, "apps/web/dist"),
    ...(process.platform === "win32" ? {} : { SHELL: "/bin/sh" }),
    ...options.env,
  })
  const hostToken = options.env?.YAADE_HOST_TOKEN

  const spawnApi = (): TestServerProcess => spawn(
    HOST_SERVER_ENTRY,
    [
      "serve",
      "--host", "127.0.0.1",
      "--port", String(port),
      "--data-dir", dataDir,
      "--allowed-roots", `${REPO_ROOT},${root}`,
      ...(hostToken ? ["--token", hostToken] : []),
      workspace,
    ],
    {
      cwd: REPO_ROOT,
      env: sharedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  )

  const waitForApiDown = async (): Promise<void> => {
    await waitUntil(async () => {
      try {
        return !(await fetch(`${origin}/terminal/health`)).ok
      } catch {
        return true
      }
    }, 8_000, "API port to close")
  }

  const startApi = async (): Promise<ApiHandle> => {
    if (apiProc && apiProc.exitCode === null && apiHandle) return apiHandle
    if (apiProc) await waitForApiDown()
    apiProc = spawnApi()
    apiLogs = attachLogs(apiProc)
    await new Promise<void>((resolve, reject) => {
      const proc = apiProc
      if (!proc) return reject(new Error("API process missing"))
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        reject(new Error(`API exited during startup (${code ?? signal}): ${apiLogs()}`))
      }
      proc.once("exit", onExit)
      void waitForHttpOk(`${origin}/terminal/health`, 30_000).then(
        () => { proc.off("exit", onExit); resolve() },
        error => { proc.off("exit", onExit); reject(error) },
      )
    })
    const pid = apiProc.pid
    if (!pid) throw new Error("API process has no pid")
    apiHandle = { pid, port, origin, dataDir, logs: apiLogs }
    harness.api = apiHandle
    return apiHandle
  }

  const stopApi = async (signal: NodeJS.Signals = "SIGTERM"): Promise<void> => {
    if (!apiProc?.pid || apiProc.exitCode !== null) {
      apiHandle = null
      harness.api = null
      return
    }
    signalPid(apiProc.pid, signal)
    await waitForExit(apiProc, 8_000)
    if (apiProc.exitCode === null) signalPid(apiProc.pid, "SIGKILL")
    await waitForExit(apiProc, 2_000)
    await waitForApiDown()
    apiHandle = null
    harness.api = null
  }

  const killApi = async (): Promise<void> => {
    if (!apiProc?.pid || apiProc.exitCode !== null) {
      apiHandle = null
      harness.api = null
      return
    }
    signalPid(apiProc.pid, "SIGTERM")
    await waitForExit(apiProc, 8_000)
    if (apiProc.exitCode === null) signalPid(apiProc.pid, "SIGKILL")
    await waitForExit(apiProc, 2_000)
    apiHandle = null
    harness.api = null
  }

  const startBrowser = async (
    userDataDir?: string,
    startPath = "/terminals",
  ): Promise<BrowserHandle> => {
    if (!apiHandle) {
      try {
        if ((await fetch(`${origin}/terminal/health`)).ok) {
          apiHandle = { pid: 0, port, origin, dataDir, logs: () => "" }
          harness.api = apiHandle
        } else {
          await startApi()
        }
      } catch {
        await startApi()
      }
    }
    const browserDir = userDataDir ?? fs.mkdtempSync(path.join(root, "browser-"))
    fs.mkdirSync(browserDir, { recursive: true })
    const context: BrowserContext = await chromium.launchPersistentContext(browserDir, {
      headless: process.env.YAADE_HEADED !== "1",
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "dark",
      serviceWorkers: "block",
    })
    const page: Page = context.pages()[0] ?? (await context.newPage())
    const startUrl = `${origin}${startPath.startsWith("/") ? startPath : `/${startPath}`}`
    await page.goto(startUrl, { waitUntil: "domcontentloaded" })
    await page.waitForFunction(() => window.__yaadeTest != null, null, { timeout: 30_000 })
    const requestedSession = new URL(startUrl).searchParams.get("s")
    await page.evaluate(() => window.__yaadeTest!.waitForReady())
    if (requestedSession) {
      await page.waitForFunction(
        expected => {
          const attr = document.querySelector("[data-yaade-session-switcher]")
            ?.getAttribute("data-yaade-active-session") ?? ""
          return Boolean(attr && expected && (attr === expected || attr.endsWith(expected.replace(/^ses-/, ""))))
        },
        requestedSession,
        { timeout: 30_000 },
      )
    }
    const handle: BrowserHandle = {
      page,
      context,
      userDataDir: browserDir,
      close: async () => { await context.close().catch(() => undefined) },
    }
    browsers.push(handle)
    return handle
  }

  const harness: DurableRuntimeHarness = {
    root,
    dataDir,
    workspace,
    origin,
    port,
    api: null,
    startApi,
    stopApi,
    restartApi: async signal => {
      await stopApi(signal)
      return startApi()
    },
    startBrowser,
    retainDiagnostics: async outputDir => {
      fs.mkdirSync(outputDir, { recursive: true })
      fs.writeFileSync(path.join(outputDir, "api.log"), apiLogs())
      for (const name of ["runtime.json", "yaade.sqlite3", "yaade.sqlite3-wal", "yaade.sqlite3-shm"]) {
        const source = path.join(dataDir, name)
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(outputDir, name))
      }
    },
    close: async () => {
      if (closed) return
      closed = true
      for (const browser of browsers.reverse()) await browser.close().catch(() => undefined)
      await killApi()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }

  return harness
}
