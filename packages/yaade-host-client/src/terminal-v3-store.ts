import {
  applyTerminalSemanticPatch,
  type TerminalPatchMessage,
  type TerminalSemanticSnapshot,
  type TerminalSnapshotMessage,
} from "@yaade/rpc"

export type TerminalV3ApplyResult = "applied" | "ignored" | "resync-required"

/** Client-side semantic state projection; it never parses PTY bytes. */
export class TerminalV3Store {
  private terminalId: string | null = null
  private ownerEpoch: string | null = null
  private terminalEpoch: string | null = null
  private revision = 0
  private current: TerminalSemanticSnapshot | null = null

  private listeners = new Set<(snapshot: TerminalSemanticSnapshot | null, result: TerminalV3ApplyResult) => void>()

  onChange(
    listener: (snapshot: TerminalSemanticSnapshot | null, result: TerminalV3ApplyResult) => void,
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(result: TerminalV3ApplyResult): void {
    for (const listener of this.listeners) listener(this.current, result)
  }

  applySnapshot(message: TerminalSnapshotMessage): TerminalV3ApplyResult {
    if (this.terminalId !== null && this.terminalId !== message.terminalId) return "ignored"
    if (
      this.ownerEpoch === message.ownerEpoch &&
      this.terminalEpoch === message.terminalEpoch &&
      message.revision <= this.revision
    ) {
      return "ignored"
    }
    if (
      message.snapshot.revision !== message.revision ||
      !Number.isSafeInteger(message.revision) ||
      message.revision < 0
    ) return "resync-required"
    this.terminalId = message.terminalId
    this.ownerEpoch = message.ownerEpoch
    this.terminalEpoch = message.terminalEpoch
    this.revision = message.revision
    this.current = message.snapshot
    this.notify("applied")
    return "applied"
  }

  applyPatch(message: TerminalPatchMessage): TerminalV3ApplyResult {
    if (
      this.terminalId !== message.terminalId ||
      this.ownerEpoch !== message.ownerEpoch ||
      this.terminalEpoch !== message.terminalEpoch ||
      !this.current
    ) return "resync-required"
    if (
      message.revision !== message.patch.revision ||
      !Number.isSafeInteger(message.revision)
    ) {
      return "resync-required"
    }
    if (message.revision <= this.revision) return "ignored"
    if (message.baseRevision !== this.revision) return "resync-required"
    const next = applyTerminalSemanticPatch(this.current, message.terminalEpoch, message.patch)
    if (!next) return "resync-required"
    this.current = next
    this.revision = message.revision
    this.notify("applied")
    return "applied"
  }

  reset(): void {
    this.terminalId = null
    this.ownerEpoch = null
    this.terminalEpoch = null
    this.revision = 0
    this.current = null
    this.notify("ignored")
  }

  get snapshot(): TerminalSemanticSnapshot | null {
    return this.current
  }

  get currentRevision(): number {
    return this.revision
  }

  get currentTerminalEpoch(): string | null {
    return this.terminalEpoch
  }
}
