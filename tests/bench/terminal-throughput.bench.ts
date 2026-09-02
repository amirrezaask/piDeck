import { test, expect } from "@playwright/test"

/**
 * Plan 001 Canvas baseline (2026-08-29, commit ea8440be):
 * macOS 27.0, Apple M4 (10 cores, 24 GB), integrated Apple M4 GPU,
 * 2880×1864 Retina display. Playwright bench project, one visible 80×24-ish
 * terminal, provider=ghostty, backend=canvas2d. Three matched release builds:
 * stream median 232.4/236.6/239.0 ms, p95/p99 238.1/248.7/265.5 ms;
 * flood median 81.0/80.8/81.3 ms, p95/p99 81.3/98.2/96.9 ms;
 * idle typing median 11.2/11.4/11.4 ms, p95/p99 13.4/11.6/11.5 ms;
 * typing-under-flood median 13.5/14.2 ms, p95 16.3/16.2 ms, p99
 * 16.5/16.4 ms. The third under-flood sample did not start because the
 * pre-existing provider attribute raced surface initialization; the other
 * three workloads completed and the scoped readiness guard below fixes that
 * benchmark-only race.
 */
import type { ShellDriver } from "../shell/driver.js"
import {
  assertBudget,
  benchContext,
  logBenchContext,
  logBenchResult,
  median,
  percentile,
  runBench,
  type BenchResult,
} from "./_bench.js"
import { terminalDashboardCommand } from "./terminal-tui-fixture.js"
import {
  focusTerminal,
  hasPtySpawn,
  launchYaade,
  showTerminal,
} from "../web/e2e/_launch.js"

const ptyAvailable = hasPtySpawn()

async function waitForRunningTerminal(page: ShellDriver): Promise<void> {
  const panel = page.locator(
    '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
  ).filter({ visible: true }).first()
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel).toHaveAttribute("data-yaade-terminal-renderer", "ghostty")
  await expect(panel).toHaveAttribute(
    "data-yaade-terminal-render-backend",
    /^(canvas2d|webgl2)$/,
  )
}

async function terminalRenderInfo(page: ShellDriver): Promise<{
  provider: string
  backend: string
  runtime: string
  visiblePanes: number
}> {
  return page.evaluate(() => {
    const panels = [...document.querySelectorAll<HTMLElement>(
      '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
    )]
    const visible = panels.filter(panel => {
      const bounds = panel.getBoundingClientRect()
      return bounds.width > 0 && bounds.height > 0
    })
    const panel = visible[0]
    return {
      provider: panel?.dataset.yaadeTerminalRenderer ?? "unknown",
      backend: panel?.dataset.yaadeTerminalRenderBackend ?? "unknown",
      runtime: panel?.dataset.yaadeTerminalRuntime ?? "unknown",
      visiblePanes: visible.length,
    }
  })
}

function logTerminalRenderInfo(name: string, info: Awaited<ReturnType<typeof terminalRenderInfo>>): void {
  console.log(
    `[bench] ${name} provider=${info.provider} backend=${info.backend} runtime=${info.runtime} visiblePanes=${info.visiblePanes}`,
  )
}

async function resetTerminalForStreamSample(
  page: ShellDriver,
  resetMarker: string,
): Promise<void> {
  await page.evaluate(async currentMarker => {
    const panel = document.querySelector<HTMLElement>(
      '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
    )
    const ptyId = panel?.dataset.yaadeTerminalPtyId
    const terminal = window.yaade?.terminal
    if (!ptyId || !terminal) throw new Error("running terminal unavailable")

    // Keep the complete marker out of the echoed command. It must only become
    // visible after the shell executes printf and Ghostty parses the RIS reset.
    const splitAt = Math.floor(currentMarker.length / 2)
    const markerExpression =
      `'${currentMarker.slice(0, splitAt)}'` +
      `'${currentMarker.slice(splitAt)}'`
    await terminal.write(
      ptyId,
      `printf '\\033c%s\\n' ${markerExpression}\n`,
    )
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error(`terminal reset did not parse: ${currentMarker}`)),
        10_000,
      )
      const poll = () => {
        const text = window.__yaadeTest?.getTerminalText?.() ?? ""
        if (text.includes(currentMarker)) {
          window.clearTimeout(timeout)
          resolve()
          return
        }
        requestAnimationFrame(poll)
      }
      poll()
    })
  }, resetMarker)
}

