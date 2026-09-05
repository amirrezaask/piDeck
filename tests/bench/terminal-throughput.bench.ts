import { test, expect } from "@playwright/test"
import { writeFileSync } from "node:fs"

/**
 * Plan 001 Canvas baseline (2026-08-29, commit ea8440be):
 * macOS 27.0, Apple M4 (10 cores, 24 GB), integrated Apple M4 GPU,
 * 2880×1864 Retina display. Playwright bench project, one visible 80×24-ish
 * terminal, provider=ghostty, backend=canvas2d. Three matched release builds:
 * stream median 232.4/236.6/239.0 ms, p95/p99 238.1/248.7/265.5 ms;
 * flood median 81.0/80.8/81.3 ms, p95/p99 81.3/98.2/96.9 ms;
 * Historical idle numbers below are invalid per-key estimates (marker duration
 * divided by character count), retained only as provenance, not a baseline:
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
import { focusTerminal, hasPtySpawn, launchYaade, showTerminal } from "../web/e2e/_launch.js"

import slos from "./slos.json"
import { validateRefreshProfile } from "./slo-policy.mjs"
import { terminalLoadProgram } from "./terminal-load-fixture.js"

function loadCommand(rate: number, burstBytes: number, seconds: number): string {
  const path = test.info().outputPath("terminal-load.py")
  writeFileSync(path, terminalLoadProgram(rate, burstBytes, seconds), { mode: 0o600 })
  return `python3 '${path.replaceAll("'", "'\\''")}'\n`
}

const ptyAvailable = hasPtySpawn()
const refreshHz = Number(process.env.YAADE_BENCH_DISPLAY_HZ ?? slos.profile.defaultRefreshHz)
const idleObjective = slos.objectives.find(
  (objective) => objective.metric === "terminal-key-next-raf-idle",
)!
const loadObjective = slos.objectives.find(
  (objective) => objective.metric === "terminal-key-next-raf-loaded-1pane",
)!

type KeyLatencySample = {
  workerPostedMs: number
  inputSentMs: number
  echoMs: number
  modelAppliedMs: number
  submittedMs: number
  nextRafProxyMs: number
}

declare global {
  interface Window {
    __terminalKeySample?: Promise<KeyLatencySample>
  }
}

/** One actual keydown through its unique echo and a corresponding model frame.
 * The browser timestamps both ends; Playwright RPC/polling time is excluded.
 */
