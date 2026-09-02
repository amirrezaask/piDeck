import { expect } from "@playwright/test"
import { resolve } from "node:path"
import { launchWeb } from "../../shell/launch-web.js"
import type { LaunchShellResult, ShellDriver } from "../../shell/driver.js"

export type { ShellDriver }
export type LaunchYaadeOptions = {
  workspaceRel?: string
  mobile?: boolean
  env?: Record<string, string>
  userDataDir?: string
  launchWithoutWorkspace?: boolean
  startPath?: string
  homeDir?: string
  /** Return after rendering an intentional boot error instead of waiting for the test bridge. */
  expectBootError?: boolean
  /** Ensure a Terminal MuxTerminal after the Session shell mounts. Defaults to true. */
  withTerminal?: boolean
  /** Narrow allowlist for a test that intentionally requests an HTTP error. */
  expectedHttpErrors?: Array<{
    method: string
    path: string
    status: number
  }>
}

export const REPO_ROOT = resolve(__dirname, "..", "..")
export const SAMPLE = "fixtures/sample-workspace"

/**
 * PTY availability is provided by the Rust host (`portable-pty`/ConPTY).
 */
export function hasPtySpawn(): boolean {
  return process.platform !== "win32"
}

/**
 * Shared browser E2E entry.
 *
 * Each `launchYaade()` call spins up its own `@yaade/server` + browser
 * context and tears it down in the test's `finally` via `app.close()`.
 * The default suite is serial because PTY/LSP timing becomes flaky under host
 * contention; `PLAYWRIGHT_WORKERS=N` remains available for targeted runs.
 *
 * A shared host-per-worker fixture was intentionally not adopted because PTYs
 * and persisted MuxTerminals would leak between tests. Keep the per-test lifecycle
 * until the harness can reset both stores deterministically.
 */
export async function launchYaade(
  opts: LaunchYaadeOptions = { workspaceRel: SAMPLE },
): Promise<LaunchShellResult> {
  const result = await launchWeb(opts)
  try {
    if (opts.expectBootError) return result
    await waitForMux(result.page)
    if (opts.withTerminal !== false) {
      await openMuxTerminal(result.page)
    }
    return result
  } catch (error) {
    // launchWeb has already created the host process by this point. If a
    // readiness helper fails, the caller never receives `result` and cannot
    // run its normal finally block, so tear the host down here as well.
    await result.app.close().catch(() => {})
    throw error
  }
}

/** Wait for the primary terminal shell and its test bridge. */
export async function waitForMux(page: ShellDriver, timeoutMs = 30_000): Promise<void> {
  await expect(page.locator('[data-yaade-shell="terminal-multiplexer"]')).toBeVisible({
    timeout: timeoutMs,
  })
  await page.evaluate(() => window.__yaadeTest!.waitForReady())
}

/** Wait for the default terminal. */
async function openMuxTerminal(
  page: ShellDriver,
  timeoutMs = 15_000,
): Promise<void> {
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible({
    timeout: timeoutMs,
  })
}

export async function focusTerminal(page: ShellDriver): Promise<void> {
  const visibleSurface = page.locator(
    "[data-yaade-terminal-panel] .yaade-terminal-surface:visible",
  )
  if (await visibleSurface.count() > 0) await visibleSurface.first().click()
  await page.evaluate(() => {
    window.__yaadeTest?.focusTerminal?.()
  })
  // Best-effort DOM focus — the registry focus path above is authoritative.
  await page
    .locator("[data-yaade-terminal-panel] [data-ghostty-terminal-input]:visible")
    .first()
    .focus({ timeout: 5_000 })
    .catch(() => undefined)
}

export async function showTerminal(page: ShellDriver): Promise<void> {
  await waitForMux(page)
  await expect(
    page.locator("[data-yaade-terminal-panel] [data-ghostty-terminal-canvas]"),
  ).toBeVisible({ timeout: 30_000 })
}

function modChord(): "Meta" | "Control" {
  return process.platform === "darwin" ? "Meta" : "Control"
}

export async function pressShellPrefix(page: ShellDriver): Promise<void> {
  const mod = modChord()
  await page.keyboard.down(mod)
  await page.keyboard.press("KeyK")
  await page.keyboard.up(mod)
  // Mux second-keys reject leftover Meta/Ctrl. Playwright can latch them
  // after a Mod- chord, so force both modifiers up.
  await page.keyboard.up("Meta")
  await page.keyboard.up("Control")
}

export async function pressMuxPrefix(
  page: ShellDriver,
  key: string,
): Promise<void> {
  await pressShellPrefix(page)
  await page.keyboard.press(key)
}
