import { chromium, test } from "@playwright/test"
import { serverArtifactPath } from "./server-artifact.js"
import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { wrapPlaywrightPage } from "./playwright-driver.js"
import type { LaunchShellResult } from "./driver.js"

const REPO_ROOT = path.resolve(__dirname, "../..")

export type LaunchWebOptions = {
  workspaceRel?: string
  /** Launch Chromium with touch/coarse-pointer media queries enabled. */
  mobile?: boolean
  env?: Record<string, string>
  userDataDir?: string
  launchWithoutWorkspace?: boolean
  /** Allow AppRoot to stop at its actionable route error screen. */
  expectBootError?: boolean
  /** Wait for the initial terminal surface. Defaults to true on terminal routes. */
  withTerminal?: boolean
  /** Browser pathname to open. Defaults to the terminal multiplexer root. */
  startPath?: string
  /**
   * When set, host `HOME` is this directory so URL paths resolve under it.
   * Defaults to a temp dir under the e2e root when `startPath` is non-root.
   */
  homeDir?: string
  /** Narrow allowlist for tests that intentionally request an HTTP error. */
  expectedHttpErrors?: Array<{
    method: string
    path: string
    status: number
  }>
}

type BrowserFailure = {
  kind: "console" | "pageerror" | "requestfailed" | "http"
  message: string
  url?: string
  method?: string
  status?: number
  navigationRelated?: boolean
}

const EXPECTED_BROWSER_MESSAGES = [
  /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)\.?$/,
]

function urlPathname(value: string | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value).pathname
  } catch {
    return null
  }
}

function isExpectedBrowserFailure(
  failure: BrowserFailure,
  expectedHttpErrors: LaunchWebOptions["expectedHttpErrors"],
): boolean {
  const firstLine = failure.message.split("\n", 1)[0]?.replace(/^Error: /, "") ?? ""
  if (EXPECTED_BROWSER_MESSAGES.some((pattern) => pattern.test(firstLine))) return true
  if (
    failure.kind === "requestfailed" &&
    failure.navigationRelated === true &&
    failure.message === "net::ERR_ABORTED"
  ) {
    return true
  }
  const path = urlPathname(failure.url)
  if (!path) return false
  return (expectedHttpErrors ?? []).some((expected) => {
    if (expected.path !== path) return false
    if (failure.kind === "http") {
      return expected.method === failure.method && expected.status === failure.status
    }
    if (failure.kind !== "console" || !failure.message.startsWith("Failed to load resource:")) {
      return false
    }
    return failure.message.includes(String(expected.status))
  })
}

function formatBrowserFailure(failure: BrowserFailure): string {
  const request = failure.method ? ` ${failure.method}` : ""
  const status = failure.status == null ? "" : ` ${failure.status}`
  const url = failure.url ? ` ${failure.url}` : ""
  return `[${failure.kind}]${request}${status}${url}: ${failure.message}`
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const addressObject = Object(address)
      if (!address || !("port" in addressObject)) {
        return reject(new Error("no test port"))
      }
      server.close((error) => (error ? reject(error) : resolve(addressObject.port)))
    })
  })
}

type TestServerProcess = ChildProcessByStdio<null, Readable, Readable>

async function waitForHttpOk(
  url: string,
  proc: TestServerProcess,
  logs: () => string,
): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`process exited (${proc.exitCode})\n${logs()}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      /* startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${url}\n${logs()}`)
}

function attachLogs(proc: TestServerProcess): () => string {
  let logs = ""
  let omitted = 0
  const append = (chunk: Buffer) => {
    const next = logs + chunk.toString()
    const excess = Math.max(0, next.length - 64 * 1024)
    omitted += excess
    logs = next.slice(excess)
  }
  proc.stdout.on("data", append)
  proc.stderr.on("data", append)
  return () => `${omitted > 0 ? `[${omitted} earlier log characters omitted]\n` : ""}${logs}`
}

function signalProcessTree(proc: TestServerProcess, signal: NodeJS.Signals): void {
  if (proc.pid == null) return
  if (process.platform !== "win32") {
    try {
      process.kill(-proc.pid, signal)
      return
    } catch {
      /* Fall back to the wrapper when the process group is already gone. */
    }
  }
  proc.kill(signal)
}

async function killProc(proc: TestServerProcess): Promise<void> {
  if (proc.exitCode !== null) return
  signalProcessTree(proc, "SIGTERM")
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      if (proc.exitCode === null) signalProcessTree(proc, "SIGKILL")
    }, 1_000)
    proc.once("exit", () => {
      clearTimeout(force)
      resolve()
    })
    setTimeout(resolve, 2_500)
  })
  if (proc.exitCode === null) signalProcessTree(proc, "SIGKILL")
}

