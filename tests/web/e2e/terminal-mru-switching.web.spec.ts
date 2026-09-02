import { expect } from "@playwright/test"
import type { ShellDriver } from "../../shell/driver.js"
import { test } from "../../fixtures/e2e.js"
import { focusTerminal, pressMuxPrefix } from "./_launch.js"

const ptyAvailable = process.platform !== "win32"

async function activeTerminalId(page: ShellDriver): Promise<string | null> {
  return page.evaluate(() => window.__yaadeTest?.getState().activeMuxTerminalId ?? null)
}

async function terminalText(page: ShellDriver, terminalId: string): Promise<string> {
  return page.evaluate(
    id => window.__yaadeTest?.getTerminalText(id) ?? "",
    terminalId,
  )
}

async function selectTerminal(page: ShellDriver, terminalId: string): Promise<void> {
  await page.evaluate(async id => window.__yaadeTest?.selectMuxTerminal?.(id), terminalId)
  await expect.poll(() => activeTerminalId(page)).toBe(terminalId)
  await focusTerminal(page)
}

async function lifecycle(page: ShellDriver, terminalId: string) {
  let value: Awaited<ReturnType<NonNullable<typeof window.__yaadeTest>["getTerminalLifecycle"]>> = null
  await expect.poll(async () => {
    value = await page.evaluate(
      id => window.__yaadeTest?.getTerminalLifecycle(id) ?? null,
      terminalId,
    )
    return value && value.attachCount > 0 ? value : null
  }).not.toBeNull()
  return value
}

function expectResidentLifecycle(
  before: Awaited<ReturnType<NonNullable<typeof window.__yaadeTest>["getTerminalLifecycle"]>>,
  after: Awaited<ReturnType<NonNullable<typeof window.__yaadeTest>["getTerminalLifecycle"]>>,
): void {
  expect(after?.ptyId).toBe(before?.ptyId)
  expect(after?.surfaceInstanceId).toBe(before?.surfaceInstanceId)
  expect(after?.runtimeGeneration).toBe(before?.runtimeGeneration)
  expect(after?.rendererGeneration).toBe(before?.rendererGeneration)
  expect(after?.attachCount).toBe(before?.attachCount)
}

