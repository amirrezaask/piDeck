import { describe, expect, test } from "vitest";
import {
  TerminalColdRowProvider,
  type TerminalColdRowPage,
  type TerminalColdRowSource,
} from "./cold-row-provider.js";

function page(cursor: string | null, generation = "g1"): TerminalColdRowPage {
  const index = Number(cursor ?? 0);
  return {
    terminalEpoch: "epoch-1",
    indexGeneration: generation,
    rows: [
      {
        rowId: `row-${index}`,
        logicalRowId: `line-${index}`,
        wrapOffset: 0,
        text: `line ${index}`,
        sourceFirstOffset: index + 1,
        sourceLastOffset: index + 1,
      },
    ],
    previousCursor: index > 0 ? String(index - 1) : null,
    nextCursor: String(index + 1),
    totalRows: 1_000_000,
    retainedFirstRowId: "row-0",
    retainedLastRowId: "row-999999",
  };
}

function source(): TerminalColdRowSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async readRows(request) {
      calls.push(`rows:${request.cursor ?? "bottom"}`);
      return page(request.cursor);
    },
    async search(request) {
      calls.push(`search:${request.query}`);
      return {
        terminalEpoch: "epoch-1",
        indexGeneration: "g1",
        hits: [{ rowId: "row-9", logicalRowId: "line-9", startColumn: 1, endColumn: 4 }],
        previousCursor: null,
        nextCursor: null,
        totalHits: 1,
      };
    },
  };
}

describe("TerminalColdRowProvider", () => {
  test("a new search query cancels stale search without discarding row pages", async () => {
    const base = source();
    let release: (() => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    const data: TerminalColdRowSource = {
      ...base,
      search: async (request) => {
        if (request.query === "old") {
          oldSignal = request.signal;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return base.search(request);
      },
    };
    const provider = new TerminalColdRowProvider({ terminalEpoch: "epoch-1", source: data });
    await provider.readRows();
    const old = provider.search({ query: "old" });
    await provider.search({ query: "new" });
    expect(oldSignal?.aborted).toBe(true);
    release?.();
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    expect(provider.diagnostics.pages).toBe(1);
    expect(provider.diagnostics.requests).toBe(0);
  });

  test("coalesces concurrent prefetches without double-counting retained bytes", async () => {
    const data = source();
    const provider = new TerminalColdRowProvider({ terminalEpoch: "epoch-1", source: data });
    const [first, second] = await Promise.all([provider.readRows(), provider.readRows()]);
    expect(first).toBe(second);
    expect(data.calls).toEqual(["rows:bottom"]);
    const bytes = provider.diagnostics.bytes;
    await provider.readRows();
    expect(provider.diagnostics.bytes).toBe(bytes);
    expect(provider.diagnostics.requests).toBe(0);
  });

  test("index changes fence late responses from the replaced read view", async () => {
    const pending = new Map<string, (value: TerminalColdRowPage) => void>();
    const data: TerminalColdRowSource = {
      ...source(),
      readRows: (request) => new Promise((resolve) => pending.set(request.cursor ?? "0", resolve)),
    };
    const provider = new TerminalColdRowProvider({ terminalEpoch: "epoch-1", source: data });
    const initial = provider.readRows();
    pending.get("0")!(page("0", "g1"));
    await initial;
    const old = provider.readRows({ cursor: "1" });
    const replacement = provider.readRows({ cursor: "2" });
    pending.get("2")!(page("2", "g2"));
    await replacement;
    pending.get("1")!(page("1", "g1"));
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    expect(provider.diagnostics.pages).toBe(1);
  });

  test("bounds pending reads and refuses requests after disposal", async () => {
    const data: TerminalColdRowSource = {
      ...source(),
      readRows: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        }),
    };
    const provider = new TerminalColdRowProvider({ terminalEpoch: "epoch-1", source: data });
    const pending = Array.from({ length: provider.diagnostics.maximumRequests }, (_, index) =>
      provider.readRows({ cursor: String(index) }),
    );
    const settled = Promise.allSettled(pending);
    await expect(provider.readRows({ cursor: "overflow" })).rejects.toThrow(/queue is full/);
    provider.dispose();
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    expect(provider.diagnostics.requests).toBe(0);
    await expect(provider.readRows()).rejects.toThrow(/disposed/);
    await expect(provider.search({ query: "needle" })).rejects.toThrow(/disposed/);
  });

  test("keeps a bounded least-recently-used page window", async () => {
    const data = source();
    const provider = new TerminalColdRowProvider({
      terminalEpoch: "epoch-1",
      source: data,
      maximumPages: 2,
      maximumBytes: 64 * 1024,
    });
    await provider.readRows({ cursor: "0" });
    await provider.readRows({ cursor: "0" });
    expect(data.calls.filter((call) => call === "rows:0")).toHaveLength(1);
    await provider.readRows({ cursor: "1" });
    await provider.readRows({ cursor: "2" });
    expect(provider.diagnostics.pages).toBe(2);
    expect(provider.diagnostics.bytes).toBeLessThanOrEqual(provider.diagnostics.maximumBytes);
  });

  test("rejects stale work after an epoch change", async () => {
    let release: ((value: TerminalColdRowPage) => void) | undefined;
    const data: TerminalColdRowSource = {
      readRows: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      search: async () => ({
        terminalEpoch: "epoch-1",
        indexGeneration: "g1",
        hits: [],
        previousCursor: null,
        nextCursor: null,
        totalHits: 0,
      }),
    };
    const provider = new TerminalColdRowProvider({ terminalEpoch: "epoch-1", source: data });
    const pending = provider.readRows();
    provider.setEpoch("epoch-2");
    release?.(page(null));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("bounds search and preserves exact returned cell ranges", async () => {
    const provider = new TerminalColdRowProvider({ terminalEpoch: "epoch-1", source: source() });
    await expect(provider.search({ query: "" })).rejects.toThrow(/1..=4096/);
    const result = await provider.search({ query: "old marker" });
    expect(result.hits[0]).toEqual({
      rowId: "row-9",
      logicalRowId: "line-9",
      startColumn: 1,
      endColumn: 4,
    });
  });
});
