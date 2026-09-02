import { expect } from "@playwright/test"
import type { ShellDriver } from "../../shell/driver.js"
import { test } from "../../fixtures/e2e.js"
import { focusTerminal, pressMuxPrefix, waitForMux } from "./_launch.js"

const ptyAvailable = process.platform !== "win32"

async function activeTerminalId(page: ShellDriver): Promise<string> {
  return page.evaluate(() => {
    const id = window.__yaadeTest?.getState().activeMuxTerminalId
    if (!id) throw new Error("active terminal missing")
    return id
  })
}

async function terminalText(page: ShellDriver, terminalId: string): Promise<string> {
  return page.evaluate(
    id => window.__yaadeTest?.getTerminalText?.(id) ?? "",
    terminalId,
  )
}

async function sendCommand(page: ShellDriver, command: string): Promise<void> {
  await focusTerminal(page)
  await page.keyboard.type(command)
  await page.keyboard.press("Enter")
}

async function waitForTerminalText(
  page: ShellDriver,
  terminalId: string,
  text: string,
): Promise<void> {
  await expect.poll(() => terminalText(page, terminalId), { timeout: 15_000 }).toContain(text)
}

async function scrollTerminal(page: ShellDriver, terminalId: string, rows: number): Promise<void> {
  const scrolled = await page.evaluate(
    ({ id, amount }) => window.__yaadeTest?.scrollTerminalLines?.(amount, id) ?? false,
    { id: terminalId, amount: rows },
  )
  expect(scrolled).toBe(true)
}

function numberedOutput(prefix: string, start: number, end: number, final: string): string {
  return `sh -c 'i=${start}; while [ "$i" -le ${end} ]; do printf "${prefix}-%03d\\n" "$i"; i=$((i+1)); done; printf "${final}\\n"'`
}

