import { expect } from "@playwright/test"
import { test } from "../../fixtures/e2e.js"
import { focusTerminal } from "./_launch.js"

const ptyAvailable = process.platform !== "win32"

test.describe("incremental WebGL scene submission", () => {
  test.skip(!ptyAvailable, "PTYs are unavailable on Windows")

  test("cursor-only frames do not copy or upload the retained scene", async ({ launchApp }) => {
    const { page } = await launchApp()
    await page.evaluate(() => localStorage.setItem("yaade:terminal-renderer", "webgl2"))
    await page.reload({ waitUntil: "domcontentloaded" })
    await focusTerminal(page)

    const panel = page.locator(
      '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
    ).filter({ visible: true }).first()
    await expect(panel).toHaveAttribute("data-yaade-terminal-render-backend", "webgl2")

    await expect.poll(() => page.evaluate(() => {
      const submission = window.__yaadeTest?.getTerminalLifecycle?.()?.rendererSubmission
      return submission?.lastFrame.sceneUploadBytes ?? -1
    }), { timeout: 5_000 }).toBe(0)
    const baseline = await page.evaluate(() =>
      window.__yaadeTest?.getTerminalLifecycle?.()?.rendererSubmission?.cumulative ?? null,
    )
    expect(baseline).not.toBeNull()
    if (baseline === null) return

    const after = await expect.poll(
      () => page.evaluate(
        frames => {
          const lifecycle = window.__yaadeTest?.getTerminalLifecycle?.()
          const submission = lifecycle?.rendererSubmission?.cumulative
          return submission && submission.frames >= frames + 2 ? submission : null
        },
        baseline.frames,
      ),
      { timeout: 5_000 },
    ).not.toBeNull()
    void after

    const final = await page.evaluate(() =>
      window.__yaadeTest?.getTerminalLifecycle?.()?.rendererSubmission?.cumulative ?? null,
    )
    expect(final).not.toBeNull()
    if (final === null) return
    expect(final.sceneCopyBytes - baseline.sceneCopyBytes).toBe(0)
    expect(final.sceneUploadBytes - baseline.sceneUploadBytes).toBe(0)
    expect(final.sceneCompactions - baseline.sceneCompactions).toBe(0)
    expect(final.overlayUploadBytes - baseline.overlayUploadBytes).toBeGreaterThan(0)
    expect(final.drawCalls - baseline.drawCalls).toBeLessThanOrEqual(10)
  })
})
