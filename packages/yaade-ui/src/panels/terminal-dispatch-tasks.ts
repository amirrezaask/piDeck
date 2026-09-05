/** One FIFO task lane shared by terminal writers; never tied to painting.
 * Each turn runs one bounded parser quantum. A writer can retain one entry.
 * The 1,024-entry admission limit is an assumed safety bound, not a throughput target.
 */
export function createTerminalDispatchTasks(requestTurn: (run: () => void) => void) {
  const pending = new Map<number, () => void>()
  let nextId = 0
  let wakePending = false
  const wake = () => {
    if (wakePending || pending.size === 0) return
    wakePending = true
    try {
      requestTurn(run)
    } catch (error) {
      wakePending = false
      throw error
    }
  }
  const run = () => {
    wakePending = false
    const entry = pending.entries().next().value
    if (!entry) return
    pending.delete(entry[0])
    try {
      entry[1]()
    } finally {
      // A failed pane must not strand other ready panes.
      wake()
    }
  }
  return {
    schedule(callback: () => void): number {
      if (pending.size >= 1024) throw new Error("Terminal dispatch task capacity exceeded")
      const id = ++nextId
      pending.set(id, callback)
      try {
        wake()
      } catch (error) {
        pending.delete(id)
        throw error
      }
      return id
    },
    cancel(id: number): void {
      pending.delete(id)
    },
  }
}

let channel: MessageChannel | undefined
export const terminalDispatchTasks = createTerminalDispatchTasks((run) => {
  if (typeof window === "undefined" || typeof MessageChannel === "undefined") {
    setTimeout(run, 0)
    return
  }
  // One lazy channel for this browser realm. Message tasks yield to the event
  // loop without chained timers' minimum-delay clamp. No messages carry bytes.
  channel ??= new MessageChannel()
  channel.port1.onmessage = run
  channel.port2.postMessage(null)
})
