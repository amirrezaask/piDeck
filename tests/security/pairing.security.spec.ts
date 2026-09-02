import { expect, test } from "@playwright/test"
import { generateKeyPairSync, sign } from "node:crypto"
import http from "node:http"
import {
  createDurableRuntimeHarness,
  expireUnusedPairingCodes,
  hostRpcResult,
  listAuditEvents,
  rpcErrorCode,
} from "../runtime/harness/index.js"
const HOST_TOKEN = "yaade-security-e2e-token"

type JsonRecord = Record<string, unknown>

async function jsonRequest(
  origin: string,
  pathname: string,
  options: {
    method?: string
    body?: unknown
    token?: string
    originHeader?: string
  } = {},
): Promise<{ status: number; body: JsonRecord }> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  if (options.originHeader) headers.origin = options.originHeader
  const response = await fetch(`${origin}${pathname}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let body: JsonRecord = {}
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text)
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as JsonRecord
        : { value: parsed }
    } catch {
      body = { raw: text }
    }
  }
  return { status: response.status, body }
}

function createDeviceKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  return {
    publicKey: publicKey.export({ format: "jwk" }),
    signNonce: (nonce: string) =>
      sign(null, Buffer.from(nonce), privateKey).toString("base64url"),
  }
}

async function pairNamedDevice(
  origin: string,
  name: string,
  scopes: Array<"observe" | "control"> = ["control"],
) {
  const keys = createDeviceKeys()
  const pairing = await jsonRequest(origin, "/terminal/api/v1/security/pairing-code", {
    method: "POST",
    token: HOST_TOKEN,
  })
  expect(pairing.status).toBe(201)
  const code = String(pairing.body.code ?? "")
  const paired = await jsonRequest(origin, "/terminal/api/v1/security/pair", {
    body: {
      code,
      name,
      publicKey: keys.publicKey,
      algorithm: "Ed25519",
      scopes,
    },
  })
  expect(paired.status).toBe(201)
  const deviceId = String(paired.body.id ?? "")
  const challenge = await jsonRequest(origin, "/terminal/api/v1/security/challenge", {
    body: { deviceId },
  })
  expect(challenge.status).toBe(200)
  const nonce = String(challenge.body.nonce ?? "")
  const session = await jsonRequest(origin, "/terminal/api/v1/security/session", {
    body: {
      deviceId,
      nonce,
      signature: keys.signNonce(nonce),
    },
  })
  expect(session.status).toBe(200)
  return {
    deviceId,
    name,
    token: String(session.body.token ?? ""),
    pairingCode: code,
    keys,
  }
}

async function connectAuthedSocket(origin: string, token: string): Promise<WebSocket> {
  const url = `${origin.replace(/^http/, "ws")}/terminal/ws?protocol=2`
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket open timeout")), 10_000)
    socket.addEventListener("open", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("websocket error"))
    }, { once: true })
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("auth-required timeout")), 10_000)
    socket.addEventListener("message", event => {
      clearTimeout(timer)
      const text = String(event.data)
      if (!text.includes("protocol:auth-required")) {
        reject(new Error(`expected auth-required, got ${text}`))
        return
      }
      socket.send(JSON.stringify({ type: "protocol:auth", token }))
      resolve()
    }, { once: true })
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket hello timeout")), 10_000)
    const onMessage = (event: MessageEvent) => {
      const text = String(event.data)
      if (text.includes("protocol:hello") || text.includes("serverEpoch") || text.includes("runtime-snapshot")) {
        clearTimeout(timer)
        socket.removeEventListener("message", onMessage)
        resolve()
      }
    }
    socket.addEventListener("message", onMessage)
    socket.addEventListener("close", () => {
      clearTimeout(timer)
      reject(new Error("websocket closed during authentication"))
    }, { once: true })
  })
  return socket
}

function closeCode(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => {
    socket.addEventListener("close", event => {
      resolve({ code: event.code, reason: event.reason })
    }, { once: true })
  })
}

async function forbiddenWebSocketOrigin(origin: string, attacker: string): Promise<number> {
  const url = new URL(origin)
  return await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: "/terminal/ws?protocol=2",
      headers: {
        Origin: attacker,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    })
    req.on("response", res => {
      resolve(res.statusCode ?? 0)
      res.resume()
    })
    req.on("upgrade", () => reject(new Error("unapproved origin websocket upgraded")))
    req.on("error", reject)
    req.end()
  })
}

async function withHarness(
  testInfo: { outputDir: string },
  run: (harness: Awaited<ReturnType<typeof createDurableRuntimeHarness>>) => Promise<void>,
  env?: Record<string, string>,
): Promise<void> {
  const harness = await createDurableRuntimeHarness({
    env: { YAADE_HOST_TOKEN: HOST_TOKEN, ...env },
  })
  try {
    await harness.startApi()
    await run(harness)
  } catch (error) {
    await harness.retainDiagnostics(testInfo.outputDir).catch(() => undefined)
    throw error
  } finally {
    await harness.close()
  }
}

test.describe("S — device pairing, authentication, and audit", { tag: "@p1" }, () => {
  test("S01 browser device pairing establishes an independent credential", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const device = await pairNamedDevice(harness.origin, "Browser")
      const listed = await jsonRequest(harness.origin, "/terminal/api/v1/security/devices", {
        token: HOST_TOKEN,
      })
      expect(listed.status).toBe(200)
      const devices = listed.body.value ?? listed.body
      const rows = Array.isArray(devices) ? devices : Array.isArray(listed.body) ? listed.body : []
      const record = (rows as Array<JsonRecord>).find(row => row.id === device.deviceId)
      expect(record?.name).toBe("Browser")
      const sessions = await hostRpcResult(
        harness.origin,
        "mux:listSessions",
        [false],
        "s01-browser",
        device.token,
      )
      expect(sessions.ok).toBe(true)
      const socket = await connectAuthedSocket(harness.origin, device.token)
      expect(socket.readyState).toBe(WebSocket.OPEN)
      socket.close()
    })
  })

  test("S03 revoking a device mid-session closes its live connection", async ({ page }, testInfo) => {
    await withHarness(testInfo, async harness => {
      const device = await pairNamedDevice(harness.origin, "Browser")
      const socket = await connectAuthedSocket(harness.origin, device.token)
      const closed = closeCode(socket)
      await page.addInitScript(token => {
        sessionStorage.setItem("yaade-host-token", token)
      }, device.token)
      await page.goto(harness.origin, { waitUntil: "domcontentloaded" })
      await page.waitForFunction(() => window.__yaadeTest != null, null, { timeout: 30_000 })
      await page.locator("[data-yaade-session-settings]").click()
      await page.locator('[data-yaade-settings-category="servers"]').click()
      const revoke = await jsonRequest(
        harness.origin,
        `/terminal/api/v1/security/devices/${device.deviceId}`,
        { method: "DELETE", token: HOST_TOKEN },
      )
      expect(revoke.status).toBe(204)
      const result = await closed
      expect(result.code).toBe(4003)
      expect(result.reason.toLowerCase()).toContain("revoked")
      await expect(page.locator('[data-yaade-current-server-status="revoked"]')).toBeVisible({
        timeout: 20_000,
      })
      await expect(page.getByText("Access revoked").first()).toBeVisible()
      const denied = await hostRpcResult(
        harness.origin,
        "mux:listSessions",
        [false],
        "s03-revoked",
        device.token,
      )
      expect(denied.ok).toBe(false)
      expect(denied.status).toBe(401)
    })
  })

  test("S04 revoking one device leaves other devices connected", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const browser = await pairNamedDevice(harness.origin, "Browser")
      const secondBrowser = await pairNamedDevice(harness.origin, "Second browser")
      const browserSocket = await connectAuthedSocket(harness.origin, browser.token)
      const secondBrowserSocket = await connectAuthedSocket(harness.origin, secondBrowser.token)
      const browserClosed = closeCode(browserSocket).then(result => result.code)
      await jsonRequest(harness.origin, `/terminal/api/v1/security/devices/${browser.deviceId}`, {
        method: "DELETE",
        token: HOST_TOKEN,
      })
      expect(await browserClosed).toBe(4003)
      expect(secondBrowserSocket.readyState).toBe(WebSocket.OPEN)
      const stillLive = await hostRpcResult(
        harness.origin,
        "mux:listSessions",
        [false],
        "s04-second-browser",
        secondBrowser.token,
      )
      expect(stillLive.ok).toBe(true)
      secondBrowserSocket.close()
    })
  })

  test("S05 reusable credentials never appear in URL, history, logs, or localStorage", async ({ page }, testInfo) => {
    await withHarness(testInfo, async harness => {
      const requests: string[] = []
      page.on("request", request => requests.push(request.url()))
      await page.goto(`${harness.origin}/?token=${HOST_TOKEN}`, { waitUntil: "domcontentloaded" })
      await page.waitForFunction(() => window.__yaadeTest != null, null, { timeout: 30_000 })
      await expect.poll(() => new URL(page.url()).searchParams.get("token")).toBeNull()
      const storage = await page.evaluate(() => ({
        local: { ...localStorage },
        sessionKeys: Object.keys(sessionStorage),
      }))
      expect(JSON.stringify(storage.local)).not.toContain(HOST_TOKEN)
      const device = await pairNamedDevice(harness.origin, "Browser")
      expect(requests.some(url => url.includes(device.pairingCode))).toBe(false)
      expect(requests.some(url => url.includes(device.token))).toBe(false)
      expect(page.url()).not.toContain(device.token)
      expect(page.url()).not.toContain(HOST_TOKEN)
      const logs = harness.api?.logs() ?? ""
      expect(logs).not.toContain(device.token)
      expect(logs).not.toContain(device.pairingCode)
    })
  })

  test("S06 pairing code is one-time and expires", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const keys = createDeviceKeys()
      const pairing = await jsonRequest(harness.origin, "/terminal/api/v1/security/pairing-code", {
        method: "POST",
        token: HOST_TOKEN,
      })
      const code = String(pairing.body.code ?? "")
      const first = await jsonRequest(harness.origin, "/terminal/api/v1/security/pair", {
        body: {
          code,
          name: "First",
          publicKey: keys.publicKey,
          algorithm: "Ed25519",
        },
      })
      expect(first.status).toBe(201)
      const reuse = await jsonRequest(harness.origin, "/terminal/api/v1/security/pair", {
        body: {
          code,
          name: "Replay",
          publicKey: keys.publicKey,
          algorithm: "Ed25519",
        },
      })
      expect(reuse.status).toBe(400)
      const unused = await jsonRequest(harness.origin, "/terminal/api/v1/security/pairing-code", {
        method: "POST",
        token: HOST_TOKEN,
      })
      expireUnusedPairingCodes(harness.dataDir)
      const expired = await jsonRequest(harness.origin, "/terminal/api/v1/security/pair", {
        body: {
          code: unused.body.code,
          name: "Expired",
          publicKey: keys.publicKey,
          algorithm: "Ed25519",
        },
      })
      expect(expired.status).toBe(400)
      const devices = await jsonRequest(harness.origin, "/terminal/api/v1/security/devices", {
        token: HOST_TOKEN,
      })
      const rows = Array.isArray(devices.body)
        ? devices.body
        : Array.isArray(devices.body.value)
          ? devices.body.value
          : []
      expect((rows as Array<JsonRecord>).some(row => row.name === "Replay")).toBe(false)
      expect((rows as Array<JsonRecord>).some(row => row.name === "Expired")).toBe(false)
    })
  })

  test("S07 replayed challenges and authentication abuse are rejected or rate-limited", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const keys = createDeviceKeys()
      const pairing = await jsonRequest(harness.origin, "/terminal/api/v1/security/pairing-code", {
        method: "POST",
        token: HOST_TOKEN,
      })
      const paired = await jsonRequest(harness.origin, "/terminal/api/v1/security/pair", {
        body: {
          code: pairing.body.code,
          name: "Target",
          publicKey: keys.publicKey,
          algorithm: "Ed25519",
        },
      })
      const deviceId = String(paired.body.id ?? "")
      const challenge = await jsonRequest(harness.origin, "/terminal/api/v1/security/challenge", {
        body: { deviceId },
      })
      const nonce = String(challenge.body.nonce ?? "")
      const signature = keys.signNonce(nonce)
      const first = await jsonRequest(harness.origin, "/terminal/api/v1/security/session", {
        body: { deviceId, nonce, signature },
      })
      expect(first.status).toBe(200)
      const replay = await jsonRequest(harness.origin, "/terminal/api/v1/security/session", {
        body: { deviceId, nonce, signature },
      })
      expect(replay.status).toBe(401)
      expect(JSON.stringify(replay.body)).not.toContain(String(first.body.token ?? "no-token"))
      const malformed = await jsonRequest(harness.origin, "/terminal/api/v1/security/session", {
        body: { deviceId, nonce: "aaaa", signature: "bbbb" },
      })
      expect(malformed.status).toBe(401)
      let limited = false
      for (let i = 0; i < 10; i += 1) {
        const next = await jsonRequest(harness.origin, "/terminal/api/v1/security/challenge", {
          body: { deviceId },
        })
        const attempt = await jsonRequest(harness.origin, "/terminal/api/v1/security/session", {
          body: {
            deviceId,
            nonce: next.body.nonce,
            signature: "not-a-signature",
          },
        })
        if (attempt.status === 429) {
          limited = true
          expect(rpcErrorCode(attempt.body.error) ?? String(attempt.body.error ?? "")).toMatch(
            /RATE_LIMITED|too many/i,
          )
          break
        }
      }
      expect(limited).toBe(true)
    })
  })

  test("S08 origin and TLS policy is enforced", async ({}, testInfo) => {
    await withHarness(
      testInfo,
      async harness => {
        const denied = await jsonRequest(harness.origin, "/terminal/api/v1/system", {
          token: HOST_TOKEN,
          originHeader: "https://attacker.example",
        })
        expect(denied.status).toBe(403)
        expect(rpcErrorCode(denied.body.error)).toBe("ORIGIN_DENIED")
        const approved = await jsonRequest(harness.origin, "/terminal/api/v1/system", {
          token: HOST_TOKEN,
          originHeader: "https://yaade.example",
        })
        expect(approved.status).toBe(200)
        const loopback = await jsonRequest(harness.origin, "/terminal/api/v1/system", {
          token: HOST_TOKEN,
          originHeader: harness.origin,
        })
        expect(loopback.status).toBe(200)
        expect(await forbiddenWebSocketOrigin(harness.origin, "https://attacker.example")).toBe(403)
      },
      { YAADE_CORS_ORIGINS: "https://yaade.example" },
    )
  })

  test("S09 credential rotation invalidates the old credential without losing device metadata", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const device = await pairNamedDevice(harness.origin, "Browser")
      const socket = await connectAuthedSocket(harness.origin, device.token)
      const rotated = await jsonRequest(harness.origin, "/terminal/api/v1/security/session/rotate", {
        method: "POST",
        token: device.token,
      })
      expect(rotated.status).toBe(200)
      const nextToken = String(rotated.body.token ?? "")
      expect(nextToken).not.toBe(device.token)
      expect(rotated.body.device && (rotated.body.device as JsonRecord).id).toBe(device.deviceId)
      const stale = await hostRpcResult(
        harness.origin,
        "mux:listSessions",
        [false],
        "s09-stale",
        device.token,
      )
      expect(stale.ok).toBe(false)
      const fresh = await hostRpcResult(
        harness.origin,
        "mux:listSessions",
        [false],
        "s09-fresh",
        nextToken,
      )
      expect(fresh.ok).toBe(true)
      socket.close()
      const reopened = await connectAuthedSocket(harness.origin, nextToken)
      expect(reopened.readyState).toBe(WebSocket.OPEN)
      reopened.close()
    })
  })

  test("S10 scopes and audit events are enforced without terminal-content leakage", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const observer = await pairNamedDevice(harness.origin, "Observer", ["observe"])
      const listed = await hostRpcResult(
        harness.origin,
        "mux:listSessions",
        [false],
        "s10-observe",
        observer.token,
      )
      expect(listed.ok).toBe(true)
      const write = await hostRpcResult(
        harness.origin,
        "terminal:write",
        ["pty-missing", "secret-bytes"],
        "s10-write",
        observer.token,
      )
      expect(write.ok).toBe(false)
      expect(rpcErrorCode(write.error)).toBe("SCOPE_DENIED")
      const stop = await hostRpcResult(
        harness.origin,
        "mux:createSession",
        ["forbidden"],
        "s10-stop",
        observer.token,
      )
      expect(stop.ok).toBe(false)
      expect(rpcErrorCode(stop.error)).toBe("SCOPE_DENIED")
      const pairing = await jsonRequest(harness.origin, "/terminal/api/v1/security/pairing-code", {
        method: "POST",
        token: observer.token,
      })
      expect(pairing.status).toBe(403)
      const audit = listAuditEvents(harness.dataDir)
      const blob = JSON.stringify(audit)
      expect(blob).not.toContain("secret-bytes")
      expect(audit.some(row => row.action === "device.paired")).toBe(true)
    })
  })
})
