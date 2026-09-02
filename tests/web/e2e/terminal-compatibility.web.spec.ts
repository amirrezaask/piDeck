import { expect } from "@playwright/test"
import { resolve } from "node:path"
import { test } from "../../fixtures/e2e.js"
import { focusTerminal, REPO_ROOT } from "./_launch.js"

const ptyAvailable = process.platform !== "win32"
const backgroundQueryFixture = resolve(
  REPO_ROOT,
  "fixtures/terminal-background-query.mjs",
)
const themeUpdatesFixture = resolve(
  REPO_ROOT,
  "fixtures/terminal-theme-updates.mjs",
)

test.describe("terminal compatibility", () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  test("terminal input preserves the host connection and browser zoom", async ({ launchApp }) => {
    const { page } = await launchApp()
    await page.evaluate(() => {
      history.pushState(null, "", "/")
      window.dispatchEvent(new Event("popstate"))
    })
    await expect(page.locator('[data-yaade-shell="terminal-multiplexer"]')).toBeVisible()
    await page.evaluate(() => window.__yaadeTest!.waitForReady())
    const muxTerminalId = await page.evaluate(async () => {
      const terminals = window.yaade?.mux
      const state = window.__yaadeTest?.getState()
      const sessionId = state?.activeSessionId
      if (state?.activeMuxTerminalId) return state.activeMuxTerminalId
      if (!terminals || !sessionId) throw new Error("terminal API or session missing")
      const created = await terminals.createTerminal({
        _tag: "CreateTerminal",
        sessionId,
        kind: "terminal",
        input: { _tag: "TerminalInput", kind: "terminal" },
      })
      await window.__yaadeTest?.selectMuxTerminal?.(created.id)
      return created.id
    })
    const surface = page.locator(
      `[data-yaade-terminal-tile="${muxTerminalId}"] [data-ghostty-terminal-canvas], [data-yaade-terminal-tile="${muxTerminalId}"] [data-yaade-terminal-semantic]`,
    )
    await expect(surface).toBeVisible({ timeout: 30_000 })
    await surface.click()
    await page.keyboard.type("echo reconnect-probe")
    await page.keyboard.press("Enter")
    await expect(page.locator("[data-yaade-connection]")).toHaveCount(0)
    await expect
      .poll(
        () =>
          page.evaluate(
            id => window.__yaadeTest?.getTerminalText?.(id) ?? "",
            muxTerminalId,
          ),
        { timeout: 10_000 },
      )
      .toMatch(/reconnect-probe|echo/)

    const terminalInput = page.locator(
      `[data-yaade-terminal-tile="${muxTerminalId}"] [data-ghostty-terminal-input]`,
    )
    await expect(terminalInput).toHaveCount(1)
    await expect(terminalInput).toBeFocused()
    await terminalInput.evaluate(element => {
      element.addEventListener("keydown", event => {
        if (
          event instanceof KeyboardEvent &&
          (event.metaKey || event.ctrlKey) &&
          (event.code === "Equal" || event.key === "+" || event.key === "=")
        ) {
          element.setAttribute(
            "data-yaade-test-zoom-default-prevented",
            String(event.defaultPrevented),
          )
        }
      })
    })
    const zoomModifier = process.platform === "darwin" ? "Meta" : "Control"
    await page.keyboard.down(zoomModifier)
    await page.keyboard.down("Shift")
    await page.keyboard.press("=")
    await page.keyboard.up("Shift")
    await page.keyboard.up(zoomModifier)
    await expect(terminalInput).toHaveAttribute(
      "data-yaade-test-zoom-default-prevented",
      "false",
    )

    const terminalCanvas = page.locator(
      `[data-yaade-terminal-tile="${muxTerminalId}"] [data-ghostty-terminal-canvas]`,
    )
    await terminalCanvas.evaluate(element => {
      element.addEventListener("wheel", event => {
        if (event instanceof WheelEvent && event.ctrlKey) {
          element.setAttribute(
            "data-yaade-test-zoom-default-prevented",
            String(event.defaultPrevented),
          )
        }
      })
    })
    await terminalCanvas.hover()
    await page.keyboard.down("Control")
    await page.mouse.wheel(0, -100)
    await page.keyboard.up("Control")
    await expect(terminalCanvas).toHaveAttribute(
      "data-yaade-test-zoom-default-prevented",
      "false",
    )
  })

  test("renders UTF-8 code points split across PTY reads", async ({ launchApp }) => {
    const { page } = await launchApp()
    await focusTerminal(page)
    await page.keyboard.type(
      `node -e "const b=Buffer.from([0xe2,0x94,0x80]);let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length){clearInterval(t);console.log(' YAADE_UTF8_OK')}},50)"`,
    )
    await page.keyboard.press("Enter")

    const terminalText = () =>
      page.evaluate(() => {
        const id = window.__yaadeTest?.getState().activeMuxTerminalId
        return id ? window.__yaadeTest?.getTerminalText?.(id) ?? "" : ""
      })
    await expect.poll(terminalText, { timeout: 15_000 }).toContain("─ YAADE_UTF8_OK")
    expect(await terminalText()).not.toContain("�")
  })

  test("reports the configured background color to terminal applications", async ({
    launchApp,
  }) => {
    const { page } = await launchApp()
    const queryBackground = async (terminalId: string, expected: string) => {
      const panel = page.locator(
        `[data-yaade-terminal-tile="${terminalId}"] [data-yaade-terminal-panel]`,
      )
      await expect(panel).toHaveAttribute("data-yaade-terminal-status", "running", {
        timeout: 30_000,
      })
      await panel.locator(".yaade-terminal-surface").click()
      await panel.locator("[data-ghostty-terminal-input]").focus()
      await page.keyboard.type(`node ${JSON.stringify(backgroundQueryFixture)}`)
      await page.keyboard.press("Enter")

      const terminalText = () =>
        page.evaluate(
          id => window.__yaadeTest?.getTerminalText?.(id) ?? "",
          terminalId,
        )
      await expect.poll(terminalText, { timeout: 15_000 }).toContain(
        `YAADE_TERMINAL_QUERY_RESPONSE:${expected}`,
      )
      expect(await terminalText()).not.toMatch(/E1568|Terminal did not respond/)
    }

    const initialTerminalId = await page.evaluate(() => {
      const terminalId = window.__yaadeTest?.getState().activeMuxTerminalId
      if (!terminalId) throw new Error("active terminal missing")
      return terminalId
    })
    await queryBackground(initialTerminalId, "0e0e/1515/1b1b")

    await page.emulateMedia({ colorScheme: "light" })
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--yaade-terminal-background")
            .trim(),
        ),
      )
      .toBe("#e0e3e7")

    const lightTerminalId = await page.evaluate(async () => {
      const terminals = window.yaade?.mux
      const sessionId = window.__yaadeTest?.getState().activeSessionId
      if (!terminals || !sessionId) throw new Error("terminal API or session missing")
      const created = await terminals.createTerminal({
        _tag: "CreateTerminal",
        sessionId,
        kind: "terminal",
        input: { _tag: "TerminalInput", kind: "terminal" },
      })
      await window.__yaadeTest?.selectMuxTerminal?.(created.id)
      return created.id
    })
    await queryBackground(lightTerminalId, "e0e0/e3e3/e7e7")
  })

  test("notifies terminal applications when the color scheme changes", async ({
    launchApp,
  }) => {
    const { page } = await launchApp()
    const terminalId = await page.evaluate(() => {
      const id = window.__yaadeTest?.getState().activeMuxTerminalId
      if (!id) throw new Error("active terminal missing")
      return id
    })
    const panel = page.locator(
      `[data-yaade-terminal-tile="${terminalId}"] [data-yaade-terminal-panel]`,
    )
    await expect(panel).toHaveAttribute("data-yaade-terminal-status", "running", {
      timeout: 30_000,
    })
    await focusTerminal(page)
    await expect(panel.locator("[data-ghostty-terminal-input]")).toBeFocused()
    await page.keyboard.type(`node ${JSON.stringify(themeUpdatesFixture)}`)
    await page.keyboard.press("Enter")

    const terminalText = () =>
      page.evaluate(
        id => window.__yaadeTest?.getTerminalText?.(id) ?? "",
        terminalId,
      )
    await expect.poll(terminalText, { timeout: 15_000 }).toContain(
      "YAADE_TERMINAL_THEME_READY:2:0e0e/1515/1b1b",
    )

    await page.emulateMedia({ colorScheme: "light" })
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--yaade-terminal-background")
            .trim(),
        ),
      )
      .toBe("#e0e3e7")
    await expect.poll(terminalText, { timeout: 15_000 }).toContain(
      "YAADE_TERMINAL_THEME_UPDATED:2:e0e0/e3e3/e7e7",
    )
    expect(await terminalText()).not.toContain("YAADE_TERMINAL_THEME_ERROR")
  })

  test("default worker runtime preserves key and Unicode input order", async ({
    launchApp,
  }) => {
    const { page } = await launchApp()
    await focusTerminal(page)
    const panel = page.locator(
      '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
    ).filter({ visible: true }).first()
    await expect(panel).toHaveAttribute("data-yaade-terminal-runtime", "worker")
    await page.keyboard.type("printf 'ordered-界-é-🙂\\n'")
    await page.keyboard.press("Enter")
    await expect.poll(
      () => page.evaluate(() => window.__yaadeTest?.getTerminalText?.() ?? ""),
      { timeout: 15_000 },
    ).toContain("ordered-界-é-🙂")
    await expect(panel).toHaveAttribute("data-yaade-terminal-pipeline-pending-bytes", "0")
    await expect(panel).toHaveAttribute("data-yaade-terminal-pipeline-parsed-p95", /\d+\.\d/)
    await expect(panel).toHaveAttribute("data-yaade-terminal-pipeline-presented-p95", /\d+\.\d/)
  })

  test("forced WebGL2 and Canvas backends render the same retained text", async ({
    launchApp,
  }) => {
    const backends: readonly ("webgl2" | "canvas2d")[] = ["webgl2", "canvas2d"]
    const captures: { width: number; height: number; nonBackgroundPixels: number }[] = []
    for (const backend of backends) {
      const { page } = await launchApp()
      await page.evaluate(value => localStorage.setItem("yaade:terminal-renderer", value), backend)
      await page.reload({ waitUntil: "domcontentloaded" })
      await focusTerminal(page)
      const panel = page.locator(
        '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
      ).filter({ visible: true }).first()
      await expect(panel).toHaveAttribute("data-yaade-terminal-renderer", "ghostty")
      await expect(panel).toHaveAttribute("data-yaade-terminal-render-backend", backend)
      await page.keyboard.type("printf '\\033cASCII wide:界 combining:é emoji:🙂 underline'")
      await page.keyboard.press("Enter")
      await expect.poll(
        () => page.evaluate(() => window.__yaadeTest?.getTerminalText?.() ?? ""),
        { timeout: 15_000 },
      ).toContain("ASCII wide:界 combining:é emoji:🙂 underline")
      const pixelStats = await page.evaluate(
        () => window.__yaadeTest?.getTerminalPixelStats?.() ?? Promise.resolve(null),
      )
      expect(pixelStats?.width).toBeGreaterThan(0)
      expect(pixelStats?.height).toBeGreaterThan(0)
      expect(pixelStats?.nonBackgroundPixels).toBeGreaterThan(100)
      if (pixelStats) captures.push(pixelStats)
    }
    expect(captures).toHaveLength(2)
    expect(captures[0]?.width).toBe(captures[1]?.width)
    expect(captures[0]?.height).toBe(captures[1]?.height)
    const pixelRatio =
      (captures[0]?.nonBackgroundPixels ?? 0) /
      Math.max(1, captures[1]?.nonBackgroundPixels ?? 0)
    expect(pixelRatio).toBeGreaterThan(0.5)
    expect(pixelRatio).toBeLessThan(2)
  })

  test("renderer context loss recovers without replacing the PTY or retained text", async ({
    launchApp,
  }) => {
    const { page } = await launchApp()
    await page.evaluate(() => localStorage.setItem("yaade:terminal-renderer", "webgl2"))
    await page.reload({ waitUntil: "domcontentloaded" })
    await focusTerminal(page)
    const panel = page.locator(
      '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
    ).filter({ visible: true }).first()
    await expect(panel).toHaveAttribute("data-yaade-terminal-render-backend", "webgl2")
    const ptyId = await panel.getAttribute("data-yaade-terminal-pty-id")
    await page.keyboard.type("printf 'before-loss\\n'")
    await page.keyboard.press("Enter")
    await expect.poll(
      () => page.evaluate(() => window.__yaadeTest?.getTerminalText?.() ?? ""),
    ).toContain("before-loss")
    await panel.locator("[data-ghostty-terminal-canvas]").evaluate(element => {
      element.dispatchEvent(new Event("webglcontextlost", { cancelable: true }))
    })
    await expect(panel.locator("[data-ghostty-terminal]")).toHaveAttribute(
      "data-ghostty-terminal-renderer-generation",
      "2",
    )
    await page.keyboard.type("printf 'after-loss\\n'")
    await page.keyboard.press("Enter")
    await expect.poll(
      () => page.evaluate(() => window.__yaadeTest?.getTerminalText?.() ?? ""),
      { timeout: 15_000 },
    ).toContain("after-loss")
    await expect(panel).toHaveAttribute("data-yaade-terminal-pty-id", ptyId ?? "")
    await expect(page.locator("[data-yaade-connection]")).toHaveCount(0)
  })

  test("synchronized output has a bounded presentation safety timeout", async ({
    launchApp,
  }) => {
    const { page } = await launchApp({ workspaceRel: "fixtures/sample-workspace" })
    const before = await page.evaluate(
      () => window.__yaadeTest?.getTerminalLifecycle()?.workerDiagnostics,
    )
    await focusTerminal(page)
    await page.keyboard.type(
      `printf '\\033[?2026h%s' 'YAADE_SYNC_' 'TIMEOUT'; sleep 3; printf '\\033[?2026l\\n'`,
    )
    await page.keyboard.press("Enter")
    await expect.poll(
      () => page.evaluate(
        () => window.__yaadeTest?.getTerminalLifecycle()?.workerDiagnostics.synchronizationTimeouts ?? 0,
      ),
      { timeout: 5_000 },
    ).toBeGreaterThan(before?.synchronizationTimeouts ?? 0)
    await expect.poll(
      () => page.evaluate(
        () => window.__yaadeTest?.getTerminalLifecycle()?.workerDiagnostics.suppressedSynchronized ?? 0,
      ),
    ).toBeGreaterThan(before?.suppressedSynchronized ?? 0)
    await expect.poll(
      () => page.evaluate(
        () => window.__yaadeTest?.getTerminalLifecycle()?.workerDiagnostics.fullCatchUps ?? 0,
      ),
    ).toBeGreaterThan(before?.fullCatchUps ?? 0)
    await expect.poll(
      () => page.evaluate(() => window.__yaadeTest?.getTerminalText?.() ?? ""),
    ).toContain("YAADE_SYNC_TIMEOUT")
  })

  test("idle high-water trim preserves the first resumed WebGL frame", async ({ launchApp }) => {
    const { page } = await launchApp({ workspaceRel: "fixtures/sample-workspace" })
    const terminalId = await page.evaluate(
      () => window.__yaadeTest?.getState().activeMuxTerminalId ?? null,
    )
    expect(terminalId).not.toBeNull()
    await page.setViewportSize({ width: 12_000, height: 700 })
    await expect.poll(
      () => page.evaluate(id => window.__yaadeTest?.getTerminalDims(id)?.cols ?? 0, terminalId),
      { timeout: 15_000 },
    ).toBeGreaterThan(1_000)
    await focusTerminal(page)
    await page.keyboard.type(
      `node -e "process.stdout.write('X'.repeat(30000));console.log('\\nYAADE_HIGH_WATER')"`,
    )
    await page.keyboard.press("Enter")
    await expect.poll(
      () => page.evaluate(id =>
        window.__yaadeTest?.getTerminalLifecycle(id)?.rendererSubmission?.cumulative
          .currentUsedSceneBytes ?? 0,
      terminalId),
      { timeout: 30_000 },
    ).toBeGreaterThan(1024 * 1024)
    const highWater = await page.evaluate(id => {
      const submission = window.__yaadeTest?.getTerminalLifecycle(id)?.rendererSubmission?.cumulative
      if (!submission) return null
      return {
        frame: submission.frames,
        used: submission.currentUsedSceneBytes,
        allocated: submission.currentAllocatedCpuBytes + submission.currentAllocatedBufferBytes,
      }
    }, terminalId)
    expect(highWater).not.toBeNull()
    expect(highWater?.used ?? 0).toBeGreaterThan(1024 * 1024)

    await page.setViewportSize({ width: 1_280, height: 800 })
    await expect.poll(
      () => page.evaluate(id => window.__yaadeTest?.getTerminalDims(id)?.cols ?? 0, terminalId),
      { timeout: 15_000 },
    ).toBeLessThan(300)
    await expect.poll(
      () => page.evaluate(id =>
        window.__yaadeTest?.getTerminalLifecycle(id)?.rendererSubmission?.cumulative.frames ?? 0,
      terminalId),
    ).toBeGreaterThan(highWater?.frame ?? 0)
    await expect.poll(() => page.evaluate(id => {
      const value = window.__yaadeTest?.getTerminalLifecycle(id)?.rendererSubmission?.cumulative
      if (!value) return false
      const allocated = value.currentAllocatedCpuBytes + value.currentAllocatedBufferBytes
      return allocated >= value.currentTargetTransientBytes * 2 &&
        allocated - value.currentTargetTransientBytes >= 1024 * 1024
    }, terminalId)).toBe(true)
    const beforeTrim = await page.evaluate(id => {
      const submission = window.__yaadeTest?.getTerminalLifecycle(id)?.rendererSubmission?.cumulative
      return submission
        ? submission.currentAllocatedCpuBytes + submission.currentAllocatedBufferBytes
        : 0
    }, terminalId)
    expect(await page.evaluate(
      id => window.__yaadeTest?.maintainTerminalIdleCapacity(id) ?? false,
      terminalId,
    )).toBe(true)
    const afterTrim = await page.evaluate(id => {
      const submission = window.__yaadeTest?.getTerminalLifecycle(id)?.rendererSubmission?.cumulative
      return submission
        ? {
            allocated: submission.currentAllocatedCpuBytes + submission.currentAllocatedBufferBytes,
            trims: submission.idleTrims,
            reclaimed: submission.idleBytesReclaimed,
            regrows: submission.idleRegrows,
          }
        : null
    }, terminalId)
    expect(afterTrim?.allocated ?? Number.POSITIVE_INFINITY).toBeLessThan(beforeTrim)
    expect(afterTrim?.trims).toBe(1)
    expect(afterTrim?.reclaimed ?? 0).toBeGreaterThanOrEqual(1024 * 1024)
    expect(afterTrim?.regrows).toBe(0)

    await focusTerminal(page)
    await page.keyboard.type("printf 'YAADE_TRIM_%s\\n' 'RESUMED'")
    await page.keyboard.press("Enter")
    await expect.poll(
      () => page.evaluate(id => window.__yaadeTest?.getTerminalText(id) ?? "", terminalId),
      { timeout: 15_000 },
    ).toContain("YAADE_TRIM_RESUMED")
    await expect.poll(
      () => page.evaluate(async id =>
        (await window.__yaadeTest?.getTerminalPixelStats(id))?.nonBackgroundPixels ?? 0,
      terminalId),
    ).toBeGreaterThan(0)
    expect(await page.evaluate(id =>
      window.__yaadeTest?.getTerminalLifecycle(id)?.rendererSubmission?.cumulative.idleRegrows ?? 0,
    terminalId)).toBeLessThanOrEqual(1)
    expect(await page.evaluate(
      id => window.__yaadeTest?.maintainTerminalIdleCapacity(id) ?? false,
      terminalId,
    )).toBe(false)
  })

  test("flow control replays from the last parsed frame after a renderer stall", async ({
    launchApp,
  }) => {
    const { page } = await launchApp({
      workspaceRel: "fixtures/sample-workspace",
      env: {
        YAADE_TERMINAL_UNACKNOWLEDGED_BYTES: String(64 * 1024),
      },
    })
    await focusTerminal(page)
    await page.evaluate(() => {
      window.addEventListener("yaade:terminal-replay-required", () => {
        const current = Number(
          document.documentElement.dataset.yaadeTestReplayRequired ?? "0",
        )
        document.documentElement.dataset.yaadeTestReplayRequired = String(
          current + 1,
        )
      })
    })
    await page.keyboard.type(
      `node -e "process.stdout.write('x'.repeat(512*1024));console.log('\\nYAADE_FLOW_RECOVERED')"`,
    )
    await page.keyboard.press("Enter")

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const id = window.__yaadeTest?.getState().activeMuxTerminalId
            return id ? window.__yaadeTest?.getTerminalText?.(id) ?? "" : ""
          }),
        { timeout: 90_000, intervals: [250, 500, 1_000] },
      )
      .toContain("YAADE_FLOW_RECOVERED")
    await expect(page.locator("html")).toHaveAttribute(
      "data-yaade-test-replay-required",
      /[1-9]\d*/,
    )
    await expect(page.locator("[data-yaade-connection]")).toHaveCount(0)
  })
})