export async function launchWeb(options: LaunchWebOptions = {}): Promise<LaunchShellResult> {
  const hostServerEntry = serverArtifactPath(
    test.info().project.name === "bench" ? "release" : "debug",
  )
  const port = await freePort()
  const ownsTemporaryRoot = options.userDataDir == null
  const temporaryRoot =
    options.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "yaade-web-e2e-"))
  const browserData = path.join(temporaryRoot, "browser")
  const serverData = path.join(temporaryRoot, "server")
  fs.mkdirSync(browserData, { recursive: true })
  fs.mkdirSync(serverData, { recursive: true })
  const sourceWorkspace = path.resolve(
    REPO_ROOT,
    options.workspaceRel ?? "fixtures/sample-workspace",
  )
  const isFixture = sourceWorkspace.startsWith(path.join(REPO_ROOT, "fixtures") + path.sep)
  const workspace = isFixture
    ? path.join(temporaryRoot, path.basename(sourceWorkspace))
    : sourceWorkspace
  if (isFixture && !fs.existsSync(workspace))
    fs.cpSync(sourceWorkspace, workspace, { recursive: true })
  if (!fs.existsSync(hostServerEntry)) {
    throw new Error(
      `Rust host server missing at ${hostServerEntry}; run the Playwright build setup`,
    )
  }

  const sharedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    YAADE_ALLOWED_ROOTS: `${REPO_ROOT},${temporaryRoot},${path.dirname(sourceWorkspace)}`,
    YAADE_E2E: "1",
    // Installed YAADE may export YAADE_STATIC_DIR; e2e must serve the repo build.
    YAADE_STATIC_DIR: path.join(REPO_ROOT, "apps/web/dist"),
    ...(process.platform === "win32" ? {} : { SHELL: "/bin/sh" }),
    ...options.env,
  }

  const homeDir =
    options.homeDir ??
    (options.startPath && options.startPath !== "/" ? path.join(temporaryRoot, "home") : undefined)
  if (homeDir) {
    fs.mkdirSync(homeDir, { recursive: true })
    sharedEnv.HOME = homeDir
    sharedEnv.YAADE_ALLOWED_ROOTS = `${sharedEnv.YAADE_ALLOWED_ROOTS},${homeDir}`
  }

  const server: TestServerProcess = spawn(
    hostServerEntry,
    [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--data-dir",
      serverData,
      ...(options.launchWithoutWorkspace ? [] : [workspace]),
    ],
    {
      cwd: REPO_ROOT,
      env: sharedEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  )
  const yaadeLogs = attachLogs(server)
  const url = `http://127.0.0.1:${port}`
  await waitForHttpOk(`${url}/terminal/health`, server, yaadeLogs)

  const contextOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: process.env.YAADE_HEADED !== "1",
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
  }
  if (options.mobile) {
    contextOptions.hasTouch = true
    contextOptions.isMobile = true
  }
  if (process.env.YAADE_PLAYWRIGHT_CHANNEL) {
    contextOptions.channel = process.env.YAADE_PLAYWRIGHT_CHANNEL
  }
  const context = await chromium.launchPersistentContext(browserData, contextOptions)
  const browserPage = context.pages()[0] ?? (await context.newPage())
  const browserFailures: BrowserFailure[] = []
  let omittedFailures = 0
  const recordFailure = (failure: BrowserFailure) => {
    if (isExpectedBrowserFailure(failure, options.expectedHttpErrors)) return
    if (browserFailures.length >= 100) {
      omittedFailures += 1
      return
    }
    browserFailures.push({
      ...failure,
      message: failure.message.slice(0, 4096),
      url: failure.url?.slice(0, 4096),
    })
  }
  let lastMainFrameNavigationAt = 0
  browserPage.on("pageerror", (error) => {
    recordFailure({
      kind: "pageerror",
      message: error.stack ?? error.message,
    })
  })
  browserPage.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location()
      recordFailure({
        kind: "console",
        message: message.text(),
        url: location.url || undefined,
      })
    }
  })
  browserPage.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === browserPage.mainFrame()) {
      lastMainFrameNavigationAt = Date.now()
    }
  })
  browserPage.on("requestfailed", (request) => {
    recordFailure({
      kind: "requestfailed",
      message: request.failure()?.errorText ?? "request failed",
      url: request.url(),
      method: request.method(),
      navigationRelated: Date.now() - lastMainFrameNavigationAt < 1_000,
    })
  })
  browserPage.on("response", (response) => {
    if (response.status() < 400) return
    recordFailure({
      kind: "http",
      message: response.statusText(),
      url: response.url(),
      method: response.request().method(),
      status: response.status(),
    })
  })

  const startPath = options.startPath ?? "/terminals"
  const startUrl = `${url}${startPath.startsWith("/") ? startPath : `/${startPath}`}`
  await browserPage.goto(startUrl, { waitUntil: "domcontentloaded" })
  if (options.expectBootError) {
    await browserPage.locator('[data-yaade-boot="error"]').waitFor({
      state: "visible",
      timeout: 30_000,
    })
  } else {
    await browserPage.waitForFunction(() => window.__yaadeTest != null, null, { timeout: 30_000 })
    await browserPage.evaluate(() => window.__yaadeTest!.waitForReady())
    if (options.withTerminal !== false && startPath.startsWith("/terminals")) {
      await browserPage.locator("[data-yaade-terminal-panel]").waitFor({
        state: "visible",
        timeout: 30_000,
      })
    }
  }

  return {
    page: wrapPlaywrightPage(browserPage),
    app: {
      async close() {
        // Ignore request aborts caused by teardown itself, but only after
        // preserving every failure observed while the application was live.
        const failuresBeforeTeardown = [...browserFailures]
        const omittedBeforeTeardown = omittedFailures
        await context.close().catch(() => {})
        await killProc(server)
        if (ownsTemporaryRoot) {
          fs.rmSync(temporaryRoot, { recursive: true, force: true })
        }
        const unexpected = failuresBeforeTeardown.filter(
          (failure) => !isExpectedBrowserFailure(failure, options.expectedHttpErrors),
        )
        if (unexpected.length > 0) {
          throw new Error(
            `Unexpected browser failures (${omittedBeforeTeardown} additional failures omitted):\n${unexpected.map(formatBrowserFailure).join("\n")}\nServer log tail:\n${yaadeLogs()}`,
          )
        }
      },
    },
    homeDir: homeDir ?? process.env.HOME ?? os.homedir(),
    baseUrl: url,
  }
}
