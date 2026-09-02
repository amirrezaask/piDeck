import { expect, test } from "@playwright/test"
import { createDurableRuntimeHarness } from "../runtime/harness/index.js"
import { waitUntil } from "../runtime/harness/wait.js"

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("browser exit preserves the PTY while host crash cleanup ends its process group", async () => {
  const harness = await createDurableRuntimeHarness()
  try {
    await harness.startApi()
    const firstBrowser = await harness.startBrowser()
    await expect(firstBrowser.page.locator("[data-yaade-terminal-panel]")).toBeVisible({
      timeout: 30_000,
    })
    const before = await firstBrowser.page.evaluate(() => window.__yaadeTest?.getState())
    const terminal = before?.muxTerminals?.find(item => item.id === before.activeMuxTerminalId)
    const pid = terminal?.output.processIdentity?.pid
    if (!terminal || !pid) throw new Error("terminal process identity is unavailable")
    expect(processAlive(pid)).toBe(true)

    await firstBrowser.close()
    const reattachedBrowser = await harness.startBrowser()
    const reattached = await reattachedBrowser.page.evaluate(() => window.__yaadeTest?.getState())
    const sameTerminal = reattached?.muxTerminals?.find(item => item.id === terminal.id)
    expect(sameTerminal?.output.processIdentity?.pid).toBe(pid)
    expect(sameTerminal?.output.processState).toBe("running")
    expect(processAlive(pid)).toBe(true)
    await reattachedBrowser.close()

    await harness.restartApi("SIGKILL")
    await waitUntil(() => !processAlive(pid), 10_000, "stale terminal process group cleanup")
    const secondBrowser = await harness.startBrowser(undefined, `/?s=${terminal.sessionId}&term=${terminal.id}`)
    await expect(secondBrowser.page.locator('[data-yaade-terminal-interrupted]')).toBeVisible({
      timeout: 30_000,
    })
    const after = await secondBrowser.page.evaluate(() => window.__yaadeTest?.getState())
    const recovered = after?.muxTerminals?.find(item => item.id === terminal.id)
    expect(recovered?.output.processState).toBe("interrupted")
    expect(recovered?.output.ptyId).toBeUndefined()
  } finally {
    await harness.close()
  }
})
