export interface TerminalGeometrySample {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly pixelRatio: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
}

export interface TerminalGeometryCommit extends TerminalGeometrySample {
  readonly generation: number;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalGeometryClock {
  readonly requestFrame: (callback: () => void) => number;
  readonly cancelFrame: (handle: number) => void;
}

export interface TerminalGeometryCoordinatorOptions {
  readonly padding: number;
  readonly clock?: TerminalGeometryClock;
  readonly onCommit: (commit: TerminalGeometryCommit) => void;
}

const browserClock: TerminalGeometryClock = {
  requestFrame: callback => window.requestAnimationFrame(callback),
  cancelFrame: handle => window.cancelAnimationFrame(handle),
};

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function sameSample(left: TerminalGeometrySample, right: TerminalGeometrySample): boolean {
  return left.cssWidth === right.cssWidth &&
    left.cssHeight === right.cssHeight &&
    left.pixelRatio === right.pixelRatio &&
    left.cellWidth === right.cellWidth &&
    left.cellHeight === right.cellHeight;
}

/**
 * Owns the observed → local viewport generation seam. Observer and DPR bursts
 * collapse to the latest sample, with at most one commit per display frame.
 */
export class TerminalGeometryCoordinator {
  private readonly clock: TerminalGeometryClock;
  private pending: TerminalGeometrySample | null = null;
  private committed: TerminalGeometrySample | null = null;
  private frame = 0;
  private generation = 0;
  private disposed = false;

  constructor(private readonly options: TerminalGeometryCoordinatorOptions) {
    this.clock = options.clock ?? browserClock;
  }

  get currentGeneration(): number { return this.generation; }
  get hasPending(): boolean { return this.pending !== null; }

  observe(sample: TerminalGeometrySample): boolean {
    if (this.disposed || !this.valid(sample)) return false;
    if (this.pending !== null && sameSample(this.pending, sample)) return false;
    if (this.pending === null && this.committed !== null && sameSample(this.committed, sample)) {
      return false;
    }
    this.pending = sample;
    if (this.frame === 0) {
      this.frame = this.clock.requestFrame(() => {
        this.frame = 0;
        this.flush();
      });
    }
    return true;
  }

  /** Synchronous initial/manual fit; pending stale samples cannot commit later. */
  commitNow(sample: TerminalGeometrySample): boolean {
    if (this.disposed || !this.valid(sample)) return false;
    this.pending = sample;
    if (this.frame !== 0) {
      this.clock.cancelFrame(this.frame);
      this.frame = 0;
    }
    return this.flush();
  }

  flush(): boolean {
    const sample = this.pending;
    this.pending = null;
    if (this.disposed || sample === null) return false;
    if (this.committed !== null && sameSample(this.committed, sample)) return false;
    const width = Math.max(0, sample.cssWidth - this.options.padding * 2);
    const height = Math.max(0, sample.cssHeight - this.options.padding * 2);
    const commit: TerminalGeometryCommit = {
      ...sample,
      generation: ++this.generation,
      cols: Math.max(1, Math.floor(width / sample.cellWidth)),
      rows: Math.max(1, Math.floor(height / sample.cellHeight)),
    };
    this.committed = sample;
    this.options.onCommit(commit);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = null;
    if (this.frame !== 0) this.clock.cancelFrame(this.frame);
    this.frame = 0;
  }

  private valid(sample: TerminalGeometrySample): boolean {
    return finitePositive(sample.cssWidth) && finitePositive(sample.cssHeight) &&
      finitePositive(sample.pixelRatio) && finitePositive(sample.cellWidth) &&
      finitePositive(sample.cellHeight);
  }
}
