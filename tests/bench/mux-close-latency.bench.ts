import { expect, test } from "@playwright/test"
import { benchContext, logBenchContext, percentile } from "./_bench.js"
import { hasPtySpawn, launchYaade, showTerminal } from "../web/e2e/_launch.js"

const ptyAvailable = hasPtySpawn()

test("bench optimistic Window close next-paint latency", async () => {
  test.skip(!ptyAvailable, "PTYs are unavailable on this machine")
  const { app, page } = await launchYaade()
  try {
    await showTerminal(page)
    await expect(page.locator("[data-yaade-window-tabs]")).toBeVisible()
    logBenchContext("mux-window-close-next-paint", await benchContext(page))
    const samples: number[] = []
    for (let round = 0; round < 7; round += 1) {
      await page.evaluate(() => window.__yaadeTest?.createTab?.())
      await expect(page.locator("[data-yaade-session-tab]")).toHaveCount(2)
      await expect.poll(() => page.evaluate(() =>
        window.__yaadeTest?.getState().muxTerminals?.length ?? 0,
      ), { timeout: 15_000 }).toBe(2)
      const closeButton = page.locator("[data-yaade-session-tab]").last()
        .getByRole("button", { name: /^Close Window/ })
      const measurement = page.evaluate(() => new Promise<number>((resolve, reject) => {
        const tabs = [...document.querySelectorAll<HTMLElement>("[data-yaade-session-tab]")]
        const button = tabs.at(-1)?.querySelector<HTMLButtonElement>('button[aria-label^="Close Window"]')
        if (!button) {
          reject(new Error("Window close control is unavailable"))
          return
        }
        let startedAt = 0
        button.addEventListener("pointerdown", () => { startedAt = performance.now() }, { once: true })
        const observer = new MutationObserver(() => {
          if (startedAt === 0 || document.querySelectorAll("[data-yaade-session-tab]").length !== 1) return
          observer.disconnect()
          requestAnimationFrame(() => resolve(performance.now() - startedAt))
        })
        observer.observe(document.body, { childList: true, subtree: true })
        window.setTimeout(() => {
          observer.disconnect()
          reject(new Error("Window did not close"))
        }, 5_000)
      }))
      await closeButton.click()
      samples.push(await measurement)
      await expect.poll(() => page.evaluate(async () => {
        const state = window.__yaadeTest?.getState()
        if (!state?.activeSessionId || !window.yaade?.mux) return -1
        const snapshot = await window.yaade.mux.getSession(state.activeSessionId)
        return snapshot?.tabs?.length ?? -1
      }), { timeout: 10_000 }).toBe(1)
    }
    const p95 = percentile(samples, 0.95)
    console.log(`[bench] mux-window-close-next-paint p95=${p95.toFixed(1)}ms samples=${samples.map(value => value.toFixed(1)).join(",")}`)
    expect(p95).toBeLessThanOrEqual(50)
  } finally {
    await app.close()
  }
})
