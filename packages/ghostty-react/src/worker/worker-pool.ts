import { validateTerminalWorkerEvent, type TerminalWorkerCommand } from "./protocol.js";
import { FairWorkerScheduler } from "./fair-scheduler.js";

export type WorkerPoolMessageHandler = (value: unknown) => void;
export type WorkerPoolErrorHandler = (error: Error) => void;

export interface TerminalWorkerChannel {
  post(command: TerminalWorkerCommand, transfer?: readonly Transferable[]): void;
  schedulerSnapshot(): { readonly bytes: number; readonly commands: number; readonly inFlight: number }
  release(): void;
}

type QueuedWorkerCommand = {
  readonly command: TerminalWorkerCommand
  readonly transfer: readonly Transferable[]
}

type Slot = {
  worker: Worker;
  readonly workerHolder: { current: Worker }
  readonly scheduler: FairWorkerScheduler<QueuedWorkerCommand>
  readonly priorities: Map<string, { visible: boolean; focused: boolean }>
  readonly terminals: Map<string, { message: WorkerPoolMessageHandler; error: WorkerPoolErrorHandler }>;
};

export const MAX_TERMINAL_WORKERS = 4;

function workerCommandBytes(command: TerminalWorkerCommand): number {
  switch (command.type) {
    case "writeBytes": case "resetAndWriteBytes": return command.data.byteLength
    case "writeReplayBytes": return command.chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    case "recycleRenderUpdate": return Object.values(command.buffers)
      .reduce((total, buffer) => total + buffer.byteLength, 0)
    case "paste": case "text": return command.data.length * 2 + 256
    default: return 256
  }
}

function workerLimit(): number {
  const hardware = typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(MAX_TERMINAL_WORKERS, Math.floor(hardware / 2)));
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export class TerminalWorkerPool {
  private readonly slots: Slot[] = [];
  private disposed = false;

  get workerCount(): number { return this.slots.length; }
  get terminalCount(): number {
    return this.slots.reduce((count, slot) => count + slot.terminals.size, 0);
  }

  acquire(
    terminalId: string,
    onMessage: WorkerPoolMessageHandler,
    onError: WorkerPoolErrorHandler,
  ): TerminalWorkerChannel {
    if (this.disposed) throw new Error("Terminal worker pool is disposed");
    const limit = workerLimit();
    while (this.slots.length < limit && this.slots.length <= this.terminalCount) {
      this.slots.push(this.createSlot());
    }
    const slot = this.slots[hash(terminalId) % this.slots.length];
    if (!slot) throw new Error("Terminal worker pool has no available worker");
    slot.terminals.set(terminalId, { message: onMessage, error: onError });
    let released = false;
    return {
      post: (command, transfer = []) => {
        if (released) return
        if (command.type === "create" || command.type === "setPresentationState") {
          const priority = { visible: command.visible, focused: command.focused }
          slot.priorities.set(terminalId, priority)
          slot.scheduler.setPriority(terminalId, priority)
        }
        const priority = slot.priorities.get(terminalId) ?? { visible: true, focused: false }
        slot.scheduler.enqueue(
          terminalId,
          { command, transfer },
          workerCommandBytes(command),
          priority,
          `${command.generation}:${command.sequence}`,
        )
      },
      schedulerSnapshot: () => slot.scheduler.snapshot(),
      release: () => {
        if (released) return;
        released = true;
        slot.scheduler.cancel(terminalId)
        slot.priorities.delete(terminalId)
        slot.terminals.delete(terminalId);
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) slot.worker.terminate();
    this.slots.length = 0;
  }

  private createSlot(): Slot {
    const worker = this.createWorker(this.slots.length + 1)
    const workerHolder = { current: worker }
    const slot: Slot = {
      worker,
      workerHolder,
      scheduler: new FairWorkerScheduler((_terminalId, queued) => {
        workerHolder.current.postMessage(queued.command, [...queued.transfer])
      }),
      priorities: new Map(),
      terminals: new Map(),
    };
    this.installSlotListeners(slot);
    return slot;
  }

  private createWorker(index: number): Worker {
    return new Worker(new URL("./terminal-worker.ts", import.meta.url), {
      type: "module",
      name: `yaade-terminal-${index}`,
    });
  }

  private installSlotListeners(slot: Slot): void {
    const worker = slot.worker;
    worker.addEventListener("message", event => {
      const value = event.data;
      if (typeof value !== "object" || value === null || !("terminalId" in value) || typeof value.terminalId !== "string") return;
      if (validateTerminalWorkerEvent(value) &&
          (value.type === "completed" || value.type === "ready" ||
            value.type === "recoverableError" || value.type === "fatalError")) {
        slot.scheduler.complete(value.terminalId, `${value.generation}:${value.sequence}`)
      }
      slot.terminals.get(value.terminalId)?.message(value);
    });
    const fail = (reason: unknown) => {
      if (this.disposed || slot.worker !== worker) return;
      const error = reason instanceof Error ? reason : new Error("Terminal worker failed");
      worker.terminate();
      slot.scheduler.reset()
      slot.worker = this.createWorker(this.slots.indexOf(slot) + 1);
      slot.workerHolder.current = slot.worker
      this.installSlotListeners(slot);
      for (const listener of slot.terminals.values()) listener.error(error);
    };
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
  }
}

let sharedPool: TerminalWorkerPool | null = null;

export function terminalWorkerPool(): TerminalWorkerPool {
  sharedPool ??= new TerminalWorkerPool();
  return sharedPool;
}
