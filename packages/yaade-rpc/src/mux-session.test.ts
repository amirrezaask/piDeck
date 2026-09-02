import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { Schema } from "effect"
import {
  MuxTerminal,
  SaveSessionTabLayout,
  TerminalInput,
  TerminalKind,
  TerminalOutput,
} from "./mux-session.js"

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown): A =>
  Schema.decodeUnknownSync(schema)(value)

describe("terminal multiplexer schemas", () => {
  it("accepts only terminal records", () => {
    assert.equal(decode(TerminalKind, "terminal"), "terminal")
    assert.throws(() => decode(TerminalKind, "command"))
  })

  it("decodes terminal input", () => {
    assert.equal(
      decode(TerminalInput, TerminalInput.make({ kind: "terminal" })).kind,
      "terminal",
    )
  })

  it("keeps tab layout revision optional", () => {
    const command = decode(SaveSessionTabLayout, {
      _tag: "SaveSessionTabLayout",
      tabId: "tab-main",
      layoutJson: "{}",
    })
    assert.equal(command.revision, undefined)
  })

  it("decodes a persisted terminal", () => {
    const terminal = decode(MuxTerminal, {
      id: "term-terminal",
      sessionId: "ses-main",
      kind: "terminal",
      title: "Terminal",
      position: 0,
      status: "running",
      input: TerminalInput.make({ kind: "terminal" }),
      inputRevision: 1,
      output: TerminalOutput.make({
        kind: "process",
        terminalInstanceId: "terminal-1",
        generation: 1,
        processState: "running",
        activityState: "idle",
        replayAvailable: true,
        truncated: false,
      }),
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    assert.equal(terminal.kind, "terminal")
  })
})
