import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import {
  COMMAND_CATALOG,
  COMMAND_IDS,
  commandDescriptor,
  validateCommandCatalog,
} from "./catalog.js"
import {
  createCommandRuntime,
  type CommandContext,
  type CommandHandlers,
} from "./runtime.js"

const emptyContext: CommandContext = {
  hasActiveSession: false,
  hasActiveTab: false,
  hasActiveTerminal: false,
  availableTerminalCount: 0,
  activeTabTerminalCount: 0,
  tabCount: 0,
  sidebarLayout: false,
  viewportMode: "unavailable",
  viewportCanPause: false,
}

function handlers(record: (id: string) => void): CommandHandlers {
  return {
    "commandPalette.show": () => record("commandPalette.show"),
    "terminal.newTerminal": () => record("terminal.newTerminal"),
    "terminal.next": () => record("terminal.next"),
    "terminal.previous": () => record("terminal.previous"),
    "tab.next": () => record("tab.next"),
    "tab.previous": () => record("tab.previous"),
    "pane.zoom": () => record("pane.zoom"),
    "pane.splitRight": () => record("pane.splitRight"),
    "pane.splitDown": () => record("pane.splitDown"),
    "terminal.switch": () => record("terminal.switch"),
    "sidebar.toggle": () => record("sidebar.toggle"),
    "session.switch": () => record("session.switch"),
    "terminal.jump": () => record("terminal.jump"),
    "terminal.jumpLive": () => record("terminal.jumpLive"),
    "terminal.toggleInspectionPause": () => record("terminal.toggleInspectionPause"),
    "session.new": () => record("session.new"),
    "tab.new": () => record("tab.new"),
    "tab.close": () => record("tab.close"),
    "terminal.close": () => record("terminal.close"),
    "session.close": () => record("session.close"),
    "settings.show": () => record("settings.show"),
  }
}

describe("command catalog", () => {
  it("has one complete static descriptor for every command id", () => {
    assert.deepEqual(validateCommandCatalog(COMMAND_CATALOG), [])
    assert.equal(COMMAND_CATALOG.length, COMMAND_IDS.length)
    for (const id of COMMAND_IDS) {
      const descriptor = commandDescriptor(id)
      assert.equal(descriptor.id, id)
      assert.ok(descriptor.title.length > 0)
      assert.ok(descriptor.aliases.length > 0)
      assert.ok(descriptor.icon.length > 0)
    }
  })

  it("reports duplicate ids in focused validation", () => {
    const descriptor = commandDescriptor("settings.show")
    assert.deepEqual(
      validateCommandCatalog([descriptor, descriptor], ["settings.show"]),
      ["duplicate command id: settings.show"],
    )
  })
})

describe("scoped command runtime", () => {
  it("dispatches an enabled command exactly once", async () => {
    const calls: string[] = []
    const runtime = createCommandRuntime({
      context: () => emptyContext,
      handlers: handlers(id => calls.push(id)),
    })
    assert.deepEqual(
      await runtime.execute("settings.show", { source: "palette" }),
      { status: "executed" },
    )
    assert.deepEqual(calls, ["settings.show"])
  })

  it("keeps unavailable commands visible with a reason and does not dispatch", async () => {
    const calls: string[] = []
    const runtime = createCommandRuntime({
      context: () => emptyContext,
      handlers: handlers(id => calls.push(id)),
    })
    assert.deepEqual(runtime.availability("terminal.close"), {
      status: "disabled",
      reason: "Focus a terminal first.",
    })
    assert.deepEqual(
      await runtime.execute("terminal.close", { source: "keyboard" }),
      { status: "disabled", reason: "Focus a terminal first." },
    )
    assert.deepEqual(calls, [])
  })

  it("reads focused viewport availability at invocation time", async () => {
    let viewportMode: CommandContext["viewportMode"] = "live"
    const runtime = createCommandRuntime({
      context: () => ({
        ...emptyContext,
        hasActiveTerminal: true,
        viewportMode,
        viewportCanPause: true,
      }),
      handlers: handlers(() => undefined),
    })
    assert.equal(runtime.availability("terminal.jumpLive").status, "disabled")
    viewportMode = "inspecting"
    assert.equal(runtime.availability("terminal.jumpLive").status, "enabled")
  })

  it("reports handler failure through the scoped error surface", async () => {
    const failures: string[] = []
    const base = handlers(() => undefined)
    const runtime = createCommandRuntime({
      context: () => emptyContext,
      handlers: {
        ...base,
        "settings.show": () => {
          throw new Error("settings failed")
        },
      },
      onError: error => failures.push(error),
    })
    assert.deepEqual(
      await runtime.execute("settings.show", { source: "pointer" }),
      { status: "failed" },
    )
    assert.deepEqual(failures, ["settings failed"])
  })
})
