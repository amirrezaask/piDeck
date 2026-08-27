import { realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import type {
  AgentSession,
  AgentSessionEvent,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentModel,
  AgentModelOption,
  AgentThinkingLevel,
  AgentToolName,
  ManagedAgentModelsResponse,
} from '@nextflow/contracts';
import { resolveWorkingDirectory } from './working-directory.js';

export interface PiImageContent {
  readonly type: 'image';
  readonly data: string;
  readonly mimeType: string;
}

export interface ManagedPiSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  readonly messageCount: number;
  readonly pendingMessageCount: number;
  readonly model: AgentModel | null;
  readonly thinkingLevel: AgentThinkingLevel;
  prompt(
    prompt: string,
    options?: {
      streamingBehavior?: 'steer' | 'followUp';
      preflightResult?: (success: boolean) => void;
      images?: PiImageContent[];
    },
  ): Promise<void>;
  steer(message: string, images?: PiImageContent[]): Promise<void>;
  followUp(message: string, images?: PiImageContent[]): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): Promise<void>;
}

export interface CreatePiSessionOptions {
  readonly systemPrompt: string;
  readonly cwd?: string;
  readonly tools?: AgentToolName[];
  readonly model?: AgentModel;
  readonly thinkingLevel?: AgentThinkingLevel;
}

export interface ResumePiSessionOptions extends CreatePiSessionOptions {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
}

export interface PiSessionFactory {
  create(options: CreatePiSessionOptions): Promise<ManagedPiSession>;
  resume?(options: ResumePiSessionOptions): Promise<ManagedPiSession>;
  listModels?(): Promise<ManagedAgentModelsResponse>;
}

export interface SdkPiSessionFactoryOptions {
  readonly defaultCwd?: string;
  readonly sessionDirectory?: string;
}

class SdkManagedPiSession implements ManagedPiSession {
  constructor(private readonly session: AgentSession) {}

  get sessionId(): string {
    return this.session.sessionId;
  }

  get sessionFile(): string | undefined {
    return this.session.sessionFile;
  }

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  get messageCount(): number {
    return this.session.messages.length;
  }

  get pendingMessageCount(): number {
    return this.session.pendingMessageCount;
  }

  get model(): AgentModel | null {
    const model = this.session.model;
    return model ? { provider: model.provider, id: model.id } : null;
  }

  get thinkingLevel(): AgentThinkingLevel {
    return this.session.thinkingLevel;
  }

  async prompt(
    prompt: string,
    options?: {
      streamingBehavior?: 'steer' | 'followUp';
      preflightResult?: (success: boolean) => void;
      images?: PiImageContent[];
    },
  ): Promise<void> {
    await this.session.prompt(prompt, options);
  }

  async steer(message: string, images?: PiImageContent[]): Promise<void> {
    await this.session.steer(message, images);
  }

  async followUp(message: string, images?: PiImageContent[]): Promise<void> {
    await this.session.followUp(message, images);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  subscribe(listener: (event: unknown) => void): () => void {
    return this.session.subscribe(listener as (event: AgentSessionEvent) => void);
  }

  async dispose(): Promise<void> {
    this.session.dispose();
  }
}

function modelOption(model: { provider: string; id: string; name: string }): AgentModelOption {
  return { provider: model.provider, id: model.id, name: model.name };
}

function resolveConfiguredDefaultModel(
  modelRuntime: ModelRuntime,
  provider: string | undefined,
  id: string | undefined,
): { provider: string; id: string; name: string } | undefined {
  if (!provider || !id) {
    return undefined;
  }
  const model = modelRuntime.getModel(provider, id);
  return model && modelRuntime.hasConfiguredAuth(model.provider) ? model : undefined;
}

export class SdkPiSessionFactory implements PiSessionFactory {
  private readonly defaultCwd: string;
  private readonly sessionDirectory: string | undefined;
  private piModule?: Promise<typeof import('@earendil-works/pi-coding-agent')>;
  private modelRuntime?: Promise<ModelRuntime>;

