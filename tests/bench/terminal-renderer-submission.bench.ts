import { expect, test } from "@playwright/test"
import { focusTerminal, hasPtySpawn, launchYaade, showTerminal } from "../web/e2e/_launch.js"
import { benchContext, logBenchContext } from "./_bench.js"

const ptyAvailable = hasPtySpawn()

test("bench incremental WebGL cursor submission counters", async () => {
  test.skip(!ptyAvailable, "PTYs are unavailable on this machine")
  const { app, page } = await launchYaade()
  try {
    await showTerminal(page)
    await page.evaluate(() => localStorage.setItem("yaade:terminal-renderer", "webgl2"))
    await page.reload({ waitUntil: "domcontentloaded" })
    await focusTerminal(page)
    logBenchContext("terminal-renderer-submission", await benchContext(page))
    const panel = page.locator(
      '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
    ).filter({ visible: true }).first()
    await expect(panel).toHaveAttribute("data-yaade-terminal-render-backend", "webgl2")

    const marker = "YAADE_RENDERER_BENCH_READY"
    await page.keyboard.type(`printf '${marker}\\n'`)
    await page.keyboard.press("Enter")
    await expect.poll(
      () => page.evaluate(() => window.__yaadeTest?.getTerminalText?.() ?? ""),
      { timeout: 10_000 },
    ).toContain(marker)
    await expect.poll(() => page.evaluate(() =>
      window.__yaadeTest?.getTerminalLifecycle?.()?.rendererSubmission?.cumulative
        .currentUsedSceneBytes ?? 0,
    ), { timeout: 5_000 }).toBeGreaterThan(0)
    // Start only after a warm cursor/focus-only frame. Initial shell geometry and
    // row topology are correctness setup, not incremental cursor submission.
    await expect.poll(() => page.evaluate(() => {
      const submission = window.__yaadeTest?.getTerminalLifecycle?.()?.rendererSubmission
      return submission?.lastFrame.sceneUploadBytes ?? -1
    }), { timeout: 5_000 }).toBe(0)
    const baseline = await page.evaluate(() =>
      window.__yaadeTest?.getTerminalLifecycle?.()?.rendererSubmission?.cumulative ?? null,
    )
    expect(baseline).not.toBeNull()
    if (baseline === null) return
    await expect.poll(() => page.evaluate(
      frames => (window.__yaadeTest?.getTerminalLifecycle?.()?.rendererSubmission?.cumulative.frames ?? 0) - frames,
      baseline.frames,
    ), { timeout: 5_000 }).toBeGreaterThanOrEqual(2)
    const lifecycle = await page.evaluate(() => window.__yaadeTest?.getTerminalLifecycle?.() ?? null)
    const final = lifecycle?.rendererSubmission?.cumulative
    expect(final).toBeDefined()
    if (!final) return
    const result = {
      frames: final.frames - baseline.frames,
      sceneCopyBytes: final.sceneCopyBytes - baseline.sceneCopyBytes,
      sceneUploadBytes: final.sceneUploadBytes - baseline.sceneUploadBytes,
      sceneCompactions: final.sceneCompactions - baseline.sceneCompactions,
      overlayUploadBytes: final.overlayUploadBytes - baseline.overlayUploadBytes,
      drawCalls: final.drawCalls - baseline.drawCalls,
      cpu: lifecycle?.rendererCpuMs,
      usedSceneBytes: final.currentUsedSceneBytes,
      allocatedBufferBytes: final.currentAllocatedBufferBytes,
    }
    console.log(`[bench] terminal-renderer-submission ${JSON.stringify(result)}`)
    expect(result.sceneCopyBytes).toBe(0)
    expect(result.sceneUploadBytes).toBe(0)
    expect(result.sceneCompactions).toBe(0)
    expect(result.overlayUploadBytes).toBeGreaterThan(0)
    expect(result.drawCalls).toBeLessThanOrEqual(result.frames * 5)
  } finally {
    await app.close()
  }
})