test.describe("scroll lock and unseen output", () => {
  test.skip(!ptyAvailable, "PTY-backed terminal assertions require a Unix PTY")

  test("anchors worker scrollback, counts unseen rows, and keeps navigation out of the PTY", async ({ launchApp }) => {
    const { page } = await launchApp()
    const terminalId = await activeTerminalId(page)
    const tile = page.locator(`[data-yaade-terminal-tile="${terminalId}"]`)
    const panel = tile.locator("[data-yaade-terminal-panel]")
    const surface = tile.locator("[data-ghostty-terminal]")
    const jump = tile.locator("[data-yaade-jump-to-live]")

    await expect(surface).toHaveAttribute("data-ghostty-terminal-runtime", "worker")
    await sendCommand(page, numberedOutput("ROW", 1, 180, "INITIAL_DONE"))
    await waitForTerminalText(page, terminalId, "INITIAL_DONE")
    await sendCommand(page, "stty -echo; printf 'ECHO_OFF_READY\\n'")
    await waitForTerminalText(page, terminalId, "ECHO_OFF_READY")

    await scrollTerminal(page, terminalId, -18)
    await expect(panel).toHaveAttribute("data-yaade-terminal-viewport-mode", "inspecting")
    await expect(jump).toHaveAttribute("data-visible", "true")
    await expect(jump).toHaveAttribute("data-unseen-rows", "0")
    await expect(jump).toHaveAccessibleName("Jump to live")
    const inspectedText = await terminalText(page, terminalId)
    const anchor = inspectedText.match(/ROW-\d{3}/)?.[0]
    expect(anchor).toBeTruthy()
    const renderCount = await panel.getAttribute("data-yaade-terminal-panel-render-count")

    await sendCommand(page, "printf 'ONE_NEW_ROW\\n'")
    await expect(jump).toHaveAttribute("data-unseen-rows", "2")
    await expect(jump).toHaveAccessibleName("2 new rows. Jump to live")
    expect(await terminalText(page, terminalId)).toContain(anchor)

    await sendCommand(page, numberedOutput("NEW", 181, 205, "LATEST_OUTPUT"))
    await expect(jump).toHaveAttribute("data-visible", "true")
    await expect(jump).toHaveAttribute("data-mode", "inspecting")
    await expect
      .poll(async () => Number(await jump.getAttribute("data-unseen-rows")))
      .toBeGreaterThanOrEqual(27)
    await expect(jump).toContainText(/new rows/)
    expect(await terminalText(page, terminalId)).toContain(anchor)
    expect(await terminalText(page, terminalId)).not.toContain("LATEST_OUTPUT")
    const nextRenderCount = await panel.getAttribute("data-yaade-terminal-panel-render-count")
    expect(Number(nextRenderCount) - Number(renderCount)).toBeLessThanOrEqual(6)

    const frameBeforeReconnect = Number(
      await panel.getAttribute("data-yaade-terminal-last-submitted-frame"),
    )
    await page.evaluate(
      () => new Promise<void>(resolve => {
        window.addEventListener("yaade:host-reconnected", () => resolve(), { once: true })
        window.dispatchEvent(new Event("online"))
      }),
    )
    await sendCommand(page, numberedOutput("RECONNECTED", 1, 4, "RECONNECT_LATEST"))
    await expect
      .poll(async () => Number(
        await panel.getAttribute("data-yaade-terminal-last-submitted-frame"),
      ))
      .toBeGreaterThan(frameBeforeReconnect)
    const reconnectedUnseen = await jump.getAttribute("data-unseen-rows")
    expect(
      reconnectedUnseen === "unknown" || Number(reconnectedUnseen) >= 31,
    ).toBe(true)
    await expect(panel).toHaveAttribute("data-yaade-terminal-viewport-mode", "inspecting")
    expect(await terminalText(page, terminalId)).toContain(anchor)
    expect(await terminalText(page, terminalId)).not.toContain("RECONNECT_LATEST")

    await page.setViewportSize({ width: 1120, height: 760 })
    await expect(panel).toHaveAttribute("data-yaade-terminal-viewport-mode", "inspecting")
    await expect(jump).toHaveAttribute("data-unseen-rows", "unknown")
    await expect(jump).toContainText("New output")
    expect(await terminalText(page, terminalId)).toContain(anchor)

    await jump.click()
    await waitForTerminalText(page, terminalId, "LATEST_OUTPUT")
    await expect(panel).toHaveAttribute("data-yaade-terminal-viewport-mode", "live")
    await expect(jump).toHaveAttribute("data-visible", "false")

    await pressMuxPrefix(page, "Shift+G")
    await expect(panel).toHaveAttribute("data-yaade-terminal-viewport-mode", "paused")
    const pausedText = await terminalText(page, terminalId)
    const pausedAnchor = pausedText.match(/NEW-\d{3}/)?.[0]
    expect(pausedAnchor).toBeTruthy()
    await sendCommand(page, numberedOutput("PAUSED", 1, 8, "PAUSED_LATEST"))
    await expect(panel).toHaveAttribute("data-yaade-terminal-viewport-mode", "paused")
    expect(await terminalText(page, terminalId)).toContain(pausedAnchor)
    expect(await terminalText(page, terminalId)).not.toContain("PAUSED_LATEST")
    await pressMuxPrefix(page, "Shift+G")
    await expect(panel).toHaveAttribute("data-yaade-terminal-viewport-mode", "inspecting")
    await pressMuxPrefix(page, "g")
    await expect(panel).toHaveAttribute("data-yaade-terminal-viewport-mode", "live")

    await sendCommand(
      page,
      "sh -c 'stty -echo; printf \"CAPTURE_READY\\n\"; IFS= read -r line; stty echo; printf \"\\nCAPTURE:<%s>\\n\" \"$line\"'",
    )
    await waitForTerminalText(page, terminalId, "CAPTURE_READY")
    await scrollTerminal(page, terminalId, -6)
    await pressMuxPrefix(page, "g")
    await page.keyboard.type("SAFE")
    await page.keyboard.press("Enter")
    await waitForTerminalText(page, terminalId, "CAPTURE:<SAFE>")
    expect(await terminalText(page, terminalId)).not.toContain("CAPTURE:<gSAFE>")
  })

  test("keeps the main-thread runtime anchored until jump to live", async ({ launchApp }) => {
    const { page } = await launchApp()
    await page.evaluate(() => window.localStorage.setItem("yaade:terminal-runtime", "main"))
    await page.reload({ waitUntil: "domcontentloaded" })
    await waitForMux(page)
    const terminalId = await activeTerminalId(page)
    const tile = page.locator(`[data-yaade-terminal-tile="${terminalId}"]`)
    const panel = tile.locator("[data-yaade-terminal-panel]")
    const jump = tile.locator("[data-yaade-jump-to-live]")

    await expect(tile.locator("[data-ghostty-terminal]")).toHaveAttribute(
      "data-ghostty-terminal-runtime",
      "main",
    )
    await sendCommand(page, numberedOutput("MAIN", 1, 120, "MAIN_INITIAL"))
    await waitForTerminalText(page, terminalId, "MAIN_INITIAL")
    await scrollTerminal(page, terminalId, -12)
    const inspectedText = await terminalText(page, terminalId)
    const anchor = inspectedText.match(/MAIN-\d{3}/)?.[0]
    expect(anchor).toBeTruthy()

    await sendCommand(page, numberedOutput("MAIN_NEW", 121, 138, "MAIN_LATEST"))
    await expect(jump).toHaveAttribute("data-visible", "true")
    expect(await terminalText(page, terminalId)).toContain(anchor)
    expect(await terminalText(page, terminalId)).not.toContain("MAIN_LATEST")
    await jump.click()
    await waitForTerminalText(page, terminalId, "MAIN_LATEST")
    await expect(panel).toHaveAttribute("data-yaade-terminal-viewport-mode", "live")
  })

  test("offers a touch-sized mobile jump control backed by real PTY output", async ({ launchApp }) => {
    const { page } = await launchApp({ mobile: true })
    const terminalId = await activeTerminalId(page)
    const jump = page.locator(
      `[data-yaade-terminal-placement="${terminalId}"] [data-yaade-jump-to-live]`,
    )

    await sendCommand(page, numberedOutput("MOBILE", 1, 100, "MOBILE_INITIAL"))
    await waitForTerminalText(page, terminalId, "MOBILE_INITIAL")
    await scrollTerminal(page, terminalId, -10)
    await sendCommand(page, numberedOutput("MOBILE_NEW", 101, 112, "MOBILE_LATEST"))
    await expect(jump).toHaveAttribute("data-visible", "true")
    const bounds = await jump.boundingBox()
    expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(44)
    expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(await terminalText(page, terminalId)).not.toContain("MOBILE_LATEST")

    await jump.click()
    await waitForTerminalText(page, terminalId, "MOBILE_LATEST")
    await expect(jump).toHaveAttribute("data-visible", "false")
  })
})
