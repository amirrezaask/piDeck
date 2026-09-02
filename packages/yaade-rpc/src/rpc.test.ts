import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { Effect, Schema } from "effect"
import {
  HostRpcRequest,
  HostEvent,
  decodeHostRpcRequest,
  hostErrorWire,
  PathOutsideRootsError,
  unknownChannel,
} from "./index.js"

describe("yaade-rpc schemas", () => {
  it("round-trips host RPC request defaults", async () => {
    const decoded = await Effect.runPromise(decodeHostRpcRequest({ channel: "mux:listSessions", args: [false] }))
    assert.equal(decoded.channel, "mux:listSessions")
    assert.deepEqual(decoded.args, [false])
    assert.equal(decoded.clientId, "browser")
  })

  it("encodes host event", async () => {
    const encoded = await Effect.runPromise(
      Schema.encode(HostEvent)({
        protocolVersion: 1,
        sequence: 3,
        channel: "terminal:data",
        args: ["pty-1", "hi"],
      }),
    )
    assert.equal(encoded.sequence, 3)
    assert.equal(encoded.channel, "terminal:data")
  })

  it("hot-path skips schema for terminal:data", async () => {
    const { isHotPathHostEvent, tryDecodeRealtimeHostEvent, decodeRealtimeHostEvent } =
      await import("./host.js")
    const raw = {
      protocolVersion: 1,
      sequence: 1,
      channel: "terminal:data",
      args: ["id", "x", 1],
    }
    assert.equal(isHotPathHostEvent(raw), true)
    assert.equal(tryDecodeRealtimeHostEvent(raw)?.sequence, 1)
    const viaEffect = await Effect.runPromise(decodeRealtimeHostEvent(raw))
    assert.equal(viaEffect.channel, "terminal:data")
  })

  it("maps path errors to wire codes", () => {
    const wire = hostErrorWire(
      new PathOutsideRootsError({ message: "PATH_OUTSIDE_ALLOWED_ROOTS", path: "/tmp" }),
    )
    assert.equal(wire.code, "PATH_OUTSIDE_ALLOWED_ROOTS")
  })

  it("builds unknown channel error", () => {
    const err = unknownChannel("nope:x")
    assert.equal(err.code, "UNKNOWN_OPERATION")
    assert.match(err.message, /nope:x/)
  })

  it("rejects bad host request", async () => {
    await assert.rejects(() => Effect.runPromise(decodeHostRpcRequest({ args: [] })))
  })

  it("HostRpcRequest schema type is struct", () => {
    assert.ok(HostRpcRequest)
  })

})
