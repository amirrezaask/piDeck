import { writeFile } from "node:fs/promises"
import { test, expect } from "../../fixtures/e2e.js"
import { focusTerminal } from "./_launch.js"

for (const dpr of [1, 3]) {
  test(`dense CJK, emoji, and styles survive repeated atlas pressure at DPR ${dpr}`, async ({
    launchApp,
  }) => {
    const { page } = await launchApp()
    // Exercise large backing-store glyphs deterministically, without claiming
    // that the headless browser is connected to a physical high-DPR display.
    if (dpr === 3)
      await page.addInitScript(() => {
        Object.defineProperty(window, "devicePixelRatio", { get: () => 3 })
      })
    await page.evaluate(() => localStorage.setItem("yaade:terminal-renderer", "webgl2"))
    await page.reload({ waitUntil: "domcontentloaded" })
    await focusTerminal(page)
    const panel = page
      .locator('[data-yaade-terminal-panel][data-yaade-terminal-status="running"]')
      .filter({ visible: true })
      .first()
    await expect(panel).toHaveAttribute("data-yaade-terminal-render-backend", "webgl2")
    const ptyId = await panel.getAttribute("data-yaade-terminal-pty-id")
    for (let round = 0; round < 3; round += 1) {
      const before = await page.evaluate(
        () => window.__yaadeTest?.getTerminalLifecycle?.()?.lastNextPaintObservedFrame ?? 0,
      )
      await page.evaluate(async (sample) => {
        const panel = document.querySelector<HTMLElement>(
          '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
        )
        const id = panel?.dataset.yaadeTerminalPtyId
        const dims = window.__yaadeTest?.getTerminalDims?.()
        if (!id || !dims || !window.yaade?.terminal) throw new Error("terminal unavailable")
        // Unique wide glyphs fill the measured viewport, not merely scroll past it.
        const script = [
          "import sys",
          "sys.stdout.write('\\x1b[?2027h\\x1b[2J\\x1b[H')",
          `for row in range(${dims.rows - 1}):`,
          `    for col in range(${Math.max(1, Math.floor(dims.cols / 2) - 1)}):`,
          "        sys.stdout.write('\\x1b[0;' + str(1 if col % 2 else 3) + 'm' + chr(0x4e00 + row * 100 + col))",
          "    sys.stdout.write('\\x1b[0m\\r\\n')",
          `sys.stdout.write('🧑🏽‍💻 🇯🇵 1️⃣ ♥︎ 🐈 🦊 ATLAS-' + 'DONE-${sample}')`,
          "sys.stdout.flush()",
        ].join("\n")
        await window.yaade.terminal.write(id, `python3 -c '${script.replaceAll("'", "'\\''")}'\n`)
      }, round)
      await expect
        .poll(() => page.evaluate(() => window.__yaadeTest?.getTerminalText?.() ?? ""))
        .toContain(`ATLAS-DONE-${round}`)
      const applied = await page.evaluate(
        () => window.__yaadeTest?.getTerminalLifecycle?.()?.lastAppliedModelFrame ?? 0,
      )
      expect(applied).toBeGreaterThan(before)
      await expect
        .poll(() =>
          page.evaluate(
            () => window.__yaadeTest?.getTerminalLifecycle?.()?.lastNextPaintObservedFrame ?? 0,
          ),
        )
        .toBeGreaterThanOrEqual(applied)
      const state = await page.evaluate(() => window.__yaadeTest?.getTerminalLifecycle?.())
      expect(state?.rendererRecoveries).toBeLessThanOrEqual(2)
      if (dpr === 3) {
        expect(state?.rendererBackend).toBe("canvas2d")
      } else {
        expect(state?.rendererBackend).toBe("webgl2")
        expect(state?.rendererSubmission?.cumulative.currentAtlasBytes).toBeGreaterThan(
          4 * 1024 * 1024,
        )
      }
      expect(state?.rendererSubmission?.cumulative.currentAtlasBytes ?? 0).toBeLessThanOrEqual(
        16 * 1024 * 1024,
      )
      await expect(panel).toHaveAttribute("data-yaade-terminal-pty-id", ptyId ?? "")
    }
    const pixels = await page.evaluate(() => window.__yaadeTest?.getTerminalPixelStats?.())
    expect(pixels?.nonBackgroundPixels).toBeGreaterThan(1000)
    const screenshot = test.info().outputPath(`atlas-pressure-dpr-${dpr}.png`)
    await writeFile(screenshot, Buffer.from(await page.screenshot(), "base64"))
    await test
      .info()
      .attach(`atlas-pressure-dpr-${dpr}`, { path: screenshot, contentType: "image/png" })
  })
}
