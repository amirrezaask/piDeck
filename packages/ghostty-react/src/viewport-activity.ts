export type TerminalViewportActivityMode = "live" | "inspecting" | "paused"

export type TerminalViewportActivity = {
  readonly mode: TerminalViewportActivityMode
  readonly unseenRows: number | null
}

export type TerminalViewportActivityFacts = {
  readonly viewportActive: boolean
  readonly totalRows: number | null
  readonly viewportOffset: number | null
  readonly geometryGeneration: number
  readonly contentGeneration: number
  readonly alternateScreen: boolean
}

const LIVE_ACTIVITY: TerminalViewportActivity = {
  mode: "live",
  unseenRows: 0,
}

function normalizedCount(value: number | null): number | null {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return null
  return value
}

function saturatedAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function sameActivity(
  left: TerminalViewportActivity,
  right: TerminalViewportActivity,
): boolean {
  return left.mode === right.mode && left.unseenRows === right.unseenRows
}

/**
 * Content-free viewport activity policy. Surface integrations call `observe`
 * once per presented terminal update and use explicit methods for user intent.
 */
export class TerminalViewportActivityPolicy {
  private activity: TerminalViewportActivity = LIVE_ACTIVITY
  private previousFacts: TerminalViewportActivityFacts | null = null
  private readonly listeners = new Set<(activity: TerminalViewportActivity) => void>()

  get current(): TerminalViewportActivity {
    return this.activity
  }

  subscribe(listener: (activity: TerminalViewportActivity) => void): () => void {
    this.listeners.add(listener)
    listener(this.activity)
    return () => {
      this.listeners.delete(listener)
    }
  }

  observe(facts: TerminalViewportActivityFacts): void {
    const nextFacts = {
      ...facts,
      totalRows: normalizedCount(facts.totalRows),
      viewportOffset: normalizedCount(facts.viewportOffset),
    }
    const previous = this.previousFacts
    this.previousFacts = nextFacts

    if (nextFacts.alternateScreen || nextFacts.viewportActive) {
      this.publish(LIVE_ACTIVITY)
      return
    }

    if (this.activity.mode === "live") {
      this.publish({ mode: "inspecting", unseenRows: 0 })
      return
    }

    if (!previous) return
    if (nextFacts.geometryGeneration !== previous.geometryGeneration) {
      this.publish({ ...this.activity, unseenRows: null })
      return
    }

    const previousTotal = previous.totalRows
    const nextTotal = nextFacts.totalRows
    if (previousTotal === null || nextTotal === null) {
      if (nextFacts.contentGeneration !== previous.contentGeneration) {
        this.publish({ ...this.activity, unseenRows: null })
      }
      return
    }

    const appendedRows = nextTotal - previousTotal
    if (appendedRows > 0) {
      const unseenRows = this.activity.unseenRows
      this.publish({
        ...this.activity,
        unseenRows: unseenRows === null ? null : saturatedAdd(unseenRows, appendedRows),
      })
      return
    }
    if (appendedRows < 0) {
      this.publish({ ...this.activity, unseenRows: null })
      return
    }

    const retentionMovedViewport =
      nextFacts.contentGeneration !== previous.contentGeneration &&
      nextFacts.viewportOffset !== null &&
      previous.viewportOffset !== null &&
      nextFacts.viewportOffset < previous.viewportOffset
    const retentionAtFloor =
      nextFacts.contentGeneration !== previous.contentGeneration &&
      nextFacts.viewportOffset === 0 &&
      previous.viewportOffset === 0
    if (retentionMovedViewport || retentionAtFloor) {
      this.publish({ ...this.activity, unseenRows: null })
    }
  }

  pause(): void {
    if (this.activity.mode === "live") return
    this.publish({ ...this.activity, mode: "paused" })
  }

  resume(): void {
    if (this.activity.mode !== "paused") return
    this.publish({ ...this.activity, mode: "inspecting" })
  }

  jumpToLive(): void {
    this.publish(LIVE_ACTIVITY)
  }

  dispose(): void {
    this.listeners.clear()
  }

  private publish(next: TerminalViewportActivity): void {
    if (sameActivity(this.activity, next)) return
    this.activity = next
    for (const listener of this.listeners) listener(next)
  }
}
