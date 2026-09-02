import { expect, test } from "@playwright/test"
import {
  TERMINAL_METRIC_STAGES,
  TerminalStageMetrics,
} from "../../packages/ghostty-react/src/terminal-metrics.js"
import { WebGlGlyphBatch, WebGlRectBatch } from "../../packages/ghostty-react/src/renderers/webgl2/batches.js"
import {
  WebGlRetainedScene,
  type RetainedRowBatches,
} from "../../packages/ghostty-react/src/renderers/webgl2/retained-scene.js"
import { FairWorkerScheduler } from "../../packages/ghostty-react/src/worker/fair-scheduler.js"
import { benchContext, logBenchContext } from "./_bench.js"
import { validateTerminalCorpora } from "./terminal-corpora.js"
import {
  focusTerminal,
  hasPtySpawn,
  launchYaade,
  showTerminal,
} from "../web/e2e/_launch.js"

const ptyAvailable = hasPtySpawn()

test("bench corpus manifest and metric schema are exact and payload-free", () => {
  const manifest = validateTerminalCorpora()
  expect(manifest.map(corpus => corpus.id)).toEqual([
    "ascii-log-512k-v1",
    "unicode-wide-512k-v1",
    "ansi-control-512k-v1",
    "synchronized-tui-256k-v1",
    "replay-16m-v1",
    "contention-background-1m-v1",
  ])
  expect(manifest.find(corpus => corpus.id === "replay-16m-v1")?.size).toBe(16 * 1024 * 1024)

  const metrics = new TerminalStageMetrics()
  for (const [id, stage] of TERMINAL_METRIC_STAGES.entries()) metrics.start(id, stage, id)
  for (const id of TERMINAL_METRIC_STAGES.keys()) metrics.finish(id, id + 1)
  const snapshot = metrics.snapshot()
  expect(snapshot.version).toBe(1)
  expect(Object.keys(snapshot.counters)).toEqual(TERMINAL_METRIC_STAGES)
  expect(JSON.stringify(snapshot)).not.toContain("payload")
  console.log(`[bench-corpora] ${JSON.stringify(manifest)}`)
  console.log(`[bench-metrics] ${JSON.stringify(snapshot)}`)
})

test("bench six-terminal idle high water reclaims capacity without oscillation", () => {
  const smallRow = (seed: number): RetainedRowBatches => {
    const backgrounds = new WebGlRectBatch(131_072)
    if (!backgrounds.push(seed, 0, 1, 1, 1, 1, 1)) {
      throw new Error("small benchmark row exceeded its bound")
    }
    return {
      backgrounds,
      decorations: new WebGlRectBatch(1),
      glyphs: new WebGlGlyphBatch(1),
    }
  }
  const scenes = Array.from({ length: 6 }, (_, index) => {
    const scene = new WebGlRetainedScene()
    scene.replaceAll([smallRow(index)])
    return scene
  })
  const flood = new WebGlRectBatch(131_072)
  for (let index = 0; index < 65_536; index += 1) {
    if (!flood.push(index, 0, 1, 1, 1, 1, 1)) {
      throw new Error("high-water benchmark row exceeded its bound")
    }
  }
  scenes[5]?.replaceAll([{
    backgrounds: flood,
    decorations: new WebGlRectBatch(1),
    glyphs: new WebGlGlyphBatch(1),
  }])
  scenes[5]?.replaceAll([smallRow(99)])
  const before = scenes.reduce((total, scene) => total + scene.allocatedBytes, 0)
  const expected = Array.from(scenes[5]?.backgroundData ?? [])
  const reclaimed = scenes.reduce((total, scene) => total + scene.trimCapacity(), 0)
  const after = scenes.reduce((total, scene) => total + scene.allocatedBytes, 0)
  const afterTrim = Array.from(scenes[5]?.backgroundData ?? [])
  const repeatedReclaim = scenes.reduce((total, scene) => total + scene.trimCapacity(), 0)
  scenes[5]?.updateRows([{ row: 0, batches: smallRow(100) }])

  expect(reclaimed).toBeGreaterThanOrEqual(1024 * 1024)
  expect(after).toBeLessThan(before)
  expect(afterTrim).toEqual(expected)
  expect(repeatedReclaim).toBe(0)
  expect(expected).toHaveLength(8)
  expect(scenes[5]?.backgroundData[0]).toBe(100)
  console.log(`[bench-idle-capacity] ${JSON.stringify({
    terminals: scenes.length,
    allocatedBefore: before,
    allocatedAfter: after,
    reclaimed,
    repeatedReclaim,
    resumedUsedBytes: scenes[5]?.usedBytes ?? 0,
  })}`)
})

