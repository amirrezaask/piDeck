import type { PersistedExecutionEvent } from '@nextflow/contracts';

export type ExecutionEventListener = (event: PersistedExecutionEvent) => void;

export class ExecutionEventHub {
  private readonly listeners = new Map<string, Set<ExecutionEventListener>>();

  subscribe(executionId: string, listener: ExecutionEventListener): () => void {
    const listeners = this.listeners.get(executionId) ?? new Set<ExecutionEventListener>();
    listeners.add(listener);
    this.listeners.set(executionId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(executionId);
      }
    };
  }

  publish(event: PersistedExecutionEvent): void {
    const listeners = this.listeners.get(event.executionId);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }
}
