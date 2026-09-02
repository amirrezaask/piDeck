import { realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionUIContext,
  ModelRuntime,
  Theme,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentModel,
  AgentModelOption,
  AgentSystemPromptMode,
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

export interface PiExtensionUIRequest {
  readonly kind: 'approval' | 'question';
  readonly title: string;
  readonly body: string;
  readonly options: string[];
  readonly timeoutMs?: number;
}

export interface PiExtensionUI {
  request(input: PiExtensionUIRequest): Promise<string | undefined>;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
}

export interface CreatePiSessionOptions {
  readonly systemPrompt: string;
  readonly systemPromptMode: AgentSystemPromptMode;
  readonly cwd?: string;
  readonly tools?: AgentToolName[];
  readonly model?: AgentModel;
  readonly thinkingLevel?: AgentThinkingLevel;
  readonly extensionUI?: PiExtensionUI;
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

export class PiExtensionRequestCancelledError extends Error {
  constructor() {
    super('A PI extension request was declined by the operator');
    this.name = 'PiExtensionRequestCancelledError';
  }
}

interface ExtensionUIState {
  cancelled: boolean;
}

class SdkManagedPiSession implements ManagedPiSession {
  constructor(
    private readonly session: AgentSession,
    private readonly extensionUIState?: ExtensionUIState,
  ) {}

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
    if (this.extensionUIState) this.extensionUIState.cancelled = false;
    await this.session.prompt(prompt, options);
    if (this.extensionUIState?.cancelled) throw new PiExtensionRequestCancelledError();
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

const unavailableTheme = new Proxy(
  {},
  {
    get() {
      return () => '';
    },
  },
) as Theme;

function extensionUIContext(ui: PiExtensionUI, state: ExtensionUIState): ExtensionUIContext {
  return {
    select: (title, options, opts) =>
      ui.request({
        kind: 'question',
        title,
        body: title,
        options,
        ...(opts?.timeout === undefined ? {} : { timeoutMs: opts.timeout }),
      }),
    confirm: async (title, message, opts) => {
      const confirmed =
        (await ui.request({
          kind: 'approval',
          title,
          body: message,
          options: ['Confirm', 'Cancel'],
          ...(opts?.timeout === undefined ? {} : { timeoutMs: opts.timeout }),
        })) === 'Confirm';
      if (!confirmed) state.cancelled = true;
      return confirmed;
    },
    input: (title, placeholder, opts) =>
      ui.request({
        kind: 'question',
        title,
        body: placeholder ?? '',
        options: [],
        ...(opts?.timeout === undefined ? {} : { timeoutMs: opts.timeout }),
      }),
    notify: (message, type) => ui.notify(message, type),
    onTerminalInput: () => () => undefined,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    async custom<T>(): Promise<T> {
      throw new Error('Custom extension UI is unavailable in piDeck');
    },
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => '',
    editor: async () => undefined,
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    theme: unavailableTheme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Theme switching is unavailable in piDeck' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  };
}

async function bindExtensionUI(
  session: AgentSession,
  ui: PiExtensionUI | undefined,
): Promise<ExtensionUIState | undefined> {
  if (!ui) return undefined;
  const state: ExtensionUIState = { cancelled: false };
  await session.bindExtensions({
    uiContext: extensionUIContext(ui, state),
    mode: 'rpc',
    onError: (error) => ui.notify(`${error.extensionPath}: ${error.error}`, 'error'),
  });
  return state;
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
      ...(options.systemPromptMode === 'replace'
        ? { systemPromptOverride: () => options.systemPrompt }
        : {
            appendSystemPromptOverride: (base: string[]) => [
              ...base,
              `## Agent instructions\n\n${options.systemPrompt}`,
            ],
          }),
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
      ...(options.tools?.length ? { tools: options.tools } : {}),
      ...(options.tools?.length === 0 ? { noTools: 'all' as const } : {}),
      ...(model ? { model } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    });

    const extensionUIState = await bindExtensionUI(result.session, options.extensionUI);
    return new SdkManagedPiSession(result.session, extensionUIState);
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
      ...(options.systemPromptMode === 'replace'
        ? { systemPromptOverride: () => options.systemPrompt }
        : {
            appendSystemPromptOverride: (base: string[]) => [
              ...base,
              `## Agent instructions\n\n${options.systemPrompt}`,
            ],
          }),
    });
    await resourceLoader.reload();
    const result = await pi.createAgentSession({
      cwd,
      agentDir: pi.getAgentDir(),
      modelRuntime: await this.getModelRuntime(),
      resourceLoader,
      sessionManager,
      ...(options.tools?.length ? { tools: options.tools } : {}),
      ...(options.tools?.length === 0 ? { noTools: 'all' as const } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    });
    const extensionUIState = await bindExtensionUI(result.session, options.extensionUI);
    return new SdkManagedPiSession(result.session, extensionUIState);
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
