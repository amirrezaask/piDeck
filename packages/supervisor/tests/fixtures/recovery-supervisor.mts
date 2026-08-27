import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createMigrationDatabase,
  createSupervisorDatabase,
  migrateToLatest,
} from '@nextflow/database';
import type { AgentModel, ManagedAgentModelsResponse } from '@nextflow/contracts';

import supervisorPackage from '../../index.js';
import type {
  CreatePiSessionOptions,
  ManagedPiSession,
  PiSessionFactory,
  ResumePiSessionOptions,
  SupervisorLifecyclePhase,
} from '../../index.js';

const { ManagedAgentService } = supervisorPackage;

const [mode, databasePath, sessionDirectory, targetPhase] = process.argv.slice(2) as [
  'run' | 'inspect',
  string,
  string,
  SupervisorLifecyclePhase | undefined,
];
const promptMarker = join(sessionDirectory, 'prompt-count.log');
mkdirSync(sessionDirectory, { recursive: true });

class FixtureSession implements ManagedPiSession {
  readonly model: AgentModel = { provider: 'fake', id: 'fixture-model' };
  readonly thinkingLevel = 'off' as const;
  readonly listeners = new Set<(event: unknown) => void>();
  isStreaming = false;
  messageCount = 0;
  pendingMessageCount = 0;
  private settlePrompt: (() => void) | undefined;

  constructor(
    readonly sessionId: string,
    readonly sessionFile: string,
  ) {}

  async prompt(
    prompt: string,
    options?: { preflightResult?: (success: boolean) => void },
  ): Promise<void> {
    appendFileSync(promptMarker, `${prompt.length}\n`, { mode: 0o600 });
    options?.preflightResult?.(true);
    this.isStreaming = true;
    this.messageCount += 1;
    this.emit({ type: 'agent_start' });
    this.emit({ type: 'message_update', delta: 'fixture' });
    await new Promise<void>((resolve) => {
      this.settlePrompt = resolve;
    });
  }

  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}

  async abort(): Promise<void> {
    this.settle();
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
  }

  settle(): void {
    if (!this.isStreaming) return;
    this.isStreaming = false;
    this.messageCount += 1;
    this.emit({ type: 'agent_settled' });
    this.settlePrompt?.();
    this.settlePrompt = undefined;
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FixtureSessionFactory implements PiSessionFactory {
  readonly sessions: FixtureSession[] = [];

  async listModels(): Promise<ManagedAgentModelsResponse> {
    return { models: [], defaultModel: null };
  }

  async create(_options: CreatePiSessionOptions): Promise<ManagedPiSession> {
    const sessionId = `fixture-session-${this.sessions.length + 1}`;
    const sessionFile = join(sessionDirectory, `${sessionId}.jsonl`);
    writeFileSync(sessionFile, `${JSON.stringify({ sessionId })}\n`, { mode: 0o600 });
    const session = new FixtureSession(sessionId, sessionFile);
    this.sessions.push(session);
    return session;
  }

  async resume(options: ResumePiSessionOptions): Promise<ManagedPiSession> {
    const session = new FixtureSession(options.sessionId, options.sessionFile);
    this.sessions.push(session);
    return session;
  }
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const migration = createMigrationDatabase(databasePath);
await migrateToLatest(migration.db);
await migration.close();
const connection = createSupervisorDatabase(databasePath);
const factory = new FixtureSessionFactory();
const service = new ManagedAgentService({
  db: connection.db,
  sessionFactory: factory,
  defaultCwd: sessionDirectory,
  logger: { info() {}, warn() {}, error() {} },
  ...(mode === 'run' && targetPhase
    ? {
        lifecycleObserver: async (phase: SupervisorLifecyclePhase, runId?: string) => {
          if (phase !== targetPhase) return;
          if (phase === 'during_event_write' && !runId) return;
          send({ phase, runId });
          await new Promise<void>(() => undefined);
        },
      }
    : {}),
});

await service.start();

if (mode === 'inspect') {
  const { runs } = await service.listRuns({ limit: 100 });
  const eventSequences: Record<string, number[]> = {};
  for (const run of runs) {
    eventSequences[run.id] = (
      await service.listRunEvents(run.id, { afterSequence: 0, limit: 1_000 })
    ).map((event) => event.sequence);
  }
  send({
    runs,
    eventSequences,
    resumedSessions: factory.sessions.length,
  });
  await service.close();
  await connection.close();
  process.exit(0);
}

const agent = await service.createAgent({ name: 'Recovery fixture', systemPrompt: 'Fixture' });
const createRun = service.createRun({ agentId: agent.id, prompt: 'Do not replay this prompt.' });
const run = await createRun;
const session = factory.sessions[0];
if (!session) throw new Error('fixture_session_missing');

if (targetPhase === 'after_provider_completion') {
  session.settle();
} else if (targetPhase === 'during_graceful_shutdown') {
  void service.close();
} else {
  send({ phase: 'ready', runId: run.id });
}

await new Promise<void>(() => undefined);
