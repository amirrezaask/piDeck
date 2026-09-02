/**
 * Coalesce opaque PTY bytes onto animation frames for floods; flush interactive
 * echoes on a microtask so key-to-paint stays near one frame.
 */

export type TerminalOutputWriter = {
  enqueue: (data: Uint8Array, onConsumed?: () => void) => void
  enqueueReplay: (data: Uint8Array, onConsumed?: () => void) => void
  discardPending: () => void
  flush: () => void
  dispose: () => void
}

export type TerminalOutputWriterOptions = {
  write: (data: Uint8Array, onPainted?: () => void) => void
  writeReplay?: (data: readonly Uint8Array[], onPainted?: () => void) => void
  onPosted?: (bytes: number) => void
  onPainted?: () => void
  refreshAfterPaint?: () => void
  schedule?: (cb: () => void) => number
  cancel?: (id: number) => void
  scheduleFrameFallback?: (cb: () => void, delayMs: number) => number
  cancelFrameFallback?: (id: number) => void
  maxFrameWaitMs?: number
  frameClockActive?: () => boolean
  maxPendingBytes?: number
  maxBytesPerFlush?: number
  interactiveMaxBytes?: number
}

export const TERMINAL_OUTPUT_MAX_PENDING_BYTES = 512 * 1024
export const TERMINAL_OUTPUT_INTERACTIVE_MAX_BYTES = 256
export const GHOSTTY_OUTPUT_MAX_BYTES_PER_FLUSH = 256 * 1024

const CURSOR_HIDE = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c])
const CURSOR_SHOW = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x68])

function containsSequence(data: Uint8Array, needle: Uint8Array): boolean {
  const last = data.byteLength - needle.byteLength
  for (let offset = 0; offset <= last; offset += 1) {
    let matches = true
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (data[offset + index] !== needle[index]) {
        matches = false
        break
      }
    }
    if (matches) return true
  }
  return false
}

function concatParts(parts: readonly Uint8Array[], byteLength: number): Uint8Array {
  if (parts.length === 0) return new Uint8Array()
  if (parts.length === 1 && parts[0]!.byteLength === byteLength) return parts[0]!
  const joined = new Uint8Array(byteLength)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return joined
}