async function measureKey(page: ShellDriver, character: string, needle: string): Promise<number> {
  await page.evaluate(
    ({ character: key, needle: expected }) => {
      const panel = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
        ),
      ].find((element) => element.contains(document.activeElement))
      const id = panel?.dataset.yaadeTerminalPtyId
      const tabId = panel?.dataset.yaadeTerminalTabId
      const terminal = window.yaade?.terminal
      if (!id || !tabId || !terminal) throw new Error("focused terminal unavailable")
      window.__terminalKeySample = new Promise((resolve, reject) => {
        let startedAt = 0
        let inputSentAt = 0
        let inputMatchesKey = false
        let workerPostedAt = 0
        let observedWorker: Worker | null = null
        const observeModel = () => {
          if (
            echoAt > 0 &&
            matchingFrame === 0 &&
            (window.__yaadeTest?.getTerminalText?.(tabId) ?? "").includes(expected)
          ) {
            matchingFrame =
              window.__yaadeTest?.getTerminalLifecycle?.(tabId)?.lastAppliedModelFrame ?? 0
          }
        }
        const onWorkerMessage = (event: MessageEvent<unknown>) => {
          const value = event.data
          if (
            typeof value === "object" &&
            value !== null &&
            "type" in value &&
            value.type === "packedUpdate"
          )
            observeModel()
        }
        const workerPost = Worker.prototype.postMessage
        Worker.prototype.postMessage = function (...args: unknown[]) {
          const command = args[0]
          if (
            startedAt > 0 &&
            workerPostedAt === 0 &&
            typeof command === "object" &&
            command !== null &&
            "type" in command &&
            command.type === "key"
          ) {
            workerPostedAt = performance.now()
            observedWorker = this
            // The pool's earlier message listener applies the retained model
            // first. Bind the first matching update, not a later flood frame
            // arbitrarily sampled by rAF polling.
            this.addEventListener("message", onWorkerMessage)
          }
          Reflect.apply(workerPost, this, args)
        }
        const write = terminal.write
        terminal.write = (terminalId, data) => {
          if (terminalId === id && startedAt > 0 && inputSentAt === 0) {
            inputSentAt = performance.now()
            inputMatchesKey = data === key
          }
          return write(terminalId, data)
        }
        let echoAt = 0
        let matchingFrame = 0
        let raf = 0
        const cleanup = () => {
          unsubscribe()
          terminal.write = write
          Worker.prototype.postMessage = workerPost
          observedWorker?.removeEventListener("message", onWorkerMessage)
          document.removeEventListener("keydown", onKeyDown, true)
          cancelAnimationFrame(raf)
          clearTimeout(timeout)
        }
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key === key && startedAt === 0) startedAt = performance.now()
        }
        document.addEventListener("keydown", onKeyDown, true)
        const unsubscribe = terminal.onData(id, (data) => {
          if (startedAt > 0 && echoAt === 0 && data.includes(key.charCodeAt(0)))
            echoAt = performance.now()
        })
        const timeout = window.setTimeout(() => {
          cleanup()
          reject(
            new Error(
              `key echo/model/presentation sample timed out: ${JSON.stringify({
                inputMatchesKey,
                workerPostedMs: workerPostedAt ? workerPostedAt - startedAt : null,
                inputSentMs: inputSentAt ? inputSentAt - startedAt : null,
                echoMs: echoAt ? echoAt - startedAt : null,
                matchingFrame,
                lifecycle: window.__yaadeTest?.getTerminalLifecycle?.(tabId),
              })}`,
            ),
          )
        }, 10_000)
        const poll = () => {
          const lifecycle = window.__yaadeTest?.getTerminalLifecycle?.(tabId)
          const sample = lifecycle?.lastPresentation
          if (!observedWorker) observeModel()
          if (
            sample &&
            matchingFrame > 0 &&
            sample.modelFrameId >= matchingFrame &&
            sample.modelAppliedAt >= echoAt
          ) {
            cleanup()
            resolve({
              workerPostedMs: workerPostedAt - startedAt,
              inputSentMs: inputSentAt - startedAt,
              echoMs: echoAt - startedAt,
              modelAppliedMs: sample.modelAppliedAt - startedAt,
              submittedMs: sample.submittedAt - startedAt,
              nextRafProxyMs: sample.nextPaintObservedAt - startedAt,
            })
            return
          }
          raf = requestAnimationFrame(poll)
        }
        raf = requestAnimationFrame(poll)
      })
    },
    { character, needle },
  )
  await page.keyboard.press(character)
  const sample = await page.evaluate(async () => {
    const result = await window.__terminalKeySample
    delete window.__terminalKeySample
    if (!result) throw new Error("missing key sample")
    return result
  })
  console.log(
    `[bench-key] ${JSON.stringify(sample)} (next-rAF is a presentation proxy, not physical display latency)`,
  )
  return sample.nextRafProxyMs
}

async function waitForRunningTerminal(page: ShellDriver): Promise<void> {
  const panel = page
    .locator('[data-yaade-terminal-panel][data-yaade-terminal-status="running"]')
    .filter({ visible: true })
    .first()
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel).toHaveAttribute("data-yaade-terminal-renderer", "ghostty")
  await expect(panel).toHaveAttribute("data-yaade-terminal-render-backend", "webgl2")
  await expect(panel).toHaveAttribute("data-yaade-terminal-runtime", "worker")
  const intervals = await page.evaluate(async () => {
    const values: number[] = []
    let previous = await new Promise<number>((resolve) => requestAnimationFrame(resolve))
    for (let i = 0; i < 30; i += 1) {
      const next = await new Promise<number>((resolve) => requestAnimationFrame(resolve))
      values.push(next - previous)
      previous = next
    }
    return values
  })
  const observedHz = 1000 / median(intervals)
  console.log(
    `[bench-display] observedRafHz=${observedHz.toFixed(1)}; browser clock, not a physical display measurement`,
  )
  validateRefreshProfile(refreshHz, observedHz, slos.profile.refreshToleranceFraction)
  console.log(`[bench-profile] nominalRefreshHz=${refreshHz}`)
}

