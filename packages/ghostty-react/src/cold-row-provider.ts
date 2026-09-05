export type TerminalColdRow = {
  readonly rowId: string;
  readonly logicalRowId: string;
  readonly wrapOffset: number;
  readonly text: string;
  readonly sourceFirstOffset: number;
  readonly sourceLastOffset: number;
};

export type TerminalColdRowPage = {
  readonly terminalEpoch: string;
  readonly indexGeneration: string;
  readonly rows: readonly TerminalColdRow[];
  readonly previousCursor: string | null;
  readonly nextCursor: string | null;
  readonly totalRows: number;
  readonly retainedFirstRowId: string | null;
  readonly retainedLastRowId: string | null;
};

export type TerminalColdSearchHit = {
  readonly rowId: string;
  readonly logicalRowId: string;
  readonly startColumn: number;
  readonly endColumn: number;
};

export type TerminalColdSearchPage = {
  readonly terminalEpoch: string;
  readonly indexGeneration: string;
  readonly hits: readonly TerminalColdSearchHit[];
  readonly previousCursor: string | null;
  readonly nextCursor: string | null;
  readonly totalHits: number;
};

export type TerminalColdRowSource = {
  readonly readRows: (request: {
    readonly terminalEpoch: string;
    readonly indexGeneration: string | null;
    readonly cursor: string | null;
    readonly direction: "older" | "newer";
    readonly rowLimit: number;
    readonly byteLimit: number;
    readonly signal: AbortSignal;
  }) => Promise<TerminalColdRowPage>;
  readonly search: (request: {
    readonly terminalEpoch: string;
    readonly indexGeneration: string | null;
    readonly query: string;
    readonly caseSensitive: boolean;
    readonly cursor: string | null;
    readonly direction: "previous" | "next";
    readonly resultLimit: number;
    readonly signal: AbortSignal;
  }) => Promise<TerminalColdSearchPage>;
};

export type TerminalColdRowProviderOptions = {
  readonly terminalEpoch: string;
  readonly source: TerminalColdRowSource;
  readonly maximumPages?: number;
  readonly maximumBytes?: number;
};

type CachedPage = {
  readonly key: string;
  readonly page: TerminalColdRowPage;
  readonly bytes: number;
};

/**
 * Bounded, non-React owner for immutable archived rows. Epoch/generation
 * changes cancel stale work and clear every derived page before another result
 * can be exposed.
 */
export class TerminalColdRowProvider {
  private readonly source: TerminalColdRowSource;
  private readonly maximumPages: number;
  private readonly maximumBytes: number;
  private terminalEpoch: string;
  private indexGeneration: string | null = null;
  private readonly pages = new Map<string, CachedPage>();
  private cacheBytes = 0;
  private requestGeneration = 0;
  private readonly controllers = new Set<AbortController>();
  private readonly pendingPages = new Map<string, Promise<TerminalColdRowPage>>();
  private disposed = false;
  private searchKey = "";
  private searchGeneration = 0;
  private readonly searchControllers = new Set<AbortController>();
  private static readonly maximumRequests = 16;

  constructor(options: TerminalColdRowProviderOptions) {
    if (!options.terminalEpoch) throw new Error("terminal epoch is required");
    this.source = options.source;
    this.terminalEpoch = options.terminalEpoch;
    this.maximumPages = boundedInteger(options.maximumPages ?? 8, 1, 32, "maximum pages");
    this.maximumBytes = boundedInteger(
      options.maximumBytes ?? 2 * 1024 * 1024,
      64 * 1024,
      16 * 1024 * 1024,
      "maximum bytes",
    );
  }

  get diagnostics() {
    return {
      pages: this.pages.size,
      bytes: this.cacheBytes,
      maximumPages: this.maximumPages,
      maximumBytes: this.maximumBytes,
      requests: this.controllers.size,
      maximumRequests: TerminalColdRowProvider.maximumRequests,
    };
  }

  setEpoch(terminalEpoch: string): void {
    if (!terminalEpoch) throw new Error("terminal epoch is required");
    if (terminalEpoch === this.terminalEpoch) return;
    this.terminalEpoch = terminalEpoch;
    this.indexGeneration = null;
    this.invalidate();
  }

  async readRows(
    options: {
      readonly cursor?: string | null;
      readonly direction?: "older" | "newer";
      readonly rowLimit?: number;
      readonly byteLimit?: number;
    } = {},
  ): Promise<TerminalColdRowPage> {
    this.assertActive();
    const cursor = options.cursor ?? null;
    const direction = options.direction ?? "older";
    const rowLimit = boundedInteger(options.rowLimit ?? 256, 1, 512, "row limit");
    const byteLimit = boundedInteger(options.byteLimit ?? 256 * 1024, 1, 1024 * 1024, "byte limit");
    const key = this.rowPageKey(cursor, direction, rowLimit, byteLimit);
    const cached = this.pages.get(key);
    if (cached) {
      this.pages.delete(key);
      this.pages.set(key, cached);
      return cached.page;
    }
    const pending = this.pendingPages.get(key);
    if (pending) return pending;
    const generation = this.requestGeneration;
    const controller = this.beginRequest();
    const request = (async () => {
      try {
        const page = await this.source.readRows({
          terminalEpoch: this.terminalEpoch,
          indexGeneration: this.indexGeneration,
          cursor,
          direction,
          rowLimit,
          byteLimit,
          signal: controller.signal,
        });
        validateRows(page.rows, rowLimit, byteLimit);
        this.acceptVersion(page.terminalEpoch, page.indexGeneration, generation);
        // Budget retained JS strings too, including stable IDs and page metadata.
        const bytes = page.rows.reduce(
          (total, row) =>
            total + 2 * (row.text.length + row.rowId.length + row.logicalRowId.length) + 96,
          2 * JSON.stringify({ ...page, rows: [] }).length,
        );
        if (bytes <= this.maximumBytes) {
          this.remember({
            key: this.rowPageKey(cursor, direction, rowLimit, byteLimit),
            page,
            bytes,
          });
        }
        return page;
      } finally {
        this.controllers.delete(controller);
      }
    })();
    this.pendingPages.set(key, request);
    try {
      return await request;
    } finally {
      if (this.pendingPages.get(key) === request) this.pendingPages.delete(key);
    }
  }

