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
