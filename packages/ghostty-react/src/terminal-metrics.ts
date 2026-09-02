export const TERMINAL_METRICS_VERSION = 1 as const

export const TERMINAL_METRIC_STAGES = [
  "host-frame-received",
  "scheduler-posted",
  "worker-command-received",
  "parsed",
  "render-build",
  "transferred",
  "model-applied",
  "scene-submitted",
  "presented",
  "slot-reclaimed",
] as const

export type TerminalMetricStage = typeof TERMINAL_METRIC_STAGES[number]
export type TerminalMetricSample = {
  readonly id: number
  readonly stage: TerminalMetricStage
  readonly durationMs: number
}
export type TerminalMetricsSnapshot = {
  readonly version: typeof TERMINAL_METRICS_VERSION
  readonly counters: Readonly<Record<TerminalMetricStage, number>>
  readonly sampleCount: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
}

const MAX_SAMPLES = 256

/** Payload-free bounded stage metrics. IDs correlate ownership; terminal bytes never enter it. */
export class TerminalStageMetrics {
  private readonly counts: Record<TerminalMetricStage, number> = {
    "host-frame-received": 0,
    "scheduler-posted": 0,
    "worker-command-received": 0,
    parsed: 0,
    "render-build": 0,
    transferred: 0,
    "model-applied": 0,
    "scene-submitted": 0,
    presented: 0,
    "slot-reclaimed": 0,
  }
  private readonly starts = new Map<number, { stage: TerminalMetricStage; at: number }>()
  private readonly samples: number[] = []

  mark(stage: TerminalMetricStage): void { this.counts[stage] += 1 }

  start(id: number, stage: TerminalMetricStage, at = performance.now()): void {
    if (!Number.isSafeInteger(id) || id < 0) return
    if (this.starts.size >= MAX_SAMPLES) this.starts.delete(this.starts.keys().next().value ?? id)
    this.starts.set(id, { stage, at })
  }

  finish(id: number, at = performance.now()): void {
    const started = this.starts.get(id)
    if (!started) return
    this.starts.delete(id)
    this.mark(started.stage)
    this.samples.push(Math.max(0, at - started.at))
    if (this.samples.length > MAX_SAMPLES) this.samples.shift()
  }

  snapshot(): TerminalMetricsSnapshot {
    const sorted = [...this.samples].sort((left, right) => left - right)
    const percentile = (value: number): number => {
      if (sorted.length === 0) return 0
      return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0
    }
    return {
      version: TERMINAL_METRICS_VERSION,
      counters: { ...this.counts },
      sampleCount: sorted.length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
    }
  }
}