  async search(options: {
    readonly query: string;
    readonly caseSensitive?: boolean;
    readonly cursor?: string | null;
    readonly direction?: "previous" | "next";
    readonly resultLimit?: number;
  }): Promise<TerminalColdSearchPage> {
    this.assertActive();
    if (options.query.length === 0 || new TextEncoder().encode(options.query).byteLength > 4096)
      throw new Error("search query must contain 1..=4096 bytes");
    const resultLimit = boundedInteger(options.resultLimit ?? 100, 1, 500, "result limit");
    const key = `${options.caseSensitive ?? false}\u0000${options.query}`;
    if (key !== this.searchKey) {
      this.searchKey = key;
      this.searchGeneration += 1;
      for (const controller of this.searchControllers) {
        controller.abort();
        this.controllers.delete(controller);
      }
      this.searchControllers.clear();
    }
    const searchGeneration = this.searchGeneration;
    const generation = this.requestGeneration;
    const controller = this.beginRequest();
    this.searchControllers.add(controller);
    try {
      const result = await this.source.search({
        terminalEpoch: this.terminalEpoch,
        indexGeneration: this.indexGeneration,
        query: options.query,
        caseSensitive: options.caseSensitive ?? false,
        cursor: options.cursor ?? null,
        direction: options.direction ?? "next",
        resultLimit,
        signal: controller.signal,
      });
      if (searchGeneration !== this.searchGeneration)
        throw new DOMException("stale terminal history search", "AbortError");
      if (result.hits.length > resultLimit)
        throw new Error("search result exceeds requested bound");
      for (const hit of result.hits)
        if (
          !Number.isSafeInteger(hit.startColumn) ||
          !Number.isSafeInteger(hit.endColumn) ||
          hit.startColumn < 0 ||
          hit.endColumn <= hit.startColumn
        )
          throw new Error("search result contains an invalid cell range");
      this.acceptVersion(result.terminalEpoch, result.indexGeneration, generation);
      return result;
    } finally {
      this.controllers.delete(controller);
      this.searchControllers.delete(controller);
    }
  }

  cancelPending(): void {
    this.invalidate(false);
  }
  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Terminal history provider is disposed");
  }

  private beginRequest(): AbortController {
    this.assertActive();
    if (this.controllers.size >= TerminalColdRowProvider.maximumRequests)
      throw new Error("Terminal history request queue is full");
    const controller = new AbortController();
    this.controllers.add(controller);
    return controller;
  }

  private rowPageKey(
    cursor: string | null,
    direction: "older" | "newer",
    rowLimit: number,
    byteLimit: number,
  ): string {
    return `${this.terminalEpoch}\u0000${this.indexGeneration ?? ""}\u0000${direction}\u0000${cursor ?? ""}\u0000${rowLimit}\u0000${byteLimit}`;
  }

  private acceptVersion(epoch: string, indexGeneration: string, requestGeneration: number): void {
    if (requestGeneration !== this.requestGeneration)
      throw new DOMException("stale terminal history request", "AbortError");
    if (epoch !== this.terminalEpoch) throw new Error("terminal history epoch changed");
    if (this.indexGeneration !== null && this.indexGeneration !== indexGeneration) {
      // A newer index replaces the whole read view. Fence concurrent responses
      // so an old page cannot later roll the provider back to its old index.
      this.invalidate();
    }
    this.indexGeneration = indexGeneration;
  }

  private remember(entry: CachedPage): void {
    this.cacheBytes -= this.pages.get(entry.key)?.bytes ?? 0;
    this.pages.set(entry.key, entry);
    this.cacheBytes += entry.bytes;
    while (this.pages.size > this.maximumPages || this.cacheBytes > this.maximumBytes) {
      const oldest = this.pages.entries().next();
      if (oldest.done) break;
      this.pages.delete(oldest.value[0]);
      this.cacheBytes -= oldest.value[1].bytes;
    }
  }

  private invalidate(clear = true): void {
    this.requestGeneration += 1;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.searchControllers.clear();
    this.pendingPages.clear();
    if (!clear) return;
    this.pages.clear();
    this.cacheBytes = 0;
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be ${minimum}..=${maximum}`);
  return value;
}

function validateRows(rows: readonly TerminalColdRow[], rowLimit: number, byteLimit: number): void {
  if (rows.length > rowLimit) throw new Error("row page exceeds requested bound");
  let bytes = 0;
  let previousOffset = 0;
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.rowId || ids.has(row.rowId)) throw new Error("row page has invalid stable IDs");
    ids.add(row.rowId);
    bytes += new TextEncoder().encode(row.text).byteLength;
    if (
      row.sourceFirstOffset < 1 ||
      row.sourceLastOffset < row.sourceFirstOffset ||
      row.sourceFirstOffset <= previousOffset
    )
      throw new Error("row page has invalid source fences");
    previousOffset = row.sourceLastOffset;
  }
  if (bytes > byteLimit) throw new Error("row page exceeds requested byte bound");
}
