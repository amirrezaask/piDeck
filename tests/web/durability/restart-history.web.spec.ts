import { expect, test } from "@playwright/test"
import fs from "node:fs"
import path from "node:path"
import { createDurableRuntimeHarness } from "../../runtime/harness/index.js"
import { focusTerminal } from "../e2e/_launch.js"

test("host restart preserves the routed terminal, retained output, and explicit recovery", async () => {
  const harness = await createDurableRuntimeHarness()
  const errors: string[] = []
  try {
    await harness.startApi()
    const browser = await harness.startBrowser()
    const { page } = browser
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", message => {
      if (message.type() === "error") errors.push(message.text())
    })

    const panel = page.locator("[data-yaade-terminal-panel]")
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await expect(panel.locator("[data-ghostty-terminal-canvas]")).toBeVisible({
      timeout: 30_000,
    })
    const before = await page.evaluate(() => window.__yaadeTest?.getState())
    const terminal = before?.muxTerminals?.find(item => item.id === before.activeMuxTerminalId)
    if (!terminal || !before?.activeSessionId || !before.activeTabId) {
      throw new Error("active terminal route is unavailable")
    }
    const route = `/?s=${encodeURIComponent(before.activeSessionId)}&t=${encodeURIComponent(before.activeTabId)}&term=${encodeURIComponent(terminal.id)}`
    await page.goto(`${harness.origin}${route}`, { waitUntil: "domcontentloaded" })
    await page.evaluate(() => window.__yaadeTest!.waitForReady())

    await focusTerminal(page)
    const marker = "YAADE_RESTART_RETAINED_OUTPUT"
    await page.keyboard.type(`printf '${marker}\\n'`)
    await page.keyboard.press("Enter")
    await expect
      .poll(() => page.evaluate(id => window.__yaadeTest?.getTerminalText(id) ?? "", terminal.id))
      .toContain(marker)

    await harness.restartApi("SIGKILL")
    const interrupted = page.locator('[data-yaade-terminal-interrupted="history"]')
    await expect(interrupted).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(new RegExp(`s=${encodeURIComponent(before.activeSessionId)}`))
    await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(1)
    await expect(
      page.getByText("Interrupted by host restart · retained output is read-only"),
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(id => window.__yaadeTest?.getTerminalText(id) ?? "", terminal.id))
      .toContain(marker)

    await page.setViewportSize({ width: 390, height: 844 })
    const mobileActions = page.getByRole("group", { name: "Interrupted terminal actions" })
    const restart = mobileActions.getByRole("button", { name: "Restart terminal", exact: true })
    await expect(restart).toBeVisible()
    await expect(mobileActions.getByRole("button", { name: "Close", exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

    await restart.click()
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.__yaadeTest?.getState())
      return state?.muxTerminals?.find(item => item.id === terminal.id)?.output
    }, { timeout: 30_000 }).toMatchObject({
      generation: terminal.output.generation + 1,
      processState: "running",
    })
    await expect(page.locator('[data-yaade-terminal-interrupted]')).toHaveCount(0)
    await expect(page.locator("[data-ghostty-terminal-canvas]:visible")).toBeVisible({
      timeout: 30_000,
    })

    await page.evaluate(id => window.__yaadeTest?.focusTerminal?.(id), terminal.id)
    await page.locator("[data-ghostty-terminal-input]:visible").focus()
    const restartedMarker = "YAADE_RESTARTED_NEW_SHELL"
    await page.keyboard.type(`printf '${restartedMarker}\\n'`)
    await page.keyboard.press("Enter")
    await expect
      .poll(() => page.evaluate(id => window.__yaadeTest?.getTerminalText(id) ?? "", terminal.id))
      .toContain(restartedMarker)
    expect(
      errors.filter(message => !message.includes("ERR_CONNECTION_REFUSED")),
    ).toEqual([])
  } finally {
    await harness.close()
  }
})

test("corrupt retained history degrades to an explicit restartable state", async () => {
  const harness = await createDurableRuntimeHarness()
  try {
    await harness.startApi()
    const browser = await harness.startBrowser()
    const { page } = browser
    await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible({ timeout: 30_000 })
    const before = await page.evaluate(() => window.__yaadeTest?.getState())
    const terminal = before?.muxTerminals?.find(item => item.id === before.activeMuxTerminalId)
    const historyId = terminal?.output.ptyId
    if (!terminal || !historyId) throw new Error("active terminal history identity is unavailable")

    await focusTerminal(page)
    await page.keyboard.type("printf 'history-that-will-be-corrupted\\n'")
    await page.keyboard.press("Enter")
    await expect
      .poll(() => page.evaluate(id => window.__yaadeTest?.getTerminalText(id) ?? "", terminal.id))
      .toContain("history-that-will-be-corrupted")

    const archiveDir = path.join(
      harness.dataDir,
      "terminal-history",
      Buffer.from(historyId).toString("base64url"),
    )
    const manifestPath = path.join(archiveDir, "index.json")
    await expect.poll(() => fs.existsSync(manifestPath)).toBe(true)
    await harness.stopApi("SIGKILL")
    fs.writeFileSync(manifestPath, "{corrupt-manifest")
    await harness.startApi()

    const unavailable = page.locator('[data-yaade-terminal-interrupted="unavailable"]')
    await expect(unavailable).toBeVisible({ timeout: 30_000 })
    await expect(unavailable).toContainText("Terminal ended when the host restarted")
    await expect(unavailable).toContainText("Retained output is unavailable")
    const restart = unavailable.getByRole("button", { name: "Restart terminal", exact: true })
    await expect(restart).toBeVisible()
    await expect(unavailable.getByRole("button", { name: "Close", exact: true })).toBeVisible()

    await restart.click()
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.__yaadeTest?.getState())
      return state?.muxTerminals?.find(item => item.id === terminal.id)?.output
    }, { timeout: 30_000 }).toMatchObject({
      generation: terminal.output.generation + 1,
      processState: "running",
    })
  } finally {
    await harness.close()
  }
})
