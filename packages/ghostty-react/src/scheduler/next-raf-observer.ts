/** Bounded submission fences. New submissions cannot cancel an older fence. */
export class NextRafObserver<T extends object> {
  private frame: number | null = null;
  private latest: T | null = null;
  private generation = 0;

  constructor(
    private readonly observed: (sample: T, timestamp: number) => void,
    private readonly request: (callback: FrameRequestCallback) => number = (callback) =>
      requestAnimationFrame(callback),
    private readonly cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
  ) {}

  submit(sample: T): void {
    if (this.frame !== null) {
      // Retain the first fence and only the newest later submission.
      this.latest = sample;
      return;
    }
    const generation = this.generation;
    this.frame = this.request((timestamp) => {
      if (generation !== this.generation) return;
      this.frame = null;
      const latest = this.latest;
      this.latest = null;
      this.observed(sample, timestamp);
      if (generation === this.generation && latest !== null && this.frame === null)
        this.submit(latest);
    });
  }

  reset(): void {
    this.generation += 1;
    if (this.frame !== null) this.cancel(this.frame);
    this.frame = null;
    this.latest = null;
  }
}
