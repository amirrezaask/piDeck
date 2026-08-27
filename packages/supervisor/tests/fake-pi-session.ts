import type {
  AgentModel,
  AgentModelOption,
  AgentThinkingLevel,
  ManagedAgentModelsResponse,
} from '@nextflow/contracts';

import type {
  CreatePiSessionOptions,
  ManagedPiSession,
  PiImageContent,
  PiSessionFactory,
  ResumePiSessionOptions,
} from '../pi-session';

export class Deferred<T> {
  readonly promise: Promise<T>;
  private _resolve!: (value: T | PromiseLike<T>) => void;
  private _reject!: (reason?: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }
  resolve(value: T): void {
    this._resolve(value);
  }
  reject(reason: unknown): void {
    this._reject(reason);
  }
}

export class FakePiSession implements ManagedPiSession {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly model: AgentModel = { provider: 'fake', id: 'fake-model' };
  readonly thinkingLevel: AgentThinkingLevel = 'off';
  readonly prompts: string[] = [];
  readonly steering: string[] = [];
  readonly followUps: string[] = [];
  readonly promptImages: PiImageContent[][] = [];
  readonly steeringImages: PiImageContent[][] = [];
  readonly followUpImages: PiImageContent[][] = [];
  readonly listeners = new Set<(event: unknown) => void>();
  isStreaming = false;
  messageCount = 0;
  pendingMessageCount = 0;
  disposeCount = 0;
  abortCount = 0;
  unsubscribeCount = 0;
  private settleCurrent: (() => void) | undefined;
  private rejectCurrent: ((reason?: unknown) => void) | undefined;

  constructor(
    identity: number | string,
    private readonly preflightAccepted = true,
    private readonly controls: {
      preflightDeferred?: Deferred<boolean>;
      abortMode?: 'resolve' | 'reject' | 'hang';
      abortError?: Error;
    } = {},
  ) {
    this.sessionId = `fake-pi-session-${identity}`;
    this.sessionFile = `/tmp/fake-pi-session-${identity}.jsonl`;
  }

  async prompt(
    prompt: string,
    options?: {
      streamingBehavior?: 'steer' | 'followUp';
      preflightResult?: (success: boolean) => void;
      images?: PiImageContent[];
    },
  ): Promise<void> {
    const preflightAccepted = this.controls.preflightDeferred
      ? await this.controls.preflightDeferred.promise
      : this.preflightAccepted;
    options?.preflightResult?.(preflightAccepted);
    if (options?.images?.length) this.promptImages.push(options.images);
    if (!preflightAccepted) return;
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
    await new Promise<void>((resolve, reject) => {
      this.settleCurrent = resolve;
      this.rejectCurrent = reject;
    });
  }

  async steer(message: string, images?: PiImageContent[]): Promise<void> {
    this.steering.push(message);
    if (images?.length) this.steeringImages.push(images);
    this.pendingMessageCount += 1;
    this.emit({ type: 'queue_update', steering: [...this.steering], followUp: this.followUps });
  }

  async followUp(message: string, images?: PiImageContent[]): Promise<void> {
    this.followUps.push(message);
    if (images?.length) this.followUpImages.push(images);
    this.pendingMessageCount += 1;
    this.emit({ type: 'queue_update', steering: this.steering, followUp: [...this.followUps] });
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    if (this.controls.abortMode === 'hang') await new Promise<void>(() => undefined);
    if (this.controls.abortMode === 'reject') {
      throw this.controls.abortError ?? new Error('abort rejected');
    }
    this.settle();
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.unsubscribeCount += 1;
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
    this.listeners.clear();
  }

  emitExternal(event: unknown): void {
    this.emit(event);
  }

  rejectPrompt(reason: unknown = new Error('prompt rejected')): void {
    this.isStreaming = false;
    this.rejectCurrent?.(reason);
    this.rejectCurrent = undefined;
    this.settleCurrent = undefined;
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
    this.rejectCurrent = undefined;
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
  readonly resumeRequests: ResumePiSessionOptions[] = [];

  async listModels(): Promise<ManagedAgentModelsResponse> {
    const model: AgentModelOption = { provider: 'fake', id: 'fake-model', name: 'Fake model' };
    return { models: [model], defaultModel: model };
  }

  constructor(
    private readonly options: {
      preflightAccepted?: boolean;
      createError?: Error;
      createDeferred?: Deferred<void>;
      preflightDeferred?: Deferred<boolean>;
      abortMode?: 'resolve' | 'reject' | 'hang';
      abortError?: Error;
      shutdownTimeoutMs?: number;
    } = {},
  ) {}

  async create(options: CreatePiSessionOptions): Promise<ManagedPiSession> {
    this.requests.push(options);
    if (this.options.createDeferred) await this.options.createDeferred.promise;
    if (this.options.createError) throw this.options.createError;
    const session = new FakePiSession(
      this.sessions.length + 1,
      this.options.preflightAccepted ?? true,
      {
        ...(this.options.preflightDeferred
          ? { preflightDeferred: this.options.preflightDeferred }
          : {}),
        ...(this.options.abortMode ? { abortMode: this.options.abortMode } : {}),
        ...(this.options.abortError ? { abortError: this.options.abortError } : {}),
      },
    );
    this.sessions.push(session);
    return session;
  }

  async resume(options: ResumePiSessionOptions): Promise<ManagedPiSession> {
    this.resumeRequests.push(options);
    const identity = options.sessionId.replace('fake-pi-session-', '');
    const session = new FakePiSession(identity, this.options.preflightAccepted ?? true);
    this.sessions.push(session);
    return session;
  }
}