export function createTerminalOutputWriter(
  options: TerminalOutputWriterOptions,
): TerminalOutputWriter {
  const schedule =
    options.schedule ??
    (typeof requestAnimationFrame === "function"
      ? (cb: () => void) => requestAnimationFrame(cb)
      : (cb: () => void) => setTimeout(cb, 0) as unknown as number)
  const cancel =
    options.cancel ??
    (typeof cancelAnimationFrame === "function"
      ? (id: number) => cancelAnimationFrame(id)
      : (id: number) => clearTimeout(id))
  const scheduleFrameFallback =
    options.scheduleFrameFallback ??
    ((cb: () => void, delayMs: number) =>
      setTimeout(cb, delayMs) as unknown as number)
  const cancelFrameFallback =
    options.cancelFrameFallback ?? ((id: number) => clearTimeout(id))
  const maxFrameWaitMs = options.maxFrameWaitMs ?? 100
  const frameClockActive =
    options.frameClockActive ??
    (() => typeof document === "undefined" || document.visibilityState !== "hidden")
  const maxPending = options.maxPendingBytes ?? TERMINAL_OUTPUT_MAX_PENDING_BYTES
  const maxPerFlush = options.maxBytesPerFlush ?? Number.POSITIVE_INFINITY
  const interactiveMax =
    options.interactiveMaxBytes ?? TERMINAL_OUTPUT_INTERACTIVE_MAX_BYTES

  type PendingPart = { data: Uint8Array; offset: number; onConsumed?: () => void }
  const pendingParts: PendingPart[] = []
  const replayParts: PendingPart[] = []
  let pendingBytes = 0
  let replayBytes = 0
  let needsRefresh = false
  let raf = 0
  let frameFallback = 0
  let microScheduled = false
  let disposed = false
  let gapDetected = false
  let floodMode = false

  const shedOldest = () => {
    while (pendingBytes > maxPending && pendingParts.length > 1) {
      const dropped = pendingParts.shift()!
      pendingBytes -= dropped.data.byteLength - dropped.offset
      gapDetected = true
    }
    if (pendingBytes > maxPending && pendingParts.length === 1) {
      const only = pendingParts[0]!
      const available = only.data.byteLength - only.offset
      only.offset += available - maxPending
      delete only.onConsumed
      gapDetected = true
      pendingBytes = maxPending
    }
  }

  const takePending = (
    limit: number,
  ): { data: Uint8Array; consumed: Array<() => void> } => {
    if (pendingParts.length === 0 || limit <= 0) {
      return { data: new Uint8Array(), consumed: [] }
    }
    const views: Uint8Array[] = []
    const consumed: Array<() => void> = []
    let taken = 0
    while (pendingParts.length > 0 && taken < limit) {
      const head = pendingParts[0]!
      const available = head.data.byteLength - head.offset
      const count = Math.min(available, limit - taken)
      views.push(head.data.subarray(head.offset, head.offset + count))
      head.offset += count
      pendingBytes -= count
      taken += count
      if (head.offset === head.data.byteLength) {
        pendingParts.shift()
        if (!gapDetected && head.onConsumed) consumed.push(head.onConsumed)
      }
    }
    return { data: concatParts(views, taken), consumed }
  }

  const markRefresh = (data: Uint8Array): void => {
    if (
      options.refreshAfterPaint != null &&
      (containsSequence(data, CURSOR_HIDE) || containsSequence(data, CURSOR_SHOW))
    ) {
      needsRefresh = true
    }
  }

  const flushReplayNow = (): void => {
    if (disposed || replayParts.length === 0) return
    const parts = replayParts.splice(0)
    const bytes = replayBytes
    replayBytes = 0
    const doRefresh = needsRefresh && pendingBytes === 0
    if (doRefresh) needsRefresh = false
    const onPainted = () => {
      if (disposed) return
      for (const part of parts) part.onConsumed?.()
      if (doRefresh) options.refreshAfterPaint?.()
      options.onPainted?.()
    }
    const chunks = parts.map(part => part.data.subarray(part.offset))
    if (options.writeReplay) {
      options.onPosted?.(bytes)
      options.writeReplay(chunks, onPainted)
      return
    }
    for (const chunk of chunks) {
      options.onPosted?.(chunk.byteLength)
      options.write(chunk)
    }
    onPainted()
  }

  const flushNow = (unlimited = false) => {
    if (replayBytes > 0) flushReplayNow()
    if (replayBytes > 0) return
    raf = 0
    microScheduled = false
    if (disposed || (pendingBytes === 0 && !needsRefresh)) {
      if (pendingBytes === 0) floodMode = false
      return
    }
    const { data, consumed } = takePending(
      unlimited ? Number.POSITIVE_INFINITY : maxPerFlush,
    )
    const doRefresh = needsRefresh && pendingBytes === 0
    if (doRefresh) needsRefresh = false
    if (data.byteLength === 0) {
      if (doRefresh) options.refreshAfterPaint?.()
      options.onPainted?.()
      if (pendingBytes === 0) floodMode = false
      return
    }
    options.onPosted?.(data.byteLength)
    options.write(data, () => {
      if (disposed) return
      for (const acknowledge of consumed) acknowledge()
      if (doRefresh) options.refreshAfterPaint?.()
      options.onPainted?.()
    })
    if (pendingBytes > 0 || needsRefresh) scheduleNext()
    else floodMode = false
  }

  const scheduleRaf = () => {
    if (disposed || raf) return
    microScheduled = false
    raf = schedule(() => {
      if (!raf) return
      raf = 0
      if (frameFallback) {
        cancelFrameFallback(frameFallback)
        frameFallback = 0
      }
      flushNow(false)
    })
    frameFallback = scheduleFrameFallback(() => {
      frameFallback = 0
      if (!raf) return
      cancel(raf)
      raf = 0
      flushNow(false)
    }, maxFrameWaitMs)
  }

  const scheduleMicro = () => {
    if (disposed || raf || microScheduled) return
    microScheduled = true
    queueMicrotask(() => {
      if (!microScheduled || disposed) return
      microScheduled = false
      if (raf) return
      flushNow(false)
    })
  }

  const scheduleNext = () => {
    if (!frameClockActive()) {
      if (raf) {
        cancel(raf)
        raf = 0
      }
      if (frameFallback) {
        cancelFrameFallback(frameFallback)
        frameFallback = 0
      }
      scheduleMicro()
      return
    }
    if (floodMode || pendingBytes > interactiveMax) {
      floodMode = true
      scheduleRaf()
    } else {
      scheduleMicro()
    }
  }

  return {
    enqueue(data, onConsumed) {
      if (disposed || data.byteLength === 0) return
      pendingParts.push(onConsumed ? { data, offset: 0, onConsumed } : { data, offset: 0 })
      pendingBytes += data.byteLength
      shedOldest()
      markRefresh(data)
      scheduleNext()
    },
    enqueueReplay(data, onConsumed) {
      if (disposed || data.byteLength === 0) return
      replayParts.push(onConsumed ? { data, offset: 0, onConsumed } : { data, offset: 0 })
      replayBytes += data.byteLength
      markRefresh(data)
    },
    discardPending() {
      if (raf) cancel(raf)
      if (frameFallback) cancelFrameFallback(frameFallback)
      raf = 0
      frameFallback = 0
      microScheduled = false
      pendingParts.length = 0
      pendingBytes = 0
      needsRefresh = false
      floodMode = false
      gapDetected = false
    },
    flush() {
      if (raf) cancel(raf)
      if (frameFallback) cancelFrameFallback(frameFallback)
      raf = 0
      frameFallback = 0
      microScheduled = false
      flushReplayNow()
      while (pendingBytes > 0 || needsRefresh) flushNow(true)
    },
    dispose() {
      disposed = true
      if (raf) cancel(raf)
      if (frameFallback) cancelFrameFallback(frameFallback)
      raf = 0
      frameFallback = 0
      microScheduled = false
      pendingParts.length = 0
      replayParts.length = 0
      pendingBytes = 0
      replayBytes = 0
      needsRefresh = false
      floodMode = false
    },
  }
}