async function terminalRenderInfo(page: ShellDriver): Promise<{
  provider: string
  backend: string
  runtime: string
  visiblePanes: number
}> {
  return page.evaluate(() => {
    const panels = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
      ),
    ]
    const visible = panels.filter((panel) => {
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

function logTerminalRenderInfo(
  name: string,
  info: Awaited<ReturnType<typeof terminalRenderInfo>>,
): void {
  console.log(
    `[bench] ${name} provider=${info.provider} backend=${info.backend} runtime=${info.runtime} visiblePanes=${info.visiblePanes}`,
  )
}

async function resetTerminalForStreamSample(page: ShellDriver, resetMarker: string): Promise<void> {
  await page.evaluate(async (currentMarker) => {
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
      `'${currentMarker.slice(0, splitAt)}'` + `'${currentMarker.slice(splitAt)}'`
    await terminal.write(ptyId, `printf '\\033c%s\\n' ${markerExpression}\n`)
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
        await resetTerminalForStreamSample(page, `YAADE-TERMINAL-RESET-${sample}`)
        const marker = `YAADE-TERMINAL-BENCH-${sample}`
        return page.evaluate(async (currentMarker) => {
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
            unsubscribe = terminal.onData(ptyId, (data) => {
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
            `'${currentMarker.slice(0, splitAt)}'` + `'${currentMarker.slice(splitAt)}'`
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
                panel.dataset.yaadeTerminalBenchTransportMs = String(transportArrivedAt - startedAt)
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
        return page.evaluate(async (currentMarker) => {
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
          const pythonCode = `import sys; [sys.stdout.write(("\\x1b[?25l" if i % 2 == 0 else "\\x1b[?25h") + f"\\rprogress {i}/2000   ") or (sys.stdout.flush() if i % 16 == 0 else None) for i in range(2000)]; sys.stdout.write("\\r\\n" + ${markerExpression} + "\\n"); sys.stdout.flush()`
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
      frame: window.__yaadeTest?.getTerminalLifecycle?.()?.lastNextPaintObservedFrame ?? 0,
    }))
    await page.evaluate(async (script) => {
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
        return text.includes(needle) && (lifecycle?.lastNextPaintObservedFrame ?? 0) > frame
      },
      { marker, frame: started.frame },
      { timeout: 30_000 },
    )
    const duration = await page.evaluate((start) => performance.now() - start, started.time)
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
 * Individual keydown → transport echo → model → submission → next-rAF proxy.
 * This does not measure physical display latency.
 */
test("bench terminal-key-next-raf-idle", async () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  const { app, page } = await launchYaade()
  try {
    await showTerminal(page)
    await waitForRunningTerminal(page)
    logBenchContext("terminal-key-next-raf-idle", await benchContext(page))

    await page.evaluate(
      async (command) => {
        const panel = document.querySelector<HTMLElement>(
          '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
        )
        const id = panel?.dataset.yaadeTerminalPtyId
        if (!id || !window.yaade?.terminal) throw new Error("running terminal unavailable")
        await window.yaade.terminal.write(id, command)
      },
      loadCommand(
        0,
        0,
        slos.workloads.find((entry) => entry.id === idleObjective.corpus)!.maximumDurationSeconds,
      ),
    )
    await page.waitForFunction(() =>
      (window.__yaadeTest?.getTerminalText?.() ?? "").trim().endsWith("UF"),
    )
    await focusTerminal(page)

    let idleRound = 0
    const result = await runBench({
      name: "terminal-key-next-raf-idle",
      warmup: idleObjective.warmup,
      rounds: idleObjective.iterations,
      measure: async () => {
        // Focus once: repeated clicks measure selection command contention.
        const character = String.fromCharCode(97 + (idleRound++ % 26))
        return measureKey(page, character, `UF${idleRound}:${character}`)
      },
    })
    logBenchResult(result)
    assertBudget(result, refreshHz)
  } finally {
    await app.close()
  }
})

// Unpaced overload is opt-in, with a recovery deadline instead of a typing SLO.
const overload = process.env.YAADE_BENCH_OVERLOAD === "1"
for (const paneCount of [1, 6]) {
  const workload = slos.workloads.find((entry) => entry.id === `ansi-paced-${paneCount}pane-v1`)!
  const floodName = overload
    ? `terminal-overload-${paneCount}pane`
    : `terminal-key-next-raf-loaded-${paneCount}pane`
  test(`bench ${floodName}`, async () => {
    test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

    const { app, page } = await launchYaade()
    try {
      await showTerminal(page)
      await waitForRunningTerminal(page)
      for (let count = 1; count < paneCount; count += 1) {
        const largest = await page.evaluate(() => {
          const panes = [...document.querySelectorAll<HTMLElement>("[data-yaade-panel-leaf]")]
          let index = 0
          let area = 0
          panes.forEach((pane, candidate) => {
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
        await expect(
          page.locator('[data-yaade-terminal-panel][data-yaade-terminal-status="running"]'),
        ).toHaveCount(count + 1)
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
      logBenchContext(floodName, await benchContext(page))

      const renderInfo = await terminalRenderInfo(page)
      logTerminalRenderInfo("terminal-under-flood", renderInfo)
      expect(renderInfo.provider).toBe("ghostty")
      expect(renderInfo.visiblePanes).toBe(paneCount)

      const flood = loadCommand(
        overload ? 0 : workload.bytesPerSecondPerPane,
        overload ? 65536 : workload.maxBurstBytes,
        overload ? slos.overload.burstSeconds : workload.maximumDurationSeconds,
      )
      await page.evaluate(async (flood) => {
        const terminal = window.yaade?.terminal
        if (!terminal) throw new Error("running terminal input unavailable")
        for (const pane of document.querySelectorAll<HTMLElement>(
          '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
        )) {
          const id = pane.dataset.yaadeTerminalPtyId
          if (!id) throw new Error("pane PTY unavailable")
          await terminal.write(id, flood)
        }
      }, flood)
      if (overload) {
        const recoveryDeadline =
          performance.now() + slos.overload.burstSeconds * 1000 + slos.overload.recoveryCeilingMs
        await page.waitForFunction(
          () =>
            [
              ...document.querySelectorAll<HTMLElement>(
                '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
              ),
            ].every((panel) =>
              (
                window.__yaadeTest?.getTerminalText?.(panel.dataset.yaadeTerminalTabId) ?? ""
              ).includes("LOAD-DONE"),
            ),
          undefined,
          { timeout: slos.overload.burstSeconds * 1000 + slos.overload.recoveryCeilingMs },
        )
        await focusTerminal(page)
        // A recovered model alone is insufficient: verify that input works again.
        await measureKey(page, "z", "z")
        expect(
          performance.now(),
          "input usability exceeded the recovery deadline",
        ).toBeLessThanOrEqual(recoveryDeadline)
        expect(
          await page
            .locator('[data-yaade-terminal-panel][data-yaade-terminal-status="running"]')
            .count(),
        ).toBe(paneCount)
        console.log(
          `[bench-overload] panes=${paneCount} burstSeconds=${slos.overload.burstSeconds} recoveryCeilingMs=${slos.overload.recoveryCeilingMs}; no typing percentile claim`,
        )
        return
      }
      await page.waitForFunction(() =>
        [
          ...document.querySelectorAll<HTMLElement>(
            '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
          ),
        ].every(
          (panel) =>
            (window.__yaadeTest?.getTerminalLifecycle?.(panel.dataset.yaadeTerminalTabId)
              ?.workerDiagnostics.bytesParsed ?? 0) >
            128 * 1024,
        ),
      )
      const floodStart = await page.evaluate(() => ({
        time: performance.now(),
        bytes: [...document.querySelectorAll<HTMLElement>("[data-yaade-terminal-panel]")].map(
          (panel) =>
            window.__yaadeTest?.getTerminalLifecycle?.(panel.dataset.yaadeTerminalTabId)
              ?.workerDiagnostics.bytesParsed ?? 0,
        ),
      }))
      await focusTerminal(page)
      const samples: number[] = []
      await page.waitForFunction(() =>
        (window.__yaadeTest?.getTerminalText?.() ?? "").includes("UF"),
      )
      for (let n = 0; n < loadObjective.warmup + loadObjective.iterations; n += 1) {
        const character = String.fromCharCode(97 + (n % 26))
        const sample = await measureKey(page, character, `UF${n + 1}:${character}`)
        if (n >= loadObjective.warmup) samples.push(sample)
      }
      const floodEnd = await page.evaluate(() => ({
        time: performance.now(),
        bytes: [...document.querySelectorAll<HTMLElement>("[data-yaade-terminal-panel]")].map(
          (panel) =>
            window.__yaadeTest?.getTerminalLifecycle?.(panel.dataset.yaadeTerminalTabId)
              ?.workerDiagnostics.bytesParsed ?? 0,
        ),
      }))
      expect(floodEnd.bytes).toHaveLength(paneCount)
      const parsedBytes = floodEnd.bytes.map((value, index) => value - floodStart.bytes[index]!)
      const durationMs = floodEnd.time - floodStart.time
      const expectedBytes = (workload.bytesPerSecondPerPane * durationMs) / 1000
      for (const bytes of parsedBytes) {
        expect(bytes, "paced producer stalled or parser fell behind").toBeGreaterThanOrEqual(
          expectedBytes * workload.minimumRateFraction - workload.maxBurstBytes * 2,
        )
        expect(bytes, "paced producer exceeded its workload envelope").toBeLessThanOrEqual(
          expectedBytes * 1.1 + workload.maxBurstBytes * 2,
        )
      }
      console.log(
        `[bench-load] corpus=${workload.id} panes=${paneCount} targetBytesPerSecondPerPane=${workload.bytesPerSecondPerPane} parsedBytes=${JSON.stringify(parsedBytes)} durationMs=${durationMs}`,
      )
      const result: BenchResult = {
        name: floodName,
        median: median(samples),
        p95: percentile(samples, 0.95),
        p99: percentile(samples, 0.99),
        samples,
      }
      logBenchResult(result)
      assertBudget(result, refreshHz)
    } finally {
      await app.close()
    }
  })
}
