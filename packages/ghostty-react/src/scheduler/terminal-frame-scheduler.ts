export const TERMINAL_SCHEDULER_BUDGETS = {
  interactiveBytes: 256,
  workerSliceBytes: 256 * 1024,
  livePendingBytes: 16 * 1024 * 1024,
  poolPendingBytes: 64 * 1024 * 1024,
  hiddenParseDelayMs: 100,
  synchronizedOutputTimeoutMs: 1_000,
  fairnessQuantumBytes: 256 * 1024,
  metricsCapacity: 512,
} as const;

export type TerminalPipelineStage =
  | "received"
  | "posted"
  | "parsed"
  | "model-applied"
  | "render-start"
  | "submitted"
  | "next-paint-observed";

export type TerminalPipelineToken = { readonly sequence: number };

export interface TerminalPresentationSample {
  readonly terminalId?: string;
  readonly surfaceInstanceId: number;
  readonly runtimeGeneration: number;
  readonly rendererGeneration: number;
  readonly modelFrameId: number;
  readonly geometryGeneration: number;
  readonly modelAppliedAt: number;
  readonly renderStartedAt: number;
  readonly submittedAt: number;
  readonly parsedBytesAtSubmission?: number;
  readonly nextPaintObservedAt: number;
}

type PipelineRecord = {
  sequence: number;
  bytes: number;
  endOffset: number;
  postedBytes: number;
  receivedAt: number;
  postedAt: number;
  parsedAt: number;
  modelAppliedAt: number;
  renderStartedAt: number;
  submittedAt: number;
  nextPaintObservedAt: number;
  surfaceInstanceId: number;
  runtimeGeneration: number;
  rendererGeneration: number;
  modelFrameId: number;
  geometryGeneration: number;
};

export type TerminalSchedulerCounters = {
  readonly receivedBytes: number;
  readonly postedBytes: number;
  readonly parsedBytes: number;
  readonly discardedBytes: number;
  /** Parsed bytes covered by an observed submission; not physical display bytes. */
  readonly presentedBytes: number;
  readonly pendingBytes: number;
  readonly maxPendingBytes: number;
};

export type TerminalSchedulerSnapshot = TerminalSchedulerCounters & {
  readonly retainedSamples: number;
  /** Sampled lower bound: evicted timing samples are not retained for this gauge. */
  readonly oldestPendingAgeMs: number;
  readonly receivedToParsedP50: number;
  readonly receivedToParsedP95: number;
  readonly receivedToParsedP99: number;
  readonly parsedToSubmittedP50: number;
  readonly parsedToSubmittedP95: number;
  readonly parsedToSubmittedP99: number;
  readonly receivedToPresentedP50: number;
  readonly receivedToPresentedP95: number;
  readonly receivedToPresentedP99: number;
  readonly frameDelayP50: number;
  readonly frameDelayP95: number;
  readonly frameDelayP99: number;
  readonly lastSubmittedModelFrame: number;
  readonly lastNextPaintObservedFrame: number;
};

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? 0;
}

/**
 * Payload-free, bounded accounting for the terminal transport and presentation
 * pipeline. Parse acknowledgement stays independent from presentation.
 */