test.describe("MRU terminal switching", () => {
  test.skip(!ptyAvailable, "PTY-backed switching assertions require a Unix PTY")

  test("toggles across Windows, ranks recent terminals, prunes closed entries, and preserves residents", async ({ launchApp }) => {
    const { page } = await launchApp({ workspaceRel: "fixtures/sample-workspace" })
    await focusTerminal(page)
    const firstId = await activeTerminalId(page)
    if (!firstId) throw new Error("first terminal is unavailable")
    const firstBefore = await lifecycle(page, firstId)

    await page.keyboard.type(
      "sh -c 'stty raw -echo min 1 time 0; printf \"MRU_INPUT_READY\\n\"; code=$(dd bs=1 count=1 2>/dev/null | od -An -tu1 | tr -d \" \" | tr -d \"\\n\"); stty sane; printf \"MRU_INPUT_CODE:<%s>\\n\" \"$code\"'",
    )
    await page.keyboard.press("Enter")
    await expect.poll(() => terminalText(page, firstId)).toContain("MRU_INPUT_READY")

    const windowTabs = page.locator("[data-yaade-window-tabs] [data-yaade-session-tab]")
    await page.getByRole("button", { name: "New Window" }).click()
    await expect(windowTabs).toHaveCount(2)
    await expect.poll(() => activeTerminalId(page)).not.toBe(firstId)
    const secondId = await activeTerminalId(page)
    if (!secondId) throw new Error("second terminal is unavailable")
    const secondBefore = await lifecycle(page, secondId)
    await focusTerminal(page)
    await page.keyboard.type("printf 'MRU_SECOND_READY\\n'")
    await page.keyboard.press("Enter")
    await expect.poll(() => terminalText(page, secondId)).toContain("MRU_SECOND_READY")

    await pressMuxPrefix(page, "b")
    await expect.poll(() => activeTerminalId(page)).toBe(firstId)
    await pressMuxPrefix(page, "b")
    await expect.poll(() => activeTerminalId(page)).toBe(secondId)
    await expect.poll(() => terminalText(page, firstId)).not.toContain("MRU_INPUT_CODE")

    await selectTerminal(page, firstId)
    await page.keyboard.type("X")
    await expect.poll(() => terminalText(page, firstId)).toContain("MRU_INPUT_CODE:<88>")

    await pressMuxPrefix(page, "u")
    const palette = page.locator('[data-yaade-palette-surface="terminals"]')
    await expect(palette).toBeVisible()
    const recent = palette.locator('[data-yaade-terminal-switcher-recent="true"]')
    await expect(recent).toHaveCount(2)
    await expect(palette.locator('[data-yaade-terminal-switcher-group="recent"]')).toHaveText("Recent")
    await expect(recent.nth(0)).toHaveAttribute("data-yaade-terminal-switcher-terminal", firstId)
    await expect(recent.nth(1)).toHaveAttribute("data-yaade-terminal-switcher-terminal", secondId)
    await expect(recent.nth(0)).toContainText(/This client|This server/)
    await expect(recent.nth(0)).toContainText("Window 1")
    await expect(recent.nth(0)).toContainText("Running")

    const search = palette.getByRole("combobox", { name: "Switch terminal" })
    await search.fill("Window 2")
    const options = palette.getByRole("option")
    await expect(options).toHaveCount(1)
    await expect(options.first()).toContainText("Window 2")
    await page.keyboard.press("Escape")
    await expect(page.locator('[data-yaade-palette-surface="terminals"]')).toHaveCount(0)

    const firstAfter = await lifecycle(page, firstId)
    const secondAfter = await lifecycle(page, secondId)
    expectResidentLifecycle(firstBefore, firstAfter)
    expectResidentLifecycle(secondBefore, secondAfter)

    await selectTerminal(page, secondId)
    await page.evaluate(async id => window.__yaadeTest?.closeMuxTerminal?.(id), firstId)
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.__yaadeTest?.getState())
      return state?.muxTerminals.some(terminal => terminal.id === firstId) ?? true
    }).toBe(false)
    await pressMuxPrefix(page, "u")
    const reopened = page.locator('[data-yaade-palette-surface="terminals"]')
    await expect(reopened.locator(`[data-yaade-terminal-switcher-terminal="${firstId}"]`)).toHaveCount(0)
    await expect(reopened.locator('[data-yaade-terminal-switcher-terminal]')).toHaveCount(1)
    await expect.poll(() => page.evaluate(
      id => sessionStorage.getItem("yaade:terminal-focus-history-v1")?.includes(id) ?? false,
      firstId,
    )).toBe(false)
  })

  test("shows a stable fallback group and typed exit status without transcript inference", async ({ launchApp }) => {
    const { page } = await launchApp()
    await page.evaluate(() => sessionStorage.removeItem("yaade:terminal-focus-history-v1"))
    await page.reload()
    await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible({ timeout: 30_000 })
    await pressMuxPrefix(page, "u")
    let palette = page.locator('[data-yaade-palette-surface="terminals"]')
    await expect(palette.locator('[data-yaade-terminal-switcher-group="other"]')).toHaveText(
      "Other terminals",
    )
    await expect(palette.locator('[data-yaade-terminal-switcher-group="recent"]')).toHaveCount(0)
    await page.keyboard.press("Escape")

    await focusTerminal(page)
    await page.keyboard.type("exit 7")
    await page.keyboard.press("Enter")
    await expect.poll(() => page.evaluate(() => {
      const id = window.__yaadeTest?.getState().activeMuxTerminalId
      return window.__yaadeTest?.getState().muxTerminals.find(terminal => terminal.id === id)
        ?.output.processState
    })).toMatch(/failed|exited/)

    await pressMuxPrefix(page, "u")
    palette = page.locator('[data-yaade-palette-surface="terminals"]')
    const status = palette.locator("[data-yaade-terminal-status]")
    await expect(status).toHaveAttribute("data-yaade-terminal-status", /failed|exited/)
    await expect(status).toContainText(/Failed|Exited/)
  })

  test("keeps host, Session, Window, current, and status text usable on mobile", async ({ launchApp }) => {
    const { page } = await launchApp({ mobile: true })
    const firstId = await activeTerminalId(page)
    if (!firstId) throw new Error("mobile terminal is unavailable")
    await page.evaluate(async () => window.__yaadeTest?.createMuxTerminal?.("terminal"))
    await expect.poll(() => page.evaluate(() => window.__yaadeTest?.getState().muxTerminals.length ?? 0)).toBe(2)

    await page.getByRole("button", { name: "Commands" }).click()
    const commands = page.locator('[data-yaade-palette-surface="commands"]')
    await commands.getByRole("combobox", { name: "Commands" }).fill("Switch terminal")
    await commands.getByRole("option", { name: /^Switch terminal/ }).click()

    const terminals = page.locator('[data-yaade-palette-surface="terminals"]')
    await expect(terminals).toBeVisible()
    await expect(terminals.locator('[data-yaade-terminal-switcher-terminal]')).toHaveCount(2)
    await expect(terminals.getByText(/This client|This server/).first()).toBeVisible()
    await expect(terminals.getByText("Current", { exact: true })).toBeVisible()
    await expect(terminals.getByText(/Running|Waiting|Starting/).first()).toBeVisible()
    const firstRow = terminals.locator(`[data-yaade-terminal-switcher-terminal="${firstId}"]`)
    await firstRow.click()
    await expect.poll(() => activeTerminalId(page)).toBe(firstId)
    await expect(terminals).toHaveCount(0)
  })
})