test("bench terminal-stream-throughput", async () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  const { app, page } = await launchYaade()
  try {
    await showTerminal(page)
    await waitForRunningTerminal(page)
    logBenchContext("terminal-stream-throughput", await benchContext(page))
    logTerminalRenderInfo("terminal-stream", await terminalRenderInfo(page))

    let round = 0
    const result = await runBench({
      name: "terminal-stream-throughput",
      warmup: 2,
      rounds: 5,
      measure: async () => {
        const sample = round++
        await resetTerminalForStreamSample(
          page,
          `YAADE-TERMINAL-RESET-${sample}`,
        )
        const marker = `YAADE-TERMINAL-BENCH-${sample}`
        return page.evaluate(async currentMarker => {
          const panel = document.querySelector<HTMLElement>(
            '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
          )
          const ptyId = panel?.dataset.yaadeTerminalPtyId
          const terminal = window.yaade?.terminal
          if (!ptyId || !terminal) throw new Error("running terminal unavailable")

          const baselineFrame =
            window.__yaadeTest?.getTerminalLifecycle?.()?.lastNextPaintObservedFrame ?? 0
          const markerBytes = new TextEncoder().encode(currentMarker)
          let matchedMarkerBytes = 0
          let unsubscribe = () => {}
          let transportArrivedAt = 0
          const markerArrived = new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => {
              unsubscribe()
              reject(new Error(`terminal marker did not arrive: ${currentMarker}`))
            }, 30_000)
            unsubscribe = terminal.onData(ptyId, data => {
              for (const byte of data) {
                if (byte === markerBytes[matchedMarkerBytes]) {
                  matchedMarkerBytes += 1
                } else {
                  matchedMarkerBytes = byte === markerBytes[0] ? 1 : 0
                }
                if (matchedMarkerBytes !== markerBytes.length) continue
                transportArrivedAt = performance.now()
                window.clearTimeout(timeout)
                unsubscribe()
                resolve()
                return
              }
            })
          })
          // Adjacent shell literals evaluate to the marker, while their quote
          // boundary prevents PTY command echo from satisfying markerArrived.
          const splitAt = Math.floor(currentMarker.length / 2)
          const markerExpression =
            `'${currentMarker.slice(0, splitAt)}'` +
            `'${currentMarker.slice(splitAt)}'`
          const startedAt = performance.now()
          await terminal.write(
            ptyId,
            `head -c 393216 /dev/zero | tr '\\0' x; printf '\\n%s\\n' ${markerExpression}\n`,
          )
          await markerArrived
          await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(
              () => reject(new Error(`terminal marker did not present: ${currentMarker}`)),
              30_000,
            )
            const poll = () => {
              const text = window.__yaadeTest?.getTerminalText?.() ?? ""
              const frame =
                window.__yaadeTest?.getTerminalLifecycle?.()?.lastNextPaintObservedFrame ?? 0
              if (text.includes(currentMarker) && frame > baselineFrame) {
                window.clearTimeout(timeout)
                panel.dataset.yaadeTerminalBenchTransportMs = String(
                  transportArrivedAt - startedAt,
                )
                resolve()
                return
              }
              requestAnimationFrame(poll)
            }
            poll()
          })
          return performance.now() - startedAt
        }, marker)
      },
    })
    logBenchResult(result)
    assertBudget(result)
  } finally {
    await app.close()
  }
})

/**
 * Terminal/TUI-like flood: many small CSI + CR rewrite frames (not one fat blob).
 * Exercises rAF coalesce + GPU renderer under Cursor-style paint storms.
 */
