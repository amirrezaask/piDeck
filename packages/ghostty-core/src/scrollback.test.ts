import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { GhosttyTerminalCore } from "./core.js"
import { nodeGhosttyWasmSource } from "./loaders/node.js"

const theme = {
  foreground: { r: 229, g: 231, b: 235 },
  background: { r: 0, g: 0, b: 0 },
  cursor: { r: 229, g: 231, b: 235 },
}

function viewportText(core: GhosttyTerminalCore): string {
  return core.snapshot(false).rowData.map(row => row.text.trimEnd()).join("\n")
}

describe("Ghostty scrollback anchoring", () => {
  it("keeps the inspected rows stable while lines append", async () => {
    const core = await GhosttyTerminalCore.create(
      20,
      4,
      8,
      16,
      theme,
      () => undefined,
      await nodeGhosttyWasmSource(),
      "render-only",
    )
    try {
      core.write(Array.from({ length: 20 }, (_, index) => `ROW-${index}`).join("\r\n"))
      const live = core.scrollbarState()
      assert.ok(live)
      assert.equal(core.isViewportActive(), true)

      core.scroll(-5)
      const inspecting = core.scrollbarState()
      assert.ok(inspecting)
      assert.equal(core.isViewportActive(), false)
      const anchor = viewportText(core)

      core.write("\r\nROW-20\r\nROW-21")
      const appended = core.scrollbarState()
      assert.ok(appended)
      assert.equal(viewportText(core), anchor)
      assert.equal(appended.offset, inspecting.offset)
      assert.equal(appended.total - inspecting.total, 2)

      core.write("\u001b[HREWRITE")
      assert.equal(viewportText(core), anchor)
      assert.equal(core.scrollbarState()?.total, appended.total)

      core.scrollToBottom()
      assert.equal(core.isViewportActive(), true)
      assert.match(viewportText(core), /ROW-21/)
    } finally {
      core.dispose()
    }
  })

  it("restores scrollback after alternate-screen entry and resize", async () => {
    const core = await GhosttyTerminalCore.create(
      20,
      4,
      8,
      16,
      theme,
      () => undefined,
      await nodeGhosttyWasmSource(),
      "render-only",
    )
    try {
      core.write(Array.from({ length: 12 }, (_, index) => `LINE-${index}`).join("\r\n"))
      core.scroll(-3)
      const anchor = viewportText(core)

      core.write("\u001b[?1049hALT\u001b[?1049l")
      assert.equal(viewportText(core), anchor)

      core.resize(24, 5, 8, 16)
      assert.equal(core.isViewportActive(), false)
      core.scrollToBottom()
      assert.equal(core.isViewportActive(), true)
    } finally {
      core.dispose()
    }
  })
})
