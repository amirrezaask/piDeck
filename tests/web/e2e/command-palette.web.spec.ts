import { expect } from "@playwright/test"
import { test } from "../../fixtures/e2e.js"
import {
  focusTerminal,
  pressMuxPrefix,
  pressShellPrefix,
} from "./_launch.js"

async function activeTerminalText(page: Parameters<typeof focusTerminal>[0]): Promise<string> {
  return page.evaluate(() => {
    const id = window.__yaadeTest?.getState().activeMuxTerminalId
    return id ? (window.__yaadeTest?.getTerminalText(id) ?? "") : ""
  })
}

test("command palette dispatches one registry, rejects disabled commands, and does not leak PTY input", async ({
  launchApp,
}) => {
  const { page } = await launchApp({ workspaceRel: "fixtures/sample-workspace" })
  await focusTerminal(page)

  await page.keyboard.type(
    "sh -c 'stty -echo; printf \"\\103\\101\\120\\124\\125\\122\\105\\137\\122\\105\\101\\104\\131\\n\"; IFS= read -r line; printf \"YAADE_CAPTURE:<%s>\\\\n\" \"$line\"; stty echo'",
  )
  await page.keyboard.press("Enter")
  await expect.poll(() => activeTerminalText(page)).toContain("CAPTURE_READY")
  await page.keyboard.type("abc")

  await pressMuxPrefix(page, "c")
  const palette = page.locator('[data-yaade-palette-surface="commands"]')
  await expect(palette).toBeVisible()
  const input = palette.getByRole("combobox", { name: "Commands" })
  await expect(input).toBeFocused()
  await expect
    .poll(() => palette.getByRole("option").count())
    .toBeGreaterThan(10)

  await input.fill("toggle sidebar")
  const disabled = palette.getByRole("option", { name: /Toggle sidebar/ })
  await expect(disabled).toHaveAttribute("aria-disabled", "true")
  await expect(disabled).toContainText("Choose a sidebar layout in Settings first.")
  await page.keyboard.press("Enter")
  await expect(palette).toBeVisible()

  await input.fill("open settings")
  const settings = palette.getByRole("option", { name: /Open settings/ })
  await expect(settings).not.toHaveAttribute("aria-disabled", "true")
  await page.keyboard.press("Enter")
  await expect(palette).toHaveCount(0)
  await expect(page.locator("[data-yaade-settings-overlay]")).toBeVisible()
  await page.getByRole("button", { name: /Close settings/ }).click()

  const terminalInput = page.locator("[data-ghostty-terminal-input]").first()
  await expect(terminalInput).toBeFocused()
  await page.keyboard.type("SAFE")
  await page.keyboard.press("Enter")
  await expect.poll(() => activeTerminalText(page)).toContain("YAADE_CAPTURE:<abcSAFE>")
})

test("prefix literal reaches the real PTY exactly once", async ({ launchApp }) => {
  const { page } = await launchApp({ workspaceRel: "fixtures/sample-workspace" })
  await focusTerminal(page)

  await page.keyboard.type(
    "sh -c 'stty -icanon -echo min 1 time 0; printf \"\\122\\105\\101\\104\\131\\137\\113\\n\"; code=$(dd bs=1 count=1 2>/dev/null | od -An -tu1 | tr -d \" \" | tr -d \"\\\\n\"); stty sane; printf \"CTRL_K_CODE:<%s>\\\\n\" \"$code\"'",
  )
  await page.keyboard.press("Enter")
  await expect.poll(() => activeTerminalText(page)).toContain("READY_K")
  await pressShellPrefix(page)
  await expect(page.locator("[data-yaade-which-key]")).toBeVisible()
  await pressShellPrefix(page)
  await expect(page.locator("[data-yaade-which-key]")).toHaveCount(0)

  await expect.poll(() => activeTerminalText(page)).toContain("CTRL_K_CODE:<11>")
})

test("session palette filters and creates one exact named session", async ({ launchApp }) => {
  const { page } = await launchApp({ workspaceRel: "fixtures/sample-workspace" })
  await page.getByRole("button", { name: /Switch session/ }).click()

  const palette = page.locator('[data-yaade-palette-surface="sessions"]')
  const input = palette.getByRole("combobox", { name: "Switch session" })
  await expect(input).toBeFocused()
  await input.fill("API work")
  const create = palette.getByRole("option", { name: /Create “API work”/ })
  await expect(create).toContainText("on This client")
  await input.press("Enter")

  await expect(
    page.getByRole("button", { name: "Switch session, current API work" }),
  ).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => page.evaluate(() => window.__yaadeTest?.getState().sessions?.length ?? 0))
    .toBe(2)

  await page.getByRole("button", { name: /Switch session/ }).click()
  await input.fill("API work")
  await expect(palette.getByRole("option", { name: /API work/ })).toHaveCount(1)
  await expect(palette.getByRole("option", { name: /Create “API work”/ })).toHaveCount(0)

  await input.fill("Session 1")
  await input.press("Enter")
  await expect(
    page.getByRole("button", { name: "Switch session, current Session 1" }),
  ).toBeVisible({ timeout: 30_000 })
})

test("command and session palettes remain operable on mobile", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
    mobile: true,
  })
  const commandButton = page.getByRole("button", { name: "Commands" }).first()
  await expect(commandButton).toBeVisible()
  await commandButton.click()

  const commands = page.locator('[data-yaade-palette-surface="commands"]')
  await expect(commands).toBeVisible()
  await expect(commands).toHaveCSS("max-height", /.+/)
  const input = commands.getByRole("combobox", { name: "Commands" })
  await input.fill("open settings")
  await commands.getByRole("option", { name: /Open settings/ }).click()
  await expect(page.locator("[data-yaade-settings-overlay]")).toBeVisible()
  await page.getByRole("button", { name: /Close settings/ }).click()

  await commandButton.click()
  await input.fill("switch session")
  await input.press("Enter")

  const sessions = page.locator('[data-yaade-palette-surface="sessions"]')
  await expect(sessions).toBeVisible()
  await expect(sessions.getByRole("option", { name: /Session 1/ })).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
})
