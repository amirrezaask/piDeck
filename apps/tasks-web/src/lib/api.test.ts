import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient, ApiClientLive } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("ApiClient", () => {
  it("decodes task collections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    const tasks = await Effect.runPromise(
      Effect.flatMap(ApiClient, (api) => api.tasks.list({})).pipe(Effect.provide(ApiClientLive)),
    );
    expect(tasks).toEqual([]);
  });

  it("returns typed API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "TASK_NOT_FOUND", message: "Task was not found", details: null },
            }),
            { status: 404 },
          ),
      ),
    );
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(ApiClient, (api) => api.tasks.get("missing")).pipe(
        Effect.provide(ApiClientLive),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});
