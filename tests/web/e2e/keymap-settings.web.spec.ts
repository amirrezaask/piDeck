import { expect } from "@playwright/test"
import type { ShellDriver } from "../../shell/driver.js"
import { test } from "../../fixtures/e2e.js"
import { focusTerminal, pressMuxPrefix, waitForMux } from "./_launch.js"

const ptyAvailable = process.platform !== "win32"
const primaryModifier = process.platform === "darwin" ? "Meta" : "Control"

async function activeTerminalText(page: ShellDriver): Promise<string> {
  return page.evaluate(() => {
    const id = window.__yaadeTest?.getState().activeMuxTerminalId
    return id ? (window.__yaadeTest?.getTerminalText(id) ?? "") : ""
  })
}

async function pressPrimaryChord(page: ShellDriver, key: string): Promise<void> {
  await page.keyboard.down(primaryModifier)
  await page.keyboard.press(key)
  await page.keyboard.up(primaryModifier)
  await page.keyboard.up("Meta")
  await page.keyboard.up("Control")
}

async function openKeyboardSettings(page: ShellDriver): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click()
  await expect(page.locator("[data-yaade-settings-overlay]")).toBeVisible()
  await page.getByRole("tab", { name: "Keyboard" }).click()
  await expect(page.locator('[data-yaade-settings-panel="keyboard"]')).toBeVisible()
}

async function captureCommandBinding(
  page: ShellDriver,
  commandId: string,
  key: string,
): Promise<void> {
  const search = page.getByRole("textbox", { name: "Search keyboard commands" })
  await search.fill(commandId === "commandPalette.show" ? "Show commands" : "New session")
  const row = page.locator(`[data-yaade-keymap-command="${commandId}"]`)
  await expect(row).toBeVisible()
  await row.getByRole("button", { name: "Change" }).click()
  await page.keyboard.press(key)
}

