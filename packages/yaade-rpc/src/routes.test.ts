import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { MoveTerminalToTab } from "./mux-session.js"
import {
  GHOSTTY_ENGINE_REVISION,
  TERMINAL_CHECKPOINT_MAGIC,
  TERMINAL_CHECKPOINT_VERSION,
} from "./host.js"
import {
  decodeHostRouteArgs,
  decodeHostRouteResult,
  getHostRoute,
  HOST_HOT_ROUTES,
  isHostRouteName,
  terminalAttachControlResult,
} from "./routes.js"

test("route registry owns argument and result validation", () => {
  assert.equal(isHostRouteName("mux:listSessions"), true)
  assert.equal(isHostRouteName("mux:not-a-route"), false)
  assert.equal(getHostRoute("mux:listSessions")?.pathPolicy.kind, "none")
  assert.deepEqual(
    decodeHostRouteArgs("mux:listSessions", [false]),
    [false],
  )
  assert.throws(() => decodeHostRouteArgs("mux:listSessions", []))
  assert.throws(() => decodeHostRouteArgs("mux:listSessions", [42]))
  assert.deepEqual(decodeHostRouteResult("mux:listSessions", []), [])
})

test("terminal move routes validate both terminal and Window identifiers", () => {
  const command = {
    _tag: "MoveTerminalToTab",
    muxTerminalId: "term-route-test",
    targetTabId: "tab-route-test",
  }
  const [decoded] = decodeHostRouteArgs("mux:moveTerminal", [command])
  assert.ok(decoded instanceof MoveTerminalToTab)
  assert.equal(decoded.muxTerminalId, command.muxTerminalId)
  assert.equal(decoded.targetTabId, command.targetTabId)
  assert.throws(() =>
    decodeHostRouteArgs("mux:moveTerminal", [
      { ...command, targetTabId: "not-a-window" },
    ]),
  )
})

test("terminal theme routes preserve the colors used for protocol queries", () => {
  const theme = {
    foreground: { r: 1, g: 2, b: 3 },
    background: { r: 4, g: 5, b: 6 },
    cursor: { r: 7, g: 8, b: 9 },
  }
  assert.deepEqual(
    decodeHostRouteArgs("terminal:create", [
      "/workspace",
      { cols: 120, rows: 40, theme },
    ]),
    ["/workspace", { cols: 120, rows: 40, theme }],
  )
  assert.deepEqual(
    decodeHostRouteArgs("terminal:setTheme", ["pty-1", theme]),
    ["pty-1", theme],
  )
  assert.throws(() =>
    decodeHostRouteArgs("terminal:setTheme", [
      "pty-1",
      { ...theme, background: { r: 256, g: 5, b: 6 } },
    ]),
  )
})

test("terminal replay pages accept an explicit backward cursor direction", () => {
  assert.deepEqual(
    decodeHostRouteArgs("terminal:readReplayPage", [
      "pty-1",
      0,
      256 * 1024,
      "backward",
    ]),
    ["pty-1", 0, 256 * 1024, "backward"],
  )
  assert.throws(() =>
    decodeHostRouteArgs("terminal:readReplayPage", [
      "pty-1",
      0,
      256 * 1024,
      "sideways",
    ]),
  )
})

test("terminal attach preserves the owner identity used by binary snapshots", () => {
  const encoded = {
    id: "pty-1",
    title: "fish",
    terminalEpoch: "terminal-epoch",
    ownerId: "server-1",
    ownerEpoch: "server-epoch",
    protocolVersion: 2,
    replayQuality: "exact",
    outputChunks: [],
    output: "",
    replayTruncated: false,
    replayNeedsQueryResponses: false,
    archiveAvailable: true,
    lastSequence: 12,
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    signal: null,
    semanticSnapshot: null,
  }
  const decoded = decodeHostRouteResult("terminal:attach", encoded)
  assert.equal(decoded?.ownerId, "server-1")
  assert.equal(decoded?.ownerEpoch, "server-epoch")
  const control = terminalAttachControlResult(encoded)
  assert.ok(control)
  assert.equal("semanticSnapshot" in control, false)
})

test("terminal checkpoints preserve compatibility metadata and reject unsafe bounds", () => {
  const checkpoint = {
    magic: TERMINAL_CHECKPOINT_MAGIC,
    checkpointVersion: TERMINAL_CHECKPOINT_VERSION,
    terminalEpoch: "terminal-epoch",
    sequence: 12,
    cols: 80,
    rows: 24,
    createdAt: "2026-01-01T00:00:00.000Z",
    engine: "ghostty-vt",
    engineRevision: GHOSTTY_ENGINE_REVISION,
    snapshotFormatVersion: 1,
    codec: "none",
    payloadBytes: 10,
    payloadSha256: "0".repeat(64),
    snapshotBytes: "R0hPU1RTTlABAA==",
  }
  const attach = {
    id: "pty-1",
    title: null,
    terminalEpoch: "terminal-epoch",
    checkpoint,
    replayQuality: "checkpoint",
    outputChunks: [],
    output: "",
    replayTruncated: true,
    replayNeedsQueryResponses: false,
    archiveAvailable: true,
    lastSequence: 12,
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    signal: null,
  }
  assert.ok(decodeHostRouteResult("terminal:attach", attach)?.checkpoint)
  assert.equal(
    decodeHostRouteResult("terminal:attach", {
      ...attach,
      checkpoint: { ...checkpoint, engineRevision: "other" },
    })?.checkpoint?.engineRevision,
    "other",
  )
  assert.throws(() => decodeHostRouteResult("terminal:attach", {
    ...attach,
    checkpoint: { ...checkpoint, payloadBytes: 8 * 1024 * 1024 + 1 },
  }))
})

test("hot terminal routes are selected from the same registry", () => {
  assert.deepEqual([...HOST_HOT_ROUTES].sort(), [
    "terminal:attach",
    "terminal:detach",
    "terminal:ready",
    "terminal:resize",
    "terminal:write",
    "terminal:writeBinary",
  ])
})
