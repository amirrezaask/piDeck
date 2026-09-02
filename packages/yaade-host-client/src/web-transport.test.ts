import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { Duration, Effect } from "effect"
import {
  acceptHostEvent,
  createClientId,
  hostRealtimeReconnectDelay,
  readHostAuthToken,
  consumeHostAuthTokenFromLocation,
  subscribeRealtimeWake,
  websocketUrl,
  normalizeHostBaseUrl,
} from "./web-transport.js"
import {
  decodeRealtimeHostEvent,
  isHotPathHostEvent,
  tryDecodeRealtimeHostEvent,
} from "@yaade/rpc"

test("websocket URL follows the page origin and carries replay sequence", () => {
  assert.equal(
    websocketUrl({ protocol: "http:", host: "example.test:4747" } as Location, 42),
    "ws://example.test:4747/terminal/ws?since=42",
  )
  assert.equal(
    websocketUrl({ protocol: "https:", host: "yaade.example" } as Location),
    "wss://yaade.example/terminal/ws?since=0",
  )
  assert.equal(
    websocketUrl(
      { protocol: "https:", host: "yaade.example" } as Location,
      9,
      "client id/with reserved chars",
    ),
    "wss://yaade.example/terminal/ws?since=9&clientId=client%20id%2Fwith%20reserved%20chars",
  )
  assert.equal(
    websocketUrl(
      { protocol: "https:", host: "yaade.example" } as Location,
      3,
      "c1",
      "secret token",
    ),
    "wss://yaade.example/terminal/ws?since=3&clientId=c1&token=secret%20token",
  )
})

test("normalizes configured server origins and rejects credentials", () => {
  assert.equal(normalizeHostBaseUrl("https://devbox.example.com/"), "https://devbox.example.com")
  assert.equal(normalizeHostBaseUrl("http://127.0.0.1:4747/path"), "http://127.0.0.1:4747")
  assert.throws(() => normalizeHostBaseUrl("ftp://devbox.example.com"), /http or https/)
  assert.throws(() => normalizeHostBaseUrl("https://user:pass@devbox.example.com"), /credentials/)
})

test("websocket URL can target a configured remote server", () => {
  assert.equal(
    websocketUrl(
      { protocol: "http:", host: "client.example" } as Location,
      0,
      "client",
      "token",
      "https://server.example:8443",
    ),
    "wss://server.example:8443/terminal/ws?since=0&clientId=client&token=token",
  )
  assert.equal(
    websocketUrl(
      { protocol: "https:", host: "client.example" } as Location,
      0,
      "client",
      "token",
      "https://server.example:8443",
      2,
    ),
    "wss://server.example:8443/terminal/ws?since=0&clientId=client&protocol=2",
  )
})

test("readHostAuthToken prefers the query token and remembers it", () => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
  }
  assert.equal(readHostAuthToken("?token=abc", storage), "abc")
  assert.equal(store.get("yaade-host-token"), "abc")
  assert.equal(readHostAuthToken("", storage), "abc")
})

test("consumeHostAuthTokenFromLocation strips the query token from history", () => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
  }
  let url = "/?s=ses-1&token=secret"
  consumeHostAuthTokenFromLocation(
    { search: "?s=ses-1&token=secret", pathname: "/", hash: "" },
    {
      replaceState: (_state, _title, next) => {
        url = String(next)
      },
    },
    storage,
  )
  assert.equal(store.get("yaade-host-token"), "secret")
  assert.equal(url, "/?s=ses-1")
})

test("client ids work when randomUUID is unavailable outside secure contexts", () => {
  const id = createClientId({} as Crypto)
  assert.match(id, /^client-[a-z0-9]+-[a-z0-9]+$/)
})

test("protocol gate rejects duplicates and incompatible messages", () => {
  assert.equal(
    acceptHostEvent(4, { protocolVersion: 1, sequence: 5, channel: "x", args: [] }),
    true,
  )
  assert.equal(
    acceptHostEvent(5, { protocolVersion: 1, sequence: 5, channel: "x", args: [] }),
    false,
  )
  assert.equal(
    acceptHostEvent(0, {
      protocolVersion: 2,
      sequence: 1,
      channel: "x",
      args: [],
    } as unknown as Parameters<typeof acceptHostEvent>[1]),
    false,
  )
})

test("reconnect delay doubles then caps at 10s", () => {
  assert.equal(Duration.toMillis(hostRealtimeReconnectDelay(0)), 250)
  assert.equal(Duration.toMillis(hostRealtimeReconnectDelay(1)), 500)
  assert.equal(Duration.toMillis(hostRealtimeReconnectDelay(2)), 1000)
  assert.equal(Duration.toMillis(hostRealtimeReconnectDelay(5)), 8000)
  assert.equal(Duration.toMillis(hostRealtimeReconnectDelay(6)), 10_000)
  assert.equal(Duration.toMillis(hostRealtimeReconnectDelay(20)), 10_000)
})

test("foreground lifecycle wakes reconnect without replacing an open socket on blur", () => {
  class WakeDocument extends EventTarget {
    visibilityState: DocumentVisibilityState = "visible"
  }
  const doc = new WakeDocument()
  const target = new EventTarget()
  const wakes: boolean[] = []
  const dispose = subscribeRealtimeWake(replace => wakes.push(replace), doc, target)

  target.dispatchEvent(new Event("focus"))
  target.dispatchEvent(new Event("blur"))
  target.dispatchEvent(new Event("focus"))
  doc.visibilityState = "hidden"
  doc.dispatchEvent(new Event("visibilitychange"))
  doc.visibilityState = "visible"
  doc.dispatchEvent(new Event("visibilitychange"))
  target.dispatchEvent(new Event("online"))

  assert.deepEqual(wakes, [false, true, true])
  dispose()
  target.dispatchEvent(new Event("focus"))
  assert.deepEqual(wakes, [false, true, true])
})

test("hot path accepts terminal frames structurally", () => {
  const data = {
    protocolVersion: 1,
    sequence: 9,
    channel: "terminal:data",
    args: ["pty-1", "hello", 3],
  }
  const exit = {
    protocolVersion: 1,
    sequence: 10,
    channel: "terminal:exit",
    args: ["pty-1", 0],
  }
  assert.equal(isHotPathHostEvent(data), true)
  assert.equal(isHotPathHostEvent(exit), true)
  assert.equal(
    isHotPathHostEvent({
      protocolVersion: 1,
      sequence: 1,
      channel: "mux:event",
      args: [],
    }),
    false,
  )
  assert.equal(tryDecodeRealtimeHostEvent(data)?.channel, "terminal:data")
  assert.equal(tryDecodeRealtimeHostEvent({ nope: true }), undefined)
})

test("cold path still Schema-decodes low-rate events", async () => {
  const decoded = await Effect.runPromise(
    decodeRealtimeHostEvent({
      protocolVersion: 1,
      sequence: 2,
      channel: "connection:status",
      args: ["main"],
    }),
  )
  assert.equal(decoded.channel, "connection:status")
  assert.deepEqual(decoded.args, ["main"])
})
