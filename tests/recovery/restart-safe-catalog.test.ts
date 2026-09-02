import { afterEach, describe, expect, test } from "vite-plus/test"
import fs from "node:fs"
import path from "node:path"
import { MuxTerminal, AppSession, SessionTab } from "../../packages/yaade-rpc/src/index.js"
import { Schema } from "effect"
import {
  createDurableRuntimeHarness,
  hostRpcResult,
  waitUntil,
  type DurableRuntimeHarness,
} from "../runtime/harness/index.js"

const SessionSnapshot = Schema.Struct({
  session: AppSession,
  tabs: Schema.Array(SessionTab),
  muxTerminals: Schema.Array(MuxTerminal),
})
const SessionSnapshots = Schema.Array(SessionSnapshot)
const HistoryPage = Schema.Struct({
  chunks: Schema.Array(Schema.String),
  nextSequence: Schema.Number,
  complete: Schema.Boolean,
})

let harness: DurableRuntimeHarness | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

async function rpcDecoded<S extends Schema.Schema.AnyNoContext>(
  channel: string,
  args: unknown[],
  schema: S,
): Promise<Schema.Schema.Type<S>> {
  if (!harness) throw new Error("recovery harness is not running")
  const result = await hostRpcResult(harness.origin, channel, args, "recovery-test")
  if (!result.ok) throw new Error(`${channel} failed: ${JSON.stringify(result.error)}`)
  return Schema.decodeUnknownSync(schema)(result.value)
}

describe("restart-safe workspace catalog", () => {
  test("preserves catalog and binary history, interrupts the old PTY, and restarts explicitly", async () => {
    harness = await createDurableRuntimeHarness()
    await harness.startApi()

    const before = (await rpcDecoded("mux:listSessions", [false], SessionSnapshots))[0]
    if (!before) throw new Error("default session is unavailable")
    const tab = before.tabs[0]
    if (!tab) throw new Error("default Window is unavailable")

    const marker = "YAADE_RECOVERY_EXACT_BYTES"
    const created = await rpcDecoded("mux:createTerminal", [{
      sessionId: before.session.id,
      tabId: tab.id,
      title: "Recovery fixture",
      kind: "terminal",
      input: {
        _tag: "TerminalInput",
        kind: "terminal",
        shellArgs: ["-c", `printf '${marker}\\n'; sleep 30`],
      },
    }], MuxTerminal)
    const historyId = created.output.ptyId
    if (!historyId) throw new Error("created terminal has no history identity")

    const archiveDirectory = path.join(
      harness.dataDir,
      "terminal-history",
      Buffer.from(historyId).toString("base64url"),
    )
    await waitUntil(
      () => {
        const active = path.join(archiveDirectory, "active.bin")
        return fs.existsSync(active) && fs.statSync(active).size > 8
      },
      5_000,
      "terminal active history segment",
    )

    await harness.restartApi("SIGKILL")

    const recoveredSnapshots = await rpcDecoded("mux:listSessions", [false], SessionSnapshots)
    const recoveredSnapshot = recoveredSnapshots.find(
      snapshot => snapshot.session.id === before.session.id,
    )
    const recovered = recoveredSnapshot?.muxTerminals.find(terminal => terminal.id === created.id)
    expect(recoveredSnapshot?.tabs.some(candidate => candidate.id === tab.id)).toBe(true)
    expect(recovered).toMatchObject({
      id: created.id,
      sessionId: before.session.id,
      tabId: tab.id,
      status: "disconnected",
      output: {
        historyId,
        generation: created.output.generation,
        processState: "interrupted",
        replayAvailable: true,
      },
    })
    expect(recovered?.output.ptyId).toBeUndefined()
    expect(recovered?.output.processIdentity).toBeUndefined()

    const page = await rpcDecoded(
      "terminal:readReplayPage",
      [historyId, 0, 256 * 1024],
      HistoryPage,
    )
    const replay = Buffer.concat(page.chunks.map(chunk => Buffer.from(chunk, "base64")))
    expect(replay.includes(Buffer.from(marker))).toBe(true)

    if (!recovered) throw new Error("recovered terminal is unavailable")
    const restarted = await rpcDecoded(
      "mux:restartTerminal",
      [recovered.id, recovered.revision],
      MuxTerminal,
    )
    expect(restarted.output.processState).toBe("running")
    expect(restarted.output.generation).toBe(created.output.generation + 1)
    expect(restarted.output.ptyId).not.toBe(historyId)
  })
})
