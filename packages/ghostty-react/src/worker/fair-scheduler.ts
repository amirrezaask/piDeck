export type WorkerPriority = { readonly visible: boolean; readonly focused: boolean }

type CompletionKey = string | number
type Pending<T> = { readonly value: T; readonly bytes: number; readonly key: CompletionKey }
type Lane<T> = {
  readonly queue: Pending<T>[]
  priority: WorkerPriority
  deficit: number
  inFlightKey: CompletionKey | null
}

export const WORKER_SCHEDULER_LIMITS = {
  maxBytes: 32 * 1024 * 1024,
  maxCommands: 8_192,
  maxInFlight: 8,
  quantumBytes: 64 * 1024,
} as const

function weight(priority: WorkerPriority): number {
  if (priority.visible && priority.focused) return 8
  return priority.visible ? 4 : 1
}

/** Strict per-terminal FIFO with bounded weighted deficit round-robin service. */
export class FairWorkerScheduler<T> {
  private readonly lanes = new Map<string, Lane<T>>()
  private order: string[] = []
  private cursor = 0
  private bytes = 0
  private commands = 0
  private inFlight = 0
  private scheduled = false

  constructor(private readonly dispatch: (terminalId: string, value: T) => void) {}

  enqueue(
    terminalId: string,
    value: T,
    bytes: number,
    priority: WorkerPriority,
    key: CompletionKey,
  ): void {
    const cost = Math.max(1, bytes)
    if (this.bytes + cost > WORKER_SCHEDULER_LIMITS.maxBytes ||
        this.commands + 1 > WORKER_SCHEDULER_LIMITS.maxCommands) {
      throw new Error("terminal worker scheduler is full")
    }
    let lane = this.lanes.get(terminalId)
    if (!lane) {
      lane = { queue: [], priority, deficit: 0, inFlightKey: null }
      this.lanes.set(terminalId, lane)
      this.order.push(terminalId)
    }
    lane.priority = priority
    lane.queue.push({ value, bytes: cost, key })
    this.bytes += cost
    this.commands += 1
    this.schedule()
  }

  setPriority(terminalId: string, priority: WorkerPriority): void {
    const lane = this.lanes.get(terminalId)
    if (lane) lane.priority = priority
  }

  complete(terminalId: string, key: CompletionKey): void {
    const lane = this.lanes.get(terminalId)
    if (!lane || lane.inFlightKey !== key) return
    lane.inFlightKey = null
    this.inFlight -= 1
    this.cleanup(terminalId, lane)
    this.schedule()
  }

  cancel(terminalId: string): void {
    const lane = this.lanes.get(terminalId)
    if (!lane) return
    for (const pending of lane.queue) {
      this.bytes -= pending.bytes
      this.commands -= 1
    }
    if (lane.inFlightKey !== null) this.inFlight -= 1
    this.lanes.delete(terminalId)
    this.order = this.order.filter(id => id !== terminalId)
    this.cursor %= Math.max(1, this.order.length)
  }

  reset(): void {
    this.lanes.clear(); this.order = []; this.cursor = 0
    this.bytes = 0; this.commands = 0; this.inFlight = 0
  }

  snapshot(): { bytes: number; commands: number; inFlight: number } {
    return { bytes: this.bytes, commands: this.commands, inFlight: this.inFlight }
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this.pump() })
  }

  private pump(): void {
    if (this.order.length === 0 || this.inFlight >= WORKER_SCHEDULER_LIMITS.maxInFlight) return
    let attempts = 0
    const maxAttempts = this.order.length * 32
    while (this.inFlight < WORKER_SCHEDULER_LIMITS.maxInFlight && attempts < maxAttempts) {
      const terminalId = this.order[this.cursor]
      this.cursor = (this.cursor + 1) % this.order.length
      attempts += 1
      if (!terminalId) continue
      const lane = this.lanes.get(terminalId)
      if (!lane || lane.inFlightKey !== null || lane.queue.length === 0) continue
      lane.deficit += WORKER_SCHEDULER_LIMITS.quantumBytes * weight(lane.priority)
      const pending = lane.queue[0]
      if (!pending || pending.bytes > lane.deficit) continue
      lane.queue.shift()
      lane.deficit -= pending.bytes
      lane.inFlightKey = pending.key
      this.bytes -= pending.bytes
      this.commands -= 1
      this.inFlight += 1
      this.dispatch(terminalId, pending.value)
    }
    const hasDispatchableLane = [...this.lanes.values()]
      .some(lane => lane.inFlightKey === null && lane.queue.length > 0)
    if (this.inFlight < WORKER_SCHEDULER_LIMITS.maxInFlight && hasDispatchableLane) this.schedule()
  }

  private cleanup(terminalId: string, lane: Lane<T>): void {
    if (lane.inFlightKey !== null || lane.queue.length > 0) return
    this.lanes.delete(terminalId)
    this.order = this.order.filter(id => id !== terminalId)
    this.cursor %= Math.max(1, this.order.length)
  }
}