test("bench terminal-output-flood-throughput", async () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  const { app, page } = await launchYaade()
  try {
    await showTerminal(page)
    await waitForRunningTerminal(page)
    logBenchContext("terminal-output-flood-throughput", await benchContext(page))

    let round = 0
    const result = await runBench({
      name: "terminal-output-flood-throughput",
      warmup: 2,
      rounds: 5,
      measure: async () => {
        const marker = `YAADE-OUTPUT-FLOOD-${round++}`
        return page.evaluate(async currentMarker => {
          const panel = document.querySelector<HTMLElement>(
            '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
          )
          const ptyId = panel?.dataset.yaadeTerminalPtyId
          const terminal = window.yaade?.terminal
          if (!ptyId || !terminal) throw new Error("running terminal unavailable")

          // Generate the flood in the PTY so host batching matches real terminal CLIs
          // (many small onData chunks), not one giant RPC write.
          // Keep the marker split in the command; terminal text includes the shell echo.
          const markerSplit = Math.floor(currentMarker.length / 2)
          const markerExpression =
            `(${JSON.stringify(currentMarker.slice(0, markerSplit))} + ` +
            `${JSON.stringify(currentMarker.slice(markerSplit))})`
          const pythonCode =
            `import sys; [sys.stdout.write(("\\x1b[?25l" if i % 2 == 0 else "\\x1b[?25h") + f"\\rprogress {i}/2000   ") or (sys.stdout.flush() if i % 16 == 0 else None) for i in range(2000)]; sys.stdout.write("\\r\\n" + ${markerExpression} + "\\n"); sys.stdout.flush()`
          const script = `python3 -c ${JSON.stringify(pythonCode)}\n`

          const baselineFrame =
            window.__yaadeTest?.getTerminalLifecycle?.()?.lastNextPaintObservedFrame ?? 0
          const startedAt = performance.now()
          await terminal.write(ptyId, script)
          await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(
              () => reject(new Error(`output flood marker did not paint: ${currentMarker}`)),
              30_000,
            )
            const poll = () => {
              const text = window.__yaadeTest?.getTerminalText?.() ?? ""
              const frame =
                window.__yaadeTest?.getTerminalLifecycle?.()?.lastNextPaintObservedFrame ?? 0
              if (text.includes(currentMarker) && frame > baselineFrame) {
                window.clearTimeout(timeout)
                resolve()
                return
              }
              requestAnimationFrame(poll)
            }
            poll()
          })
          return performance.now() - startedAt
        }, marker)
      },
    })
    logBenchResult(result)
    assertBudget(result)
  } finally {
    await app.close()
  }
})

test("bench terminal-dashboard-present-latency", async () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  const { app, page } = await launchYaade()
  try {
    await showTerminal(page)
    await waitForRunningTerminal(page)
    logBenchContext("terminal-dashboard-present-latency", await benchContext(page))
    const marker = `YAADE-TUI-${Date.now().toString(36)}`
    const command = terminalDashboardCommand({
      marker,
      hz: 30,
      seconds: 10,
      synchronized: true,
    })
    const started = await page.evaluate(() => ({
      time: performance.now(),
      frame:
        window.__yaadeTest?.getTerminalLifecycle?.()?.lastNextPaintObservedFrame ?? 0,
    }))
    await page.evaluate(async script => {
      const panel = document.querySelector<HTMLElement>(
        '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
      )
      const ptyId = panel?.dataset.yaadeTerminalPtyId
      if (!ptyId || !window.yaade?.terminal) throw new Error("running terminal unavailable")
      await window.yaade.terminal.write(ptyId, script)
    }, command)
    await page.waitForFunction(
      ({ marker: needle, frame }) => {
        const text = window.__yaadeTest?.getTerminalText?.() ?? ""
        const lifecycle = window.__yaadeTest?.getTerminalLifecycle?.()
        return text.includes(needle) &&
          (lifecycle?.lastNextPaintObservedFrame ?? 0) > frame
      },
      { marker, frame: started.frame },
      { timeout: 30_000 },
    )
    const duration = await page.evaluate(start => performance.now() - start, started.time)
    const lifecycle = await page.evaluate(() => window.__yaadeTest?.getTerminalLifecycle?.())
    console.log(
      `[bench] terminal-dashboard-present-latency duration=${duration.toFixed(1)}ms ` +
      `surface=${lifecycle?.surfaceInstanceId ?? 0} runtimeGeneration=${lifecycle?.runtimeGeneration ?? 0} ` +
      `rendererGeneration=${lifecycle?.rendererGeneration ?? 0} geometryGeneration=${lifecycle?.geometryGeneration ?? 0}`,
    )
    expect(lifecycle?.rendererRecoveries).toBe(0)
    expect(lifecycle?.lastNextPaintObservedFrame).toBeGreaterThan(started.frame)
  } finally {
    await app.close()
  }
})

/**
 * Idle key → echo paint. Target ≤1 frame (16ms median) — VS Code local feel.
 */
