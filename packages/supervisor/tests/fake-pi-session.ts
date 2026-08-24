import type {
  AgentModel,
  AgentModelOption,
  AgentThinkingLevel,
  ManagedAgentModelsResponse,
} from '@nextflow/contracts';

import type { CreatePiSessionOptions, ManagedPiSession, PiSessionFactory } from '../src/pi-session';

export class FakePiSession implements ManagedPiSession {
  readonly sessionId = 'fake-pi-session';
  readonly sessionFile = '/tmp/fake-pi-session.jsonl';
  readonly model: AgentModel = { provider: 'fake', id: 'fake-model' };
  readonly thinkingLevel: AgentThinkingLevel = 'off';
  readonly prompts: string[] = [];
  readonly steering: string[] = [];
  readonly followUps: string[] = [];
  readonly listeners = new Set<(event: unknown) => void>();
  isStreaming = false;
  messageCount = 0;
  pendingMessageCount = 0;
  disposeCount = 0;
  abortCount = 0;
  private settleCurrent: (() => void) | undefined;

  constructor(private readonly preflightAccepted = true) {}

  async prompt(
    prompt: string,
    options?: {
      streamingBehavior?: 'steer' | 'followUp';
      preflightResult?: (success: boolean) => void;
    },
  ): Promise<void> {
    options?.preflightResult?.(this.preflightAccepted);
    if (!this.preflightAccepted) return;
    if (this.isStreaming) {
      if (!options?.streamingBehavior) {
        throw new Error('streaming behavior required');
      }
      if (options.streamingBehavior === 'steer') {
        await this.steer(prompt);
      } else {
        await this.followUp(prompt);
      }
      return;
    }

    this.prompts.push(prompt);
    this.isStreaming = true;
    this.messageCount += 1;
    this.emit({ type: 'agent_start' });
    this.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'working' },
    });
    await new Promise<void>((resolve) => {
      this.settleCurrent = resolve;
    });
  }

  async steer(message: string): Promise<void> {
    this.steering.push(message);
    this.pendingMessageCount += 1;
    this.emit({ type: 'queue_update', steering: [...this.steering], followUp: this.followUps });
  }

  async followUp(message: string): Promise<void> {
    this.followUps.push(message);
    this.pendingMessageCount += 1;
    this.emit({ type: 'queue_update', steering: this.steering, followUp: [...this.followUps] });
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    this.settle();
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
    this.listeners.clear();
  }

  emitExternal(event: unknown): void {
    this.emit(event);
  }

  settle(): void {
    if (!this.isStreaming) {
      return;
    }
    this.isStreaming = false;
    this.messageCount += 1;
    this.pendingMessageCount = 0;
    this.emit({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    });
    this.emit({ type: 'agent_end', messages: [], willRetry: false });
    this.emit({ type: 'agent_settled' });
    this.settleCurrent?.();
    this.settleCurrent = undefined;
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export class FakePiSessionFactory implements PiSessionFactory {
  readonly sessions: FakePiSession[] = [];
  readonly requests: CreatePiSessionOptions[] = [];

  async listModels(): Promise<ManagedAgentModelsResponse> {
    const model: AgentModelOption = { provider: 'fake', id: 'fake-model', name: 'Fake model' };
    return { models: [model], defaultModel: model };
  }

  constructor(
    private readonly options: { preflightAccepted?: boolean; createError?: Error } = {},
  ) {}

  async create(options: CreatePiSessionOptions): Promise<ManagedPiSession> {
    this.requests.push(options);
    if (this.options.createError) throw this.options.createError;
    const session = new FakePiSession(this.options.preflightAccepted ?? true);
    this.sessions.push(session);
    return session;
  }
}