test.describe("keymap settings", () => {
  test.skip(!ptyAvailable, "PTY-backed terminal assertions require a Unix PTY")

  test("hot-swaps leader and commands without leaking capture or command keys to the PTY", async ({ launchApp }) => {
    const { page } = await launchApp()
    await focusTerminal(page)
    await page.keyboard.type(
      "sh -c 'stty -echo; printf \"KEYMAP_CAPTURE_READY\\n\"; IFS= read -r line; stty echo; printf \"KEYMAP_CAPTURE:<%s>\\n\" \"$line\"'",
    )
    await page.keyboard.press("Enter")
    await expect.poll(() => activeTerminalText(page)).toContain("KEYMAP_CAPTURE_READY")
    await page.keyboard.type("abc")

    await openKeyboardSettings(page)
    const leaderCard = page.locator("[data-yaade-keymap-leader]")
    await leaderCard.getByRole("button", { name: "Change leader" }).click()
    await pressPrimaryChord(page, "y")
    const risky = page.locator("[data-yaade-keymap-conflict]")
    await expect(risky).toContainText("needs explicit confirmation")
    await risky.getByRole("button", { name: "Confirm risky binding" }).click()
    await expect(leaderCard).toContainText(process.platform === "darwin" ? "⌘Y" : "Ctrl+Y")

    await captureCommandBinding(page, "commandPalette.show", "v")
    const paletteRow = page.locator('[data-yaade-keymap-command="commandPalette.show"]')
    await expect(paletteRow).toContainText("Effective")
    await expect(paletteRow).toContainText("V")

    await page.getByRole("textbox", { name: "Search keyboard commands" }).fill("New session")
    const sessionRow = page.locator('[data-yaade-keymap-command="session.new"]')
    await sessionRow.getByRole("button", { name: "Change" }).click()
    await page.keyboard.press("v")
    await expect(page.locator("[data-yaade-keymap-conflict]")).toContainText(
      "already assigned to Show commands",
    )

    await page.getByRole("button", { name: "Close settings" }).click()
    await pressPrimaryChord(page, "y")
    await page.keyboard.press("v")
    const palette = page.locator('[data-yaade-palette-surface="commands"]')
    await expect(palette).toBeVisible()
    await page.keyboard.press("Escape")
    await page.keyboard.type("SAFE")
    await page.keyboard.press("Enter")
    await expect.poll(() => activeTerminalText(page)).toContain("KEYMAP_CAPTURE:<abcSAFE>")

    await focusTerminal(page)
    await page.keyboard.type(
      "sh -c 'stty raw -echo min 1 time 0; printf \"KEYMAP_PREFIX_READY\\n\"; code=$(dd bs=1 count=1 2>/dev/null | od -An -tu1 | tr -d \" \" | tr -d \"\\n\"); stty sane; printf \"KEYMAP_PREFIX_CODE:<%s>\\n\" \"$code\"'",
    )
    await page.keyboard.press("Enter")
    await expect.poll(() => activeTerminalText(page)).toContain("KEYMAP_PREFIX_READY")
    await pressPrimaryChord(page, "y")
    await expect(page.locator("[data-yaade-which-key]")).toBeVisible()
    await pressPrimaryChord(page, "y")
    await expect.poll(() => activeTerminalText(page)).toContain("KEYMAP_PREFIX_CODE:<25>")

    await page.reload({ waitUntil: "domcontentloaded" })
    await waitForMux(page)
    await focusTerminal(page)
    await pressPrimaryChord(page, "y")
    await page.keyboard.press("v")
    await expect(page.locator('[data-yaade-palette-surface="commands"]')).toBeVisible()
    await page.keyboard.press("Escape")

    await pressPrimaryChord(page, "y")
    await page.keyboard.press("Shift+r")
    await pressMuxPrefix(page, "c")
    await expect(page.locator('[data-yaade-palette-surface="commands"]')).toBeVisible()
  })

  test("falls back from corrupt storage and applies a newer cross-tab profile", async ({ launchApp }) => {
    const { page } = await launchApp()
    await page.evaluate(() => {
      localStorage.setItem("yaade-keymap-profile-v1", "{corrupt")
    })
    await page.reload({ waitUntil: "domcontentloaded" })
    await waitForMux(page)
    await openKeyboardSettings(page)
    await expect(page.locator("[data-yaade-keymap-diagnostic]")).toContainText(
      "stored keymap was invalid",
    )
    await page.getByRole("button", { name: "Close settings" }).click()
    await pressMuxPrefix(page, "c")
    await expect(page.locator('[data-yaade-palette-surface="commands"]')).toBeVisible()
    await page.keyboard.press("Escape")

    await page.evaluate(() => {
      const value = JSON.stringify({
        revision: 9_000_000_000_000,
        profile: { version: 1, leader: "Ctrl-b", bindings: [] },
      })
      localStorage.setItem("yaade-keymap-profile-v1", value)
      window.dispatchEvent(new StorageEvent("storage", {
        key: "yaade-keymap-profile-v1",
        newValue: value,
        storageArea: localStorage,
      }))
    })
    await focusTerminal(page)
    await page.keyboard.down("Control")
    await page.keyboard.press("b")
    await page.keyboard.up("Control")
    await page.keyboard.press("c")
    await expect(page.locator('[data-yaade-palette-surface="commands"]')).toBeVisible()
  })

  test("keeps keyboard recovery and import/reset controls usable on mobile", async ({ launchApp }) => {
    const { page } = await launchApp({ mobile: true })
    await page.getByRole("button", { name: "Commands" }).click()
    const palette = page.locator('[data-yaade-palette-surface="commands"]')
    await palette.getByRole("combobox", { name: "Commands" }).fill("Open settings")
    await palette.getByRole("option", { name: /Open settings/ }).click()
    await page.getByRole("tab", { name: "Keyboard" }).click()
    const panel = page.locator('[data-yaade-settings-panel="keyboard"]')
    await expect(panel).toBeVisible()
    await expect(panel.locator("[data-yaade-keymap-command-list]")).toBeVisible()
    await panel.getByRole("button", { name: "Import" }).click()
    const importer = panel.locator("[data-yaade-keymap-import]")
    await expect(importer).toBeVisible()
    await importer.getByRole("textbox", { name: "Keymap JSON" }).fill(
      '{"version":1,"leader":"Ctrl-b","bindings":[]}',
    )
    await importer.getByRole("button", { name: "Apply import" }).click()
    await expect(importer).toHaveCount(0)
    await expect(panel.locator("[data-yaade-keymap-leader]")).toContainText(/Ctrl\+?B/)
    await panel.getByRole("button", { name: "Reset keymap" }).click()
    await expect(page.getByRole("button", { name: "Close settings" })).toBeVisible()
  })
})