  constructor(options: SdkPiSessionFactoryOptions = {}) {
    this.defaultCwd = resolveWorkingDirectory(options.defaultCwd ?? process.cwd());
    this.sessionDirectory = options.sessionDirectory
      ? resolve(options.sessionDirectory)
      : undefined;
  }

  async listModels(): Promise<ManagedAgentModelsResponse> {
    const pi = await this.getPiModule();
    const modelRuntime = await this.getModelRuntime();
    const models = modelRuntime.getAvailableSnapshot().map(modelOption);
    const settings = pi.SettingsManager.create(this.defaultCwd, pi.getAgentDir());
    const configuredDefault = resolveConfiguredDefaultModel(
      modelRuntime,
      settings.getDefaultProvider(),
      settings.getDefaultModel(),
    );
    const defaultModel = configuredDefault ? modelOption(configuredDefault) : (models[0] ?? null);
    return { models, defaultModel };
  }

  async create(options: CreatePiSessionOptions): Promise<ManagedPiSession> {
    const cwd = resolveWorkingDirectory(options.cwd ?? this.defaultCwd);
    const pi = await this.getPiModule();
    const agentDir = pi.getAgentDir();
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd,
      agentDir,
      appendSystemPromptOverride: (base) => [
        ...base,
        `## Agent instructions\n\n${options.systemPrompt}`,
      ],
    });
    await resourceLoader.reload();

    const modelRuntime = await this.getModelRuntime();
    const model = options.model
      ? modelRuntime.getModel(options.model.provider, options.model.id)
      : undefined;
    if (options.model && !model) {
      throw new Error(`Unknown Pi model ${options.model.provider}/${options.model.id}`);
    }

    const result = await pi.createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoader,
      sessionManager: pi.SessionManager.create(cwd, this.sessionDirectory),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(model ? { model } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    });

    return new SdkManagedPiSession(result.session);
  }

  async resume(options: ResumePiSessionOptions): Promise<ManagedPiSession> {
    const cwd = resolveWorkingDirectory(options.cwd);
    const sessionFile = await realpath(resolve(options.sessionFile));
    const sessionRoot = await realpath(resolve(this.sessionDirectory ?? dirname(sessionFile)));
    const pathFromRoot = relative(sessionRoot, sessionFile);
    if (pathFromRoot.startsWith('..') || resolve(sessionRoot, pathFromRoot) !== sessionFile) {
      throw new Error('pi_session_outside_configured_directory');
    }

    const pi = await this.getPiModule();
    const sessionManager = pi.SessionManager.open(sessionFile, sessionRoot);
    if (sessionManager.getSessionId() !== options.sessionId) {
      throw new Error('pi_session_id_mismatch');
    }
    if (resolveWorkingDirectory(sessionManager.getCwd()) !== cwd) {
      throw new Error('pi_session_cwd_mismatch');
    }
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd,
      agentDir: pi.getAgentDir(),
      appendSystemPromptOverride: (base) => [
        ...base,
        `## Agent instructions\n\n${options.systemPrompt}`,
      ],
    });
    await resourceLoader.reload();
    const result = await pi.createAgentSession({
      cwd,
      agentDir: pi.getAgentDir(),
      modelRuntime: await this.getModelRuntime(),
      resourceLoader,
      sessionManager,
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    });
    return new SdkManagedPiSession(result.session);
  }

  private getPiModule(): Promise<typeof import('@earendil-works/pi-coding-agent')> {
    this.piModule ??= import('@earendil-works/pi-coding-agent');
    return this.piModule;
  }

  private getModelRuntime(): Promise<ModelRuntime> {
    this.modelRuntime ??= this.getPiModule().then(({ ModelRuntime }) => ModelRuntime.create());
    return this.modelRuntime;
  }
}
