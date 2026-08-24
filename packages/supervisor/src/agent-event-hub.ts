import type { ManagedAgentEvent } from '@nextflow/contracts';

export type ManagedAgentEventListener = (event: ManagedAgentEvent) => void;

export class ManagedAgentEventHub {
  private readonly listeners = new Map<string, Set<ManagedAgentEventListener>>();

  subscribe(agentId: string, listener: ManagedAgentEventListener): () => void {
    const listeners = this.listeners.get(agentId) ?? new Set<ManagedAgentEventListener>();
    listeners.add(listener);
    this.listeners.set(agentId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(agentId);
      }
    };
  }

  publish(event: ManagedAgentEvent): void {
    const listeners = this.listeners.get(event.agentId);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }
}
