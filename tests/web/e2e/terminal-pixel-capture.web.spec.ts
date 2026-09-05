import { writeFile } from "node:fs/promises"
import { test, expect } from "../../fixtures/e2e.js"
import { focusTerminal } from "./_launch.js"

for (const backend of ["webgl2", "canvas2d"]) {
  test(`${backend} capture preserves changed default backgrounds across frames`, async ({
    launchApp,
  }) => {
    const { page } = await launchApp()
    await page.evaluate((value) => localStorage.setItem("yaade:terminal-renderer", value), backend)
    await page.reload({ waitUntil: "domcontentloaded" })
    await focusTerminal(page)
    const panel = page
      .locator('[data-yaade-terminal-panel][data-yaade-terminal-status="running"]')
      .filter({ visible: true })
      .first()
    await expect(panel).toHaveAttribute("data-yaade-terminal-render-backend", backend)
    for (const hex of ["123456", "654321"]) {
      await page.evaluate(async (color) => {
        const id = document.querySelector<HTMLElement>(
          '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
        )?.dataset.yaadeTerminalPtyId
        if (!id || !window.yaade?.terminal) throw new Error("terminal unavailable")
        await window.yaade.terminal.write(
          id,
          `printf '\\033]11;#${color}\\007\\033[2J\\033[HCAPTURE-${color}\\n'\n`,
        )
      }, hex)
      await expect
        .poll(() => page.evaluate(() => window.__yaadeTest?.getTerminalText?.() ?? ""))
        .toContain(`CAPTURE-${hex}`)
      const applied = await page.evaluate(
        () => window.__yaadeTest?.getTerminalLifecycle?.()?.lastAppliedModelFrame ?? 0,
      )
      await expect
        .poll(() =>
          page.evaluate(
            () => window.__yaadeTest?.getTerminalLifecycle?.()?.lastNextPaintObservedFrame ?? 0,
          ),
        )
        .toBeGreaterThanOrEqual(applied)
      const expected = {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      }
      // Repeated readback must preserve the retained scene and actual clear color.
      for (let capture = 0; capture < 2; capture += 1) {
        const pixels = await page.evaluate(() => window.__yaadeTest?.getTerminalPixelStats?.())
        expect(pixels?.background).toEqual(expected)
        expect(pixels?.nonBackgroundPixels).toBeGreaterThan(100)
      }
    }
    const path = test.info().outputPath(`capture-${backend}.png`)
    await writeFile(path, Buffer.from(await page.screenshot(), "base64"))
    await test.info().attach(`capture-${backend}`, { path, contentType: "image/png" })
  })
}