export class TerminalFrameScheduler {
  private readonly records: PipelineRecord[] = [];
  // Tokens are owned by parser callbacks, not the timing ring. Evicting a
  // sample must never evict its outstanding accounting obligation.
  private tokens = new WeakMap<TerminalPipelineToken, PipelineRecord>();
  private sequence = 0;
  private receivedBytes = 0;
  private postedBytes = 0;
  private postedThrough = 0;
  private parsedBytes = 0;
  private discardedBytes = 0;
  private presentedBytes = 0;
  private submittedParsedBytes = 0;
  private lastPresentedParsedBytes = 0;
  private pendingBytes = 0;
  private maxPendingBytes = 0;
  private lastSubmittedModelFrame = 0;
  private lastNextPaintObservedFrame = 0;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly capacity = TERMINAL_SCHEDULER_BUDGETS.metricsCapacity,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 0)
      throw new Error("Terminal timing capacity must be a non-negative safe integer");
  }

  received(bytes: number): TerminalPipelineToken {
    const size = Math.max(0, Math.trunc(bytes));
    const record: PipelineRecord = {
      sequence: ++this.sequence,
      bytes: size,
      endOffset: this.receivedBytes + size,
      postedBytes: 0,
      receivedAt: this.now(),
      postedAt: -1,
      parsedAt: -1,
      modelAppliedAt: -1,
      renderStartedAt: -1,
      submittedAt: -1,
      nextPaintObservedAt: -1,
      surfaceInstanceId: 0,
      runtimeGeneration: 0,
      rendererGeneration: 0,
      modelFrameId: 0,
      geometryGeneration: 0,
    };
    this.records.push(record);
    this.receivedBytes += size;
    this.pendingBytes += size;
    this.maxPendingBytes = Math.max(this.maxPendingBytes, this.pendingBytes);
    this.trim();
    const token = { sequence: record.sequence };
    this.tokens.set(token, record);
    return token;
  }

  posted(bytes: number): void {
    const amount = Math.min(Math.max(0, Math.trunc(bytes)), this.receivedBytes - this.postedThrough);
    this.postedBytes += amount;
    this.postedThrough += amount;
    const timestamp = this.now();
    for (const record of this.records) {
      const posted = Math.max(0, Math.min(record.bytes, this.postedThrough - (record.endOffset - record.bytes)));
      if (posted <= record.postedBytes) continue;
      record.postedBytes = posted;
      if (record.postedAt < 0) record.postedAt = Math.max(record.receivedAt, timestamp);
    }
  }

  parsed(token: TerminalPipelineToken): void {
    const record = this.tokens.get(token);
    if (record === undefined) return;
    this.tokens.delete(token);
    record.parsedAt = Math.max(record.receivedAt, this.now());
    this.parsedBytes += record.bytes;
    this.pendingBytes = Math.max(0, this.pendingBytes - record.bytes);
  }

  submitted(): number {
    this.submittedParsedBytes = this.parsedBytes;
    return this.submittedParsedBytes;
  }

  presented(sample?: TerminalPresentationSample): void {
    const fallback = this.now();
    const observedAt = sample?.nextPaintObservedAt ?? fallback;
    for (const record of this.records) {
      if (record.parsedAt < 0 || record.nextPaintObservedAt >= 0) continue;
      if (sample !== undefined && record.parsedAt > sample.modelAppliedAt) continue;
      // A recovered/new runtime may not present records parsed by a stale
      // generation. They remain bounded diagnostics and are dropped on reset.
      if (
        sample !== undefined &&
        record.runtimeGeneration !== 0 &&
        record.runtimeGeneration !== sample.runtimeGeneration
      ) continue;
      record.surfaceInstanceId = sample?.surfaceInstanceId ?? record.surfaceInstanceId;
      record.runtimeGeneration = sample?.runtimeGeneration ?? record.runtimeGeneration;
      record.rendererGeneration = sample?.rendererGeneration ?? record.rendererGeneration;
      record.modelFrameId = sample?.modelFrameId ?? record.modelFrameId;
      record.geometryGeneration = sample?.geometryGeneration ?? record.geometryGeneration;
      record.modelAppliedAt = Math.max(record.parsedAt, sample?.modelAppliedAt ?? fallback);
      record.renderStartedAt = Math.max(record.modelAppliedAt, sample?.renderStartedAt ?? fallback);
      record.submittedAt = Math.max(record.renderStartedAt, sample?.submittedAt ?? fallback);
      record.nextPaintObservedAt = Math.max(record.submittedAt, observedAt);
    }
    // This is a cumulative parse-to-next-rAF proxy, not physical display
    // accounting. Timing-sample eviction cannot change the byte counter.
    const through = Math.max(this.lastPresentedParsedBytes,
      sample === undefined ? this.parsedBytes : sample.parsedBytesAtSubmission ?? this.submittedParsedBytes);
    this.presentedBytes += through - this.lastPresentedParsedBytes;
    this.lastPresentedParsedBytes = through;
    if (sample !== undefined) {
      this.lastSubmittedModelFrame = Math.max(this.lastSubmittedModelFrame, sample.modelFrameId);
      this.lastNextPaintObservedFrame = Math.max(
        this.lastNextPaintObservedFrame,
        sample.modelFrameId,
      );
    }
  }

  resetGeneration(): void {
    this.records.length = 0;
    this.tokens = new WeakMap();
    this.postedThrough = this.receivedBytes;
    this.submittedParsedBytes = this.parsedBytes;
    this.lastPresentedParsedBytes = this.parsedBytes;
    this.discardedBytes += this.pendingBytes;
    this.pendingBytes = 0;
  }

  /** Constant-time accounting; percentile sorting is never needed for an ACK. */
  counters(): TerminalSchedulerCounters {
    return {
      receivedBytes: this.receivedBytes,
      postedBytes: this.postedBytes,
      parsedBytes: this.parsedBytes,
      discardedBytes: this.discardedBytes,
      presentedBytes: this.presentedBytes,
      pendingBytes: this.pendingBytes,
      maxPendingBytes: this.maxPendingBytes,
    };
  }

  snapshot(): TerminalSchedulerSnapshot {
    const now = this.now();
    const parsed: number[] = [];
    const parsedToSubmitted: number[] = [];
    const presented: number[] = [];
    const frameDelay: number[] = [];
    let oldest: PipelineRecord | undefined;
    for (const record of this.records) {
      if (record.parsedAt >= 0) parsed.push(record.parsedAt - record.receivedAt);
      else if (oldest === undefined) oldest = record;
      if (record.submittedAt >= 0) parsedToSubmitted.push(record.submittedAt - record.parsedAt);
      if (record.nextPaintObservedAt >= 0) {
        presented.push(record.nextPaintObservedAt - record.receivedAt);
        frameDelay.push(record.nextPaintObservedAt - record.submittedAt);
      }
    }
    // Each population is sorted once, not copied/sorted again per quantile.
    for (const values of [parsed, parsedToSubmitted, presented, frameDelay]) {
      values.sort((left, right) => left - right);
    }
    return {
      ...this.counters(),
      retainedSamples: this.records.length,
      oldestPendingAgeMs: oldest ? Math.max(0, now - oldest.receivedAt) : 0,
      receivedToParsedP50: percentile(parsed, 0.5),
      receivedToParsedP95: percentile(parsed, 0.95),
      receivedToParsedP99: percentile(parsed, 0.99),
      parsedToSubmittedP50: percentile(parsedToSubmitted, 0.5),
      parsedToSubmittedP95: percentile(parsedToSubmitted, 0.95),
      parsedToSubmittedP99: percentile(parsedToSubmitted, 0.99),
      receivedToPresentedP50: percentile(presented, 0.5),
      receivedToPresentedP95: percentile(presented, 0.95),
      receivedToPresentedP99: percentile(presented, 0.99),
      frameDelayP50: percentile(frameDelay, 0.5),
      frameDelayP95: percentile(frameDelay, 0.95),
      frameDelayP99: percentile(frameDelay, 0.99),
      lastSubmittedModelFrame: this.lastSubmittedModelFrame,
      lastNextPaintObservedFrame: this.lastNextPaintObservedFrame,
    };
  }

  private trim(): void {
    while (this.records.length > this.capacity) {
      const index = this.records.findIndex(record => record.parsedAt >= 0);
      if (index < 0) this.records.shift();
      else this.records.splice(index, 1);
    }
  }
}
