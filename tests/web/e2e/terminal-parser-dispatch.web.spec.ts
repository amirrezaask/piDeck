import { test, expect } from "../../fixtures/e2e.js"
import { focusTerminal } from "./_launch.js"

declare global {
  interface Window {
    __resumeTerminalFrames?: () => void
  }
}

test("16 MiB of output reaches the retained model while rAF is suspended", async ({
  launchApp,
}) => {
  const { page } = await launchApp()
  await focusTerminal(page)
  await expect
    .poll(() => page.evaluate(() => window.__yaadeTest?.getTerminalLifecycle?.()?.runtimeKind))
    .toBe("worker")
  const before = await page.evaluate(async () => {
    // Drain already-requested presentation callbacks before gating new ones.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const request = window.requestAnimationFrame.bind(window)
    const cancel = window.cancelAnimationFrame.bind(window)
    const held = new Map<number, FrameRequestCallback>()
    let id = 1_000_000_000
    window.requestAnimationFrame = (callback) => {
      held.set(++id, callback)
      return id
    }
    window.cancelAnimationFrame = (frame) => {
      if (!held.delete(frame)) cancel(frame)
    }
    window.__resumeTerminalFrames = () => {
      window.requestAnimationFrame = request
      window.cancelAnimationFrame = cancel
      for (const callback of held.values()) request(callback)
      held.clear()
      delete window.__resumeTerminalFrames
    }
    return window.__yaadeTest?.getTerminalLifecycle?.()
  })
  try {
    await page.evaluate(async () => {
      const panel = document.querySelector<HTMLElement>(
        '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
      )
      const id = panel?.dataset.yaadeTerminalPtyId
      if (!id || !window.yaade?.terminal) throw new Error("terminal unavailable")
      await window.yaade.terminal.write(
        id,
        "head -c 16777216 /dev/zero | tr '\\0' x; printf '\\r\\n%s%s\\n' 'PARSER-' 'WITHOUT-PAINT'\n",
      )
    })
    // RPC polling deliberately does not depend on the gated rAF clock.
    await expect
      .poll(() => page.evaluate(() => window.__yaadeTest?.getTerminalText?.() ?? ""), {
        timeout: 30_000,
      })
      .toContain("PARSER-WITHOUT-PAINT")
    const after = await page.evaluate(() => window.__yaadeTest?.getTerminalLifecycle?.())
    expect(after?.workerDiagnostics.bytesParsed).toBeGreaterThan(
      (before?.workerDiagnostics.bytesParsed ?? 0) + 16 * 1024 * 1024,
    )
    // A late font/geometry fit may submit synchronously. It cannot release
    // the gated next-rAF observation or account for the subsequent model.
    expect(after?.lastNextPaintObservedFrame).toBe(before?.lastNextPaintObservedFrame)
    expect(after?.lastAppliedModelFrame).toBeGreaterThan(after?.lastSubmittedModelFrame ?? 0)
    expect(after?.workerDiagnostics.slotsInFlight).toBeLessThanOrEqual(3)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.querySelector<HTMLElement>(
              '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
            )?.dataset.yaadeTerminalPipelinePendingBytes,
        ),
      )
      .toBe("0")
  } finally {
    await page.evaluate(() => window.__resumeTerminalFrames?.())
  }
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__yaadeTest?.getTerminalLifecycle?.()?.lastNextPaintObservedFrame ?? 0,
      ),
    )
    .toBeGreaterThan(before?.lastNextPaintObservedFrame ?? 0)
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number(
          document.querySelector<HTMLElement>(
            '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
          )?.dataset.yaadeTerminalPipelinePresentedP95 ?? 0,
        ),
      ),
    )
    .toBeGreaterThan(0)
})
