import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { Effect } from "effect"
import { invokeHostRpc } from "./effect-host-client.js"

test("generic host invokes preserve structured conflict codes", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "CONFLICT",
          message: "restore target already exists",
          details: {},
        },
      }),
      {
        status: 409,
        headers: { "content-type": "application/json" },
      },
    )
  try {
    const error = await Effect.runPromise(
      Effect.flip(invokeHostRpc("test-client", "mux:listSessions", [false])),
    )
    assert.equal(error.code, "CONFLICT")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("terminal RPC errors decode their typed details", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      code: "CONFLICT",
      message: "stale terminal",
      details: { muxTerminalId: "term-a", expectedRevision: 2, actualRevision: 3 },
    },
  }), { status: 409, headers: { "content-type": "application/json" } })
  try {
    const error = await Effect.runPromise(
      Effect.flip(invokeHostRpc("test-client", "mux:stopTerminal", ["term-a", 2])),
    )
    assert.equal(error._tag, "TerminalConflict")
    if (error._tag === "TerminalConflict") {
      assert.equal(error.muxTerminalId, "term-a")
      assert.equal(error.expectedRevision, 2)
      assert.equal(error.actualRevision, 3)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
