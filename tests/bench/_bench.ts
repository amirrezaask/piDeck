import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { cpus, platform, release, totalmem } from "node:os"
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect } from "@playwright/test"
import { Schema } from "effect"
import type { ShellDriver } from "../shell/driver.js"

export type BenchResult = {
  name: string
  median: number
  p95: number
  p99: number
  samples: number[]
}

export type BenchBudget = {
  medianMs: number
  p95Ms: number
  p99Ms: number
}

export type BenchContext = {
  readonly commit: string
  readonly ghosttyRevision: string
  readonly releaseArtifactSha256: string
  readonly browser: string
  readonly renderer: string
  readonly runtime: string
  readonly os: string
  readonly cpu: string
  readonly logicalCores: number
  readonly memoryBytes: number
  readonly dpr: number
  readonly grid: { readonly cols: number; readonly rows: number } | null
  readonly ci: boolean
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
  return sorted[idx]!
}

export function coefficientOfVariation(values: readonly number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  if (mean === 0) return 0
  const variance = values.reduce(
    (total, value) => total + (value - mean) ** 2,
    0,
  ) / values.length
  return Math.sqrt(variance) / mean
}

function releaseArtifactSha256(): string {
  const assets = resolve(process.cwd(), "apps/web/dist/assets")
  const names = readdirSync(assets)
    .filter(name => name.startsWith("terminal-worker-") || name.startsWith("ghostty-vt-"))
    .sort()
  const hash = createHash("sha256")
  for (const name of names) {
    hash.update(name)
    hash.update(readFileSync(resolve(assets, name)))
  }
  return hash.digest("hex")
}

export async function benchContext(page: ShellDriver): Promise<BenchContext> {
  const browser = await page.evaluate(() => navigator.userAgent)
  const terminal = await page.evaluate(() => {
    const lifecycle = window.__yaadeTest?.getTerminalLifecycle?.()
    return {
      renderer: lifecycle?.rendererBackend ?? "unknown",
      runtime: lifecycle?.runtimeKind ?? "unknown",
      dpr: window.devicePixelRatio,
      grid: window.__yaadeTest?.getTerminalDims?.() ?? null,
    }
  })
  let commit = "unknown"
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  } catch {
    // Source archives without .git remain benchmarkable through the artifact hash.
  }
  return {
    commit,
    ghosttyRevision: readFileSync(
      resolve(process.cwd(), "packages/ghostty-core/src/vendor/VERSION"),
      "utf8",
    ).trim(),
    releaseArtifactSha256: releaseArtifactSha256(),
    browser,
    renderer: terminal.renderer,
    runtime: terminal.runtime,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCores: cpus().length,
    memoryBytes: totalmem(),
    dpr: terminal.dpr,
    grid: terminal.grid,
    ci: process.env.CI === "true",
  }
}

export function logBenchContext(name: string, context: BenchContext): void {
  console.log(`[bench-context] ${name} ${JSON.stringify(context)}`)
}

export type RunBenchOptions = {
  name: string
  warmup?: number
  rounds?: number
  measure: () => Promise<number>
}

export async function runBench(opts: RunBenchOptions): Promise<BenchResult> {
  const warmup = opts.warmup ?? 2
  const rounds = opts.rounds ?? 5
  for (let i = 0; i < warmup; i++) await opts.measure()
  const samples: number[] = []
  for (let i = 0; i < rounds; i++) samples.push(await opts.measure())
  return {
    name: opts.name,
    median: median(samples),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    samples,
  }
}

const budgetsPath = resolve(process.cwd(), "tests/bench/budgets.json")
const budgets = Schema.decodeUnknownSync(Schema.Record({
  key: Schema.String,
  value: Schema.Struct({
    medianMs: Schema.Number,
    p95Ms: Schema.Number,
    p99Ms: Schema.Number,
  }),
}))(JSON.parse(readFileSync(budgetsPath, "utf8")))

export function assertBudget(result: BenchResult): void {
  const budget = budgets[result.name]
  if (budget == null) return
  expect(result.median, `${result.name} median ${result.median}ms > ${budget.medianMs}ms`).toBeLessThanOrEqual(budget.medianMs)
  expect(result.p95, `${result.name} p95 ${result.p95}ms > ${budget.p95Ms}ms`).toBeLessThanOrEqual(budget.p95Ms)
  expect(result.p99, `${result.name} p99 ${result.p99}ms > ${budget.p99Ms}ms`).toBeLessThanOrEqual(budget.p99Ms)
}

export function logBenchResult(result: BenchResult): void {
  console.log(
    `[bench] ${result.name} median=${result.median.toFixed(1)}ms ` +
      `p95=${result.p95.toFixed(1)}ms p99=${result.p99.toFixed(1)}ms ` +
      `cv=${coefficientOfVariation(result.samples).toFixed(3)} ` +
      `samples=${JSON.stringify(result.samples.map(sample => Number(sample.toFixed(1))))}`,
  )
}