test("bench terminal-typing-idle", async () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  const { app, page } = await launchYaade()
  try {
    await showTerminal(page)
    await waitForRunningTerminal(page)
    logBenchContext("terminal-typing-idle", await benchContext(page))

    await focusTerminal(page)

    let idleRound = 0
    const result = await runBench({
      name: "terminal-typing-idle",
      warmup: 2,
      rounds: 8,
      measure: async () => {
        await focusTerminal(page)
        // Unique needle — shell redraw can keep total string length stable.
        const marker = `Id${idleRound++}z`
        const started = await page.evaluate(() => ({
          time: performance.now(),
          frame:
            window.__yaadeTest?.getTerminalLifecycle?.()?.lastNextPaintObservedFrame ?? 0,
        }))
        await page.keyboard.type(marker, { delay: 0 })
        await page.waitForFunction(
          ({ needle, frame }) => {
            const text = window.__yaadeTest?.getTerminalText?.() ?? ""
            const lifecycle = window.__yaadeTest?.getTerminalLifecycle?.()
            return text.includes(needle) &&
              (lifecycle?.lastNextPaintObservedFrame ?? 0) > frame
          },
          { needle: marker, frame: started.frame },
          { timeout: 10_000 },
        )
        const t1 = await page.evaluate(() => performance.now())
        const t0 = started.time
        // Per-key estimate: total / chars typed (marker length).
        return (t1 - t0) / marker.length
      },
    })
    logBenchResult(result)
    assertBudget(result)
  } finally {
    await app.close()
  }
})

/**
 * Main-thread input scheduling while a Cursor-style TUI flood is in flight.
 * Raw samples are aggregated once; a second rAF and nested percentiles would
 * add a synthetic floor and amplify one stall into every reported percentile.
 */
test("bench terminal-typing-under-flood", async () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  const { app, page } = await launchYaade()
  try {
    await showTerminal(page)
    await waitForRunningTerminal(page)
    logBenchContext("terminal-typing-under-flood", await benchContext(page))

    const renderInfo = await terminalRenderInfo(page)
    logTerminalRenderInfo("terminal-under-flood", renderInfo)
    expect(renderInfo.provider).toBe("ghostty")

    await page.evaluate(async () => {
      const panel = document.querySelector<HTMLElement>(
        '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
      )
      const ptyId = panel?.dataset.yaadeTerminalPtyId
      const terminal = window.yaade?.terminal
      if (!ptyId || !terminal) throw new Error("running terminal input unavailable")
      // Keep a real PTY flood active while Playwright drives the keyboard.
      const flood = [
        "python3 - <<'PY'",
        "import sys, time",
        "end = time.time() + 4",
        "i = 0",
        "while time.time() < end:",
        "    hide = i % 2 == 0",
        "    sys.stdout.write(('\\x1b[?25l' if hide else '\\x1b[?25h') + f'\\rprogress {i}   ')",
        "    sys.stdout.flush()",
        "    i += 1",
        "    time.sleep(1 / 60)",
        "sys.stdout.write('\\r\\n')",
        "sys.stdout.flush()",
        "PY",
        "",
      ].join("\n")
      await terminal.write(ptyId, flood)
    })
    await focusTerminal(page)
    const samples: number[] = []
    let echoed = `Uf${Date.now().toString(36)}`
    for (const character of echoed) {
      await page.keyboard.type(character)
    }
    await page.waitForFunction(
      needle => (window.__yaadeTest?.getTerminalText?.() ?? "").includes(needle),
      echoed,
    )
    for (let n = 0; n < 24; n += 1) {
      const character = String.fromCharCode(97 + (n % 26))
      const started = await page.evaluate(() => ({
        time: performance.now(),
        frame:
          window.__yaadeTest?.getTerminalLifecycle?.()?.lastNextPaintObservedFrame ?? 0,
      }))
      await page.keyboard.type(character)
      echoed += character
      await page.waitForFunction(
        ({ needle, frame }) => {
          const text = window.__yaadeTest?.getTerminalText?.() ?? ""
          const lifecycle = window.__yaadeTest?.getTerminalLifecycle?.()
          return text.includes(needle) &&
            (lifecycle?.lastNextPaintObservedFrame ?? 0) > frame
        },
        { needle: echoed, frame: started.frame },
        { timeout: 10_000 },
      )
      const ended = await page.evaluate(() => performance.now())
      samples.push(ended - started.time)
    }
    const result: BenchResult = {
      name: "terminal-typing-under-flood",
      median: median(samples),
      p95: percentile(samples, 0.95),
      p99: percentile(samples, 0.99),
      samples,
    }
    logBenchResult(result)
    assertBudget(result)
  } finally {
    await app.close()
  }
})