test("bench production worker reaches parsed, transferred, and presented fences", async () => {
  test.skip(!ptyAvailable, "PTYs are unavailable on this machine")
  const { app, page } = await launchYaade()
  try {
    await showTerminal(page)
    await focusTerminal(page)
    logBenchContext("terminal-subsystem-fences", await benchContext(page))
    const before = await page.evaluate(() => window.__yaadeTest?.getTerminalLifecycle?.() ?? null)
    expect(before?.runtimeKind).toBe("worker")
    const marker = "YAADE_SUBSYSTEM_PRESENTED"
    const startedAt = await page.evaluate(() => performance.now())
    await page.evaluate(async currentMarker => {
      const panel = document.querySelector<HTMLElement>(
        '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
      )
      const ptyId = panel?.dataset.yaadeTerminalPtyId
      if (!ptyId || !window.yaade?.terminal) throw new Error("running terminal unavailable")
      const split = Math.floor(currentMarker.length / 2)
      await window.yaade.terminal.write(
        ptyId,
        `printf '%s%s\\n' '${currentMarker.slice(0, split)}' '${currentMarker.slice(split)}'\n`,
      )
    }, marker)
    await page.waitForFunction(
      ({ needle, frame }) => {
        const text = window.__yaadeTest?.getTerminalText?.() ?? ""
        const lifecycle = window.__yaadeTest?.getTerminalLifecycle?.()
        return text.includes(needle) &&
          (lifecycle?.lastNextPaintObservedFrame ?? 0) > frame
      },
      { needle: marker, frame: before?.lastNextPaintObservedFrame ?? 0 },
      { timeout: 15_000 },
    )
    const result = await page.evaluate(started => ({
      durationMs: performance.now() - started,
      lifecycle: window.__yaadeTest?.getTerminalLifecycle?.() ?? null,
      finalStateMatches: (window.__yaadeTest?.getTerminalText?.() ?? "")
        .includes("YAADE_SUBSYSTEM_PRESENTED"),
    }), startedAt)
    const diagnostics = result.lifecycle?.workerDiagnostics
    expect(result.finalStateMatches).toBe(true)
    expect(diagnostics?.writes).toBeGreaterThan(before?.workerDiagnostics.writes ?? 0)
    expect(diagnostics?.bytesParsed).toBeGreaterThan(before?.workerDiagnostics.bytesParsed ?? 0)
    expect(diagnostics?.renderBuilds).toBeGreaterThan(before?.workerDiagnostics.renderBuilds ?? 0)
    expect(diagnostics?.transfers).toBeGreaterThan(before?.workerDiagnostics.transfers ?? 0)
    expect(diagnostics?.slotsInFlight).toBeLessThanOrEqual(3)
    console.log(`[bench-subsystem] ${JSON.stringify({
      durationMs: result.durationMs,
      parsedBytes: (diagnostics?.bytesParsed ?? 0) - (before?.workerDiagnostics.bytesParsed ?? 0),
      renderBuilds: (diagnostics?.renderBuilds ?? 0) - (before?.workerDiagnostics.renderBuilds ?? 0),
      transfers: (diagnostics?.transfers ?? 0) - (before?.workerDiagnostics.transfers ?? 0),
      finalStateMatches: result.finalStateMatches,
    })}`)
  } finally {
    await app.close()
  }
})

test("bench contention gate justifies focused scheduling and bounds hidden service", async () => {
  const dispatched: string[] = []
  const scheduler = new FairWorkerScheduler<string>((_terminalId, value) => {
    dispatched.push(value)
  })
  const backgroundCount = 5
  for (let index = 0; index < backgroundCount; index += 1) {
    scheduler.enqueue(
      `hidden-${index}`,
      `hidden-${index}`,
      1024 * 1024,
      { visible: false, focused: false },
      1,
    )
  }
  scheduler.enqueue(
    "focused",
    "focused-key",
    1,
    { visible: true, focused: true },
    1,
  )
  for (let turn = 0; turn < 40 && dispatched.length < backgroundCount + 1; turn += 1) {
    await new Promise<void>(resolve => queueMicrotask(resolve))
  }

  const focusedServiceTurn = dispatched.indexOf("focused-key")
  const fifoFocusedServiceTurn = backgroundCount
  const hiddenMaximumServiceTurn = Math.max(
    ...dispatched.map((value, index) => value.startsWith("hidden-") ? index : -1),
  )
  expect(fifoFocusedServiceTurn).toBeGreaterThan(1)
  expect(focusedServiceTurn).toBeGreaterThanOrEqual(0)
  expect(focusedServiceTurn).toBeLessThanOrEqual(1)
  expect(hiddenMaximumServiceTurn).toBeLessThanOrEqual(backgroundCount)
  expect(dispatched).toHaveLength(backgroundCount + 1)
  console.log(`[bench-contention] ${JSON.stringify({
    targetFocusedServiceTurn: 1,
    fifoFocusedServiceTurn,
    scheduledFocusedServiceTurn: focusedServiceTurn,
    hiddenMaximumServiceTurn,
    decision: "scheduler-justified",
  })}`)
})
