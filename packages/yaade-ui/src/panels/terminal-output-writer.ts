import { terminalDispatchTasks } from "./terminal-dispatch-tasks.js"

/** Ordered, bounded parser dispatch. Presentation never gates byte ingestion. */
export type TerminalOutputWriter = {
  enqueue: (data: Uint8Array, onConsumed?: () => void) => void
  enqueueReplay: (data: Uint8Array, onConsumed?: () => void) => void
  discardPending: () => void
  suspend: () => void
  flush: () => void
  dispose: () => void
}

export type TerminalOutputWriterOptions = {
  /** Completion acknowledges parsing, not painting. */
  write: (data: Uint8Array, onParsed?: () => void) => void
  writeReplay?: (data: readonly Uint8Array[], onParsed?: () => void) => void
  onPosted?: (bytes: number) => void
  onPainted?: () => void
  refreshAfterPaint?: () => void
  /** Task scheduler, deliberately independent of requestAnimationFrame. */
  schedule?: (cb: () => void) => number
  cancel?: (id: number) => void
  maxPendingBytes?: number
  maxBytesPerFlush?: number
  interactiveMaxBytes?: number
  /** Queue/task admission or parser-command failure requires a fresh snapshot. */
  onOverflow?: () => void
}

export const TERMINAL_OUTPUT_MAX_PENDING_BYTES = 512 * 1024
export const TERMINAL_OUTPUT_INTERACTIVE_MAX_BYTES = 256
export const GHOSTTY_OUTPUT_MAX_BYTES_PER_FLUSH = 256 * 1024
const MAX_REPLAY_BYTES = 64 * 1024 * 1024
const MAX_PENDING_PARTS = 4096

type Part = { data: Uint8Array; offset: number; onConsumed?: () => void }

export function createTerminalOutputWriter(
  options: TerminalOutputWriterOptions,
): TerminalOutputWriter {
  if ((options.schedule === undefined) !== (options.cancel === undefined))
    throw new Error("Custom terminal task scheduling requires a matching cancel function")
  const schedule = options.schedule ?? terminalDispatchTasks.schedule
  const cancel = options.cancel ?? terminalDispatchTasks.cancel
  const maxPending = options.maxPendingBytes ?? TERMINAL_OUTPUT_MAX_PENDING_BYTES
  const quantum = options.maxBytesPerFlush ?? GHOSTTY_OUTPUT_MAX_BYTES_PER_FLUSH
  const interactiveMax = options.interactiveMaxBytes ?? TERMINAL_OUTPUT_INTERACTIVE_MAX_BYTES
  if (
    !Number.isSafeInteger(quantum) ||
    quantum < 1 ||
    !Number.isSafeInteger(maxPending) ||
    maxPending < 1
  )
    throw new Error("Terminal output bounds must be positive safe integers")
  const live: Part[] = []
  const replay: Part[] = []
  let liveBytes = 0
  let replayBytes = 0
  let task: number | null = null
  let microScheduled = false
  let inFlight = false
  let disposed = false
  let desynchronized = false
  let generation = 0
  let scheduleGeneration = 0
  let completing = false

  const cancelScheduled = () => {
    scheduleGeneration += 1
    if (task !== null) cancel(task)
    task = null
    microScheduled = false
  }
  const discard = () => {
    generation += 1
    cancelScheduled()
    live.length = 0
    replay.length = 0
    liveBytes = 0
    replayBytes = 0
    inFlight = false
  }
  const overflow = () => {
    discard()
    desynchronized = true
    if (options.onOverflow) options.onOverflow()
    else throw new Error("Terminal output queue overflow; snapshot resynchronization required")
  }
  const scheduleNext = (interactive = true) => {
    if (
      disposed ||
      desynchronized ||
      inFlight ||
      task !== null ||
      microScheduled ||
      liveBytes + replayBytes === 0
    )
      return
    const scheduledGeneration = ++scheduleGeneration
    if (interactive && !completing && replayBytes === 0 && liveBytes <= interactiveMax) {
      microScheduled = true
      queueMicrotask(() => {
        if (!microScheduled || scheduledGeneration !== scheduleGeneration) return
        microScheduled = false
        flushNow()
      })
    } else {
      try {
        task = schedule(() => {
          if (task === null || scheduledGeneration !== scheduleGeneration) return
          task = null
          flushNow()
        })
      } catch {
        overflow()
      }
    }
  }
  const flushNow = () => {
    if (disposed || desynchronized || inFlight || completing) return
    const isReplay = replayBytes > 0
    const queue = isReplay ? replay : live
    if (queue.length === 0) return
    const chunks: Uint8Array[] = []
    const consumed: Array<() => void> = []
    let bytes = 0
    while (queue.length > 0 && bytes < quantum) {
      const part = queue[0]!
      const count = Math.min(part.data.byteLength - part.offset, quantum - bytes)
      chunks.push(part.data.subarray(part.offset, part.offset + count))
      part.offset += count
      bytes += count
      if (part.offset === part.data.byteLength) {
        queue.shift()
        if (part.onConsumed) consumed.push(part.onConsumed)
      }
    }
    if (isReplay) replayBytes -= bytes
    else liveBytes -= bytes
    inFlight = true
    const commandGeneration = generation
    let completed = false
    const onParsed = () => {
      if (completed || disposed || commandGeneration !== generation) return
      completed = true
      inFlight = false
      completing = true
      try {
        for (const acknowledge of consumed) {
          if (disposed || commandGeneration !== generation) return
          acknowledge()
        }
        if (disposed || commandGeneration !== generation) return
        options.refreshAfterPaint?.()
        options.onPainted?.()
      } finally {
        completing = false
        // Continuations yield even when the remaining slice is tiny or a
        // synchronous parser/ACK callback immediately supplies more bytes.
        if (commandGeneration === generation) scheduleNext(false)
      }
    }
    options.onPosted?.(bytes)
    try {
      if (isReplay && options.writeReplay) {
        options.writeReplay(chunks, onParsed)
      } else {
        let data = chunks[0]!
        if (chunks.length > 1) {
          data = new Uint8Array(bytes)
          let offset = 0
          for (const chunk of chunks) {
            data.set(chunk, offset)
            offset += chunk.byteLength
          }
        }
        options.write(data, onParsed)
      }
    } catch (error) {
      if (disposed || commandGeneration !== generation) throw error
      // A rejected worker command has no future parse credit. Fence this
      // replica rather than leaving the writer permanently in flight.
      overflow()
    }
  }
  return {
    enqueue(data, onConsumed) {
      if (disposed || desynchronized || data.byteLength === 0) return
      if (liveBytes + data.byteLength > maxPending || live.length >= MAX_PENDING_PARTS)
        return overflow()
      live.push({ data, offset: 0, onConsumed })
      liveBytes += data.byteLength
      scheduleNext()
    },
    enqueueReplay(data, onConsumed) {
      if (disposed || desynchronized || data.byteLength === 0) return
      if (replayBytes + data.byteLength > MAX_REPLAY_BYTES || replay.length >= MAX_PENDING_PARTS)
        return overflow()
      replay.push({ data, offset: 0, onConsumed })
      replayBytes += data.byteLength
      // Attach explicitly starts replay via flush(). Subsequent slices are
      // demand-driven by parser completion, just like live output.
    },
    discardPending() {
      discard()
      desynchronized = false
    },
    suspend() {
      discard()
      desynchronized = true
    },
    flush() {
      cancelScheduled()
      flushNow()
    },
    dispose() {
      disposed = true
      discard()
    },
  }
}
