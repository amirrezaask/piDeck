import { expect } from "@playwright/test"
import type { ShellDriver } from "../shell/driver.js"
import { expectDialogCount, expectRoleVisible } from "../shell/assert.js"

export async function expectPaletteOpen(page: ShellDriver): Promise<void> {
  await expectRoleVisible(page, "dialog")
  await expect(
    page.locator('[role="dialog"] [role="combobox"], [role="dialog"] input').first(),
  ).toBeVisible({ timeout: 10_000 })
}

export async function expectPaletteClosed(page: ShellDriver): Promise<void> {
  await expectDialogCount(page, 0)
}
