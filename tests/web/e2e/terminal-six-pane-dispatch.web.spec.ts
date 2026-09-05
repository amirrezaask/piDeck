import { test, expect } from "../../fixtures/e2e.js"
import { focusTerminal } from "./_launch.js"

test("six panes drain concurrent bounded bursts without replacing their PTYs", async ({
  launchApp,
}) => {
  const { page } = await launchApp()
  await focusTerminal(page)
  const panels = page.locator('[data-yaade-terminal-panel][data-yaade-terminal-status="running"]')
  for (let count = 1; count < 6; count += 1) {
    const largest = await page.evaluate(() => {
      let index = 0
      let area = 0
      document
        .querySelectorAll<HTMLElement>("[data-yaade-panel-leaf]")
        .forEach((pane, candidate) => {
          const rect = pane.getBoundingClientRect()
          if (rect.width * rect.height > area) {
            index = candidate
            area = rect.width * rect.height
          }
        })
      return index
    })
    await page
      .locator("[data-yaade-panel-leaf]")
      .nth(largest)
      .locator(`[data-yaade-mux-split="${count % 2 ? "right" : "down"}"]`)
      .click({ force: true })
    await expect(panels).toHaveCount(count + 1)
  }
  await page.waitForFunction(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
      ),
    ].every((panel) => {
      const state = window.__yaadeTest?.getTerminalLifecycle?.(panel.dataset.yaadeTerminalTabId)
      return (state?.snapshotRestoreCount ?? 0) > 0 && (state?.lastSubmittedModelFrame ?? 0) > 0
    }),
  )
  const before = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
      ),
    ].map((panel) => {
      const tab = panel.dataset.yaadeTerminalTabId
      const pty = panel.dataset.yaadeTerminalPtyId
      if (!tab || !pty) throw new Error("terminal identity unavailable")
      return {
        tab,
        pty,
        parsed: window.__yaadeTest?.getTerminalLifecycle?.(tab)?.workerDiagnostics.bytesParsed ?? 0,
      }
    }),
  )
  // Finite 1 MiB bursts test client progress, not continuous six-pane saturation.
  await page.evaluate(async (terminals) => {
    await Promise.all(
      terminals.map(async ({ pty }, index) => {
        await window.yaade?.terminal.write(
          pty,
          `head -c 1048576 /dev/zero | tr '\\0' x; printf '\\nSIX-PANE-%s\\n' ${index}\n`,
        )
      }),
    )
  }, before)
  for (let index = 0; index < before.length; index += 1) {
    const terminal = before[index]!
    await expect
      .poll(() =>
        page.evaluate(
          (tab) =>
            window.__yaadeTest?.getTerminalLifecycle?.(tab)?.workerDiagnostics.bytesParsed ?? 0,
          terminal.tab,
        ),
      )
      .toBeGreaterThan(terminal.parsed + 1048576)
    const panel = page.locator(
      `[data-yaade-terminal-panel][data-yaade-terminal-tab-id="${terminal.tab}"]`,
    )
    // Splitting/resizing can leave an inspecting viewport anchored in history.
    // Parsing must finish independently; then explicitly inspect the live tail.
    await page.evaluate(
      (tab) => window.__yaadeTest?.scrollTerminalLines?.(1_000_000, tab),
      terminal.tab,
    )
    await expect
      .poll(() =>
        page.evaluate((tab) => window.__yaadeTest?.getTerminalText?.(tab) ?? "", terminal.tab),
      )
      .toContain(`SIX-PANE-${index}`)
    await expect(panel).toHaveAttribute("data-yaade-terminal-pty-id", terminal.pty)
    await expect(panel).toHaveAttribute("data-yaade-terminal-pipeline-pending-bytes", "0")
    const state = await page.evaluate(
      (tab) => window.__yaadeTest?.getTerminalLifecycle?.(tab),
      terminal.tab,
    )
    expect(state?.workerDiagnostics.slotsInFlight).toBeLessThanOrEqual(3)
  }
})
