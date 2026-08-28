import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createId,
  createMigrationDatabase,
  createSupervisorDatabase,
  migrateToLatest,
  nowIso,
} from '@nextflow/database';
import { describe, expect, it } from 'vitest';

import {
  ManagedAgentBusyError,
  ManagedAgentCommandOutcomeUnknownError,
  ManagedAgentService,
  type SupervisorLifecyclePhase,
} from '../agent-service';
import { Deferred, FakePiSessionFactory } from './fake-pi-session';

async function createService(
  options: {
    preflightAccepted?: boolean;
    createError?: Error;
    createDeferred?: Deferred<void>;
    abortMode?: 'resolve' | 'reject' | 'hang';
    shutdownTimeoutMs?: number;
    eventQueueLimits?: { maxCount: number; maxBytes: number };
    eventPayloadLimits?: { maxBytes: number; maxDepth?: number; maxItems?: number };
    writeFaultInjector?: (writeClass: 'admission' | 'event' | 'terminal') => void | Promise<void>;
    lifecycleObserver?: (phase: SupervisorLifecyclePhase, runId?: string) => void | Promise<void>;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'nextflow-managed-agent-'));
  const filename = join(directory, 'test.sqlite');
  const migration = createMigrationDatabase(filename);
  await migrateToLatest(migration.db);
  await migration.close();
  const connection = createSupervisorDatabase(filename);
  const factory = new FakePiSessionFactory(options);
  const service = new ManagedAgentService({
    db: connection.db,
    sessionFactory: factory,
    defaultCwd: directory,
    ...(options.shutdownTimeoutMs === undefined
      ? {}
      : {
          shutdownTimeoutMs: options.shutdownTimeoutMs,
          operationTimeoutMs: options.shutdownTimeoutMs,
        }),
    ...(options.eventQueueLimits ? { eventQueueLimits: options.eventQueueLimits } : {}),
    ...(options.eventPayloadLimits ? { eventPayloadLimits: options.eventPayloadLimits } : {}),
    ...(options.writeFaultInjector ? { writeFaultInjector: options.writeFaultInjector } : {}),
    ...(options.lifecycleObserver ? { lifecycleObserver: options.lifecycleObserver } : {}),
  });
  await service.start();
  return {
    service,
    factory,
    connection,
    directory,
    filename,
    async close() {
      await service.close();
      await connection.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function waitForEvent(service: ManagedAgentService, agentId: string, eventType: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const events = await service.listEvents(agentId, { afterSequence: 0 });
    if (events.some((event) => event.type === eventType)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`event ${eventType} was not persisted`);
}

describe('ManagedAgentService', () => {
  it('binds worktree runs to the canonical worktree and holds it busy until completion', async () => {
    const context = await createService();
    try {
      const now = nowIso();
      const projectId = createId();
      const worktreeId = createId();
      const worktreePath = join(context.directory, 'worktree');
      mkdirSync(worktreePath);
      await context.connection.db
        .insertInto('supervisor_projects')
        .values({
          id: projectId,
          name: 'Project',
          path: context.directory,
          created_at: now,
          updated_at: now,
          last_used_at: now,
        })
        .execute();
      await context.connection.db
        .insertInto('supervisor_worktrees')
        .values({
          id: worktreeId,
          project_id: projectId,
          path: worktreePath,
          branch: 'pideck/test',
          base_ref: 'HEAD',
          status: 'ready',
          error: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      const agent = await context.service.createAgent({ systemPrompt: 'Use the worktree.' });
      await expect(
        context.service.createRun({
          agentId: agent.id,
          prompt: 'Wrong directory',
          executionMode: 'worktree',
          worktreeId,
          cwd: context.directory,
        }),
      ).rejects.toThrow('does not match');

      const run = await context.service.createRun({
        agentId: agent.id,
        prompt: 'Edit safely',
        executionMode: 'worktree',
        worktreeId,
        cwd: worktreePath,
      });
      expect(context.factory.requests[0]?.cwd).toBe(realpathSync(worktreePath));
      expect(run.cwd).toBe(realpathSync(worktreePath));
      expect(
        await context.connection.db
          .selectFrom('supervisor_worktrees')
          .select('status')
          .where('id', '=', worktreeId)
          .executeTakeFirst(),
      ).toEqual({ status: 'busy' });

      context.factory.sessions[0]?.settle();
      await waitForEvent(context.service, agent.id, 'supervisor.run_completed');
      expect(
        await context.connection.db
          .selectFrom('supervisor_worktrees')
          .select('status')
          .where('id', '=', worktreeId)
          .executeTakeFirst(),
      ).toEqual({ status: 'ready' });
    } finally {
      await context.close();
    }
  });

  it('projects the latest event sequence into run summaries', async () => {
    const context = await createService();
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Track activity.' });
      const run = await context.service.createRun({ agentId: agent.id, prompt: 'Inspect this.' });
      const latest = await context.connection.db
        .selectFrom('supervisor_agent_events')
        .select((expression) => expression.fn.max<number>('sequence').as('sequence'))
        .where('agent_id', '=', agent.id)
        .executeTakeFirstOrThrow();
      const sequence = (latest.sequence ?? 0) + 1;
      await context.connection.db
        .insertInto('supervisor_agent_events')
        .values({
          agent_id: agent.id,
          run_id: run.id,
          sequence,
          event_type: 'test.activity',
          payload_json: '{}',
          created_at: nowIso(),
        })
        .execute();

      const listed = await context.service.listRuns({ agentId: agent.id, limit: 10 });
      expect(listed.runs[0]).toMatchObject({ id: run.id, latestEventSequence: sequence });
    } finally {
      await context.close();
    }
  });

  it('rejects an admission write fault before starting paid work', async () => {
    let failAdmission = false;
    const context = await createService({
      writeFaultInjector(writeClass) {
        if (failAdmission && writeClass === 'admission') throw new Error('injected_enospc');
      },
    });
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Be concise.' });
      failAdmission = true;
      await expect(
        context.service.createRun({ agentId: agent.id, prompt: 'Must not start.' }),
      ).rejects.toThrow('injected_enospc');
      expect(context.factory.sessions).toHaveLength(0);
      expect(await context.service.listRuns({ agentId: agent.id, limit: 10 })).toMatchObject({
        runs: [],
      });
    } finally {
      await context.close();
    }
  });

  it('fails closed when an ordinary event write fails', async () => {
    let failNextEvent = false;
    const context = await createService({
      writeFaultInjector(writeClass) {
        if (failNextEvent && writeClass === 'event') {
          failNextEvent = false;
          throw new Error('injected_eio');
        }
      },
    });
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Be concise.' });
      const run = await context.service.createRun({ agentId: agent.id, prompt: 'Start.' });
      const session = context.factory.sessions[0];
      if (!session) throw new Error('Fake session was not created');
      failNextEvent = true;
      session.emitExternal({ type: 'message_update', delta: 'must not be acknowledged' });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await context.service.getRun(run.id))?.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(await context.service.getRun(run.id)).toMatchObject({
        status: 'failed',
        error: { code: 'event_persistence_failed' },
      });
      expect(session.abortCount).toBe(1);
    } finally {
      await context.close();
    }
  });

  it('does not publish a terminal state when its atomic write fails', async () => {
    let failTerminal = false;
    const context = await createService({
      writeFaultInjector(writeClass) {
        if (failTerminal && writeClass === 'terminal') {
          failTerminal = false;
          throw new Error('injected_terminal_eio');
        }
      },
    });
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Be concise.' });
      const run = await context.service.createRun({ agentId: agent.id, prompt: 'Start.' });
      const session = context.factory.sessions[0];
      if (!session) throw new Error('Fake session was not created');
      failTerminal = true;
      session.settle();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(await context.service.getRun(run.id)).toMatchObject({
        status: 'running',
        error: null,
      });
      expect(session.disposeCount).toBe(1);
      await expect(context.service.cancelRun(run.id)).rejects.toBeInstanceOf(
        ManagedAgentCommandOutcomeUnknownError,
      );
      expect(
        (await context.service.listRunEvents(run.id, { afterSequence: 0 })).some(
          (event) => event.type === 'supervisor.run_completed',
        ),
      ).toBe(false);
    } finally {
      await context.close();
    }
  });

  it('always disposes admission compensation and marks an unknown receipt when terminal persistence fails', async () => {
    let failTerminal = true;
    const context = await createService({
      lifecycleObserver(phase) {
        if (phase === 'after_running_commit') throw new Error('injected_admission_transition');
      },
      writeFaultInjector(writeClass) {
        if (failTerminal && writeClass === 'terminal') {
          failTerminal = false;
          throw new Error('injected_terminal_eio');
        }
      },
    });
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Be concise.' });
      await expect(
        context.service.createRun({
          agentId: agent.id,
          prompt: 'Must not remain active.',
          idempotencyKey: 'admission-terminal-failure',
        }),
      ).rejects.toBeInstanceOf(ManagedAgentCommandOutcomeUnknownError);
      const session = context.factory.sessions[0];
      if (!session) throw new Error('Fake session was not created');
      expect(session.disposeCount).toBe(1);
      expect(await context.service.getCommandReceipt('admission-terminal-failure')).toMatchObject({
        status: 'indeterminate',
        error: { code: 'command_outcome_unknown' },
      });
      await expect(
        context.service.cancelRun(
          (await context.service.listRuns({ agentId: agent.id, limit: 10 })).runs[0]!.id,
        ),
      ).rejects.toBeInstanceOf(ManagedAgentCommandOutcomeUnknownError);
    } finally {
      await context.close();
    }
  });

  it('fails closed when the bounded event ingestion queue overflows', async () => {
    const context = await createService({
      eventQueueLimits: { maxCount: 3, maxBytes: 1_000_000 },
    });
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Be concise.' });
      const run = await context.service.createRun({ agentId: agent.id, prompt: 'Start.' });
      const session = context.factory.sessions[0];
      if (!session) throw new Error('Fake session was not created');

      for (let index = 0; index < 50; index += 1) {
        session.emitExternal({ type: 'message_update', index });
      }
      await waitForEvent(context.service, agent.id, 'supervisor.event_backpressure_exceeded');

      expect(await context.service.getRun(run.id)).toMatchObject({
        status: 'failed',
        error: { code: 'event_backpressure_exceeded' },
      });
      expect(session.abortCount).toBe(1);
    } finally {
      await context.close();
    }
  });

  it('bounds aggregate normalized payload bytes before persistence', async () => {
    const context = await createService({ eventPayloadLimits: { maxBytes: 1_024 } });
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Be concise.' });
      const run = await context.service.createRun({ agentId: agent.id, prompt: 'Start.' });
      const session = context.factory.sessions[0];
      if (!session) throw new Error('Fake session was not created');
      session.emitExternal({
        type: 'oversize',
        chunks: Array.from({ length: 50 }, () => 'x'.repeat(200)),
      });
      await waitForEvent(context.service, agent.id, 'supervisor.event_truncated');
      const events = await context.service.listRunEvents(run.id, { afterSequence: 0 });
      const truncated = events.find((item) => item.type === 'supervisor.event_truncated');
      expect(Buffer.byteLength(JSON.stringify(truncated?.payload), 'utf8')).toBeLessThan(1_024);
      expect(truncated?.payload).toMatchObject({ reason: 'payload_bytes', maxBytes: 1_024 });
    } finally {
      await context.close();
    }
  });
  it('persists an inert definition without creating a Pi session', async () => {
    const context = await createService();
    try {
      const agent = await context.service.createAgent({
        name: 'Release reviewer',
        systemPrompt: 'Be concise.',
        model: { provider: 'fake', id: 'fake-model' },
      });
      expect(context.factory.requests).toEqual([]);
      expect(agent).toMatchObject({
        name: 'Release reviewer',
        systemPrompt: 'Be concise.',
        model: { provider: 'fake', id: 'fake-model' },
      });
      expect(agent).not.toHaveProperty('status');
      expect(agent).not.toHaveProperty('sessionId');
    } finally {
      await context.close();
    }
  });

  it('normalizes home-relative paths before creating a session', async () => {
    const context = await createService();
    try {
      const agent = await context.service.createAgent({
        systemPrompt: 'You are a project agent.',
        cwd: '~',
      });
      const run = await context.service.createRun({
        agentId: agent.id,
        prompt: 'Inspect the project.',
      });

      expect(run.cwd).toBe(homedir());
      expect(context.factory.requests[0]?.cwd).toBe(homedir());
    } finally {
      await context.close();
    }
  });

  it('adds the run working directory to the reusable project list', async () => {
    const context = await createService();
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'You are a project agent.' });
      await context.service.createRun({
        agentId: agent.id,
        prompt: 'Inspect the project.',
        cwd: context.directory,
      });

      const projects = await context.connection.db
        .selectFrom('supervisor_projects')
        .select(['name', 'path'])
        .execute();
      expect(projects).toEqual([
        expect.objectContaining({
          name: context.directory.split('/').at(-1),
          path: context.directory,
        }),
      ]);
    } finally {
      await context.close();
    }
  });

  it('passes bounded image attachments to the Pi adapter', async () => {
    const context = await createService();
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Inspect images.' });
      await context.service.createRun({
        agentId: agent.id,
        prompt: 'Inspect this screenshot.',
        attachments: [{ name: 'screen.png', mimeType: 'image/png', data: 'aW1hZ2U=' }],
      });
      expect(context.factory.sessions[0]?.promptImages).toEqual([
        [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }],
      ]);
    } finally {
      await context.close();
    }
  });

  it('persists image attachments across service restarts', async () => {
    const context = await createService();
    const attachment = {
      name: 'screen.png',
      mimeType: 'image/png' as const,
      data: 'aW1hZ2U=',
    };
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Inspect images.' });
      const run = await context.service.createRun({
        agentId: agent.id,
        prompt: 'Inspect this screenshot.',
        attachments: [attachment],
      });
      const session = context.factory.sessions[0];
      if (!session) throw new Error('Fake session was not created');
      session.settle();
      await waitForEvent(context.service, agent.id, 'agent_settled');

      expect(await context.service.listRunAttachments(run.id)).toEqual({
        attachments: [attachment],
      });

      await context.service.close();
      await context.connection.close();

      const restartedConnection = createSupervisorDatabase(context.filename);
      const restartedService = new ManagedAgentService({
        db: restartedConnection.db,
        sessionFactory: new FakePiSessionFactory(),
        defaultCwd: context.directory,
      });
      await restartedService.start();
      try {
        expect(await restartedService.listRunAttachments(run.id)).toEqual({
          attachments: [attachment],
        });
      } finally {
        await restartedService.close();
        await restartedConnection.close();
      }
    } finally {
      rmSync(context.directory, { recursive: true, force: true });
    }
  });

  it('creates a session per run and associates persisted events with that run', async () => {
    const context = await createService();
    try {
      const agent = await context.service.createAgent({
        systemPrompt: 'You are a release engineer.',
        tools: ['read', 'bash'],
        thinkingLevel: 'high',
      });
      const run = await context.service.createRun({
        agentId: agent.id,
        prompt: 'Inspect this release.',
        model: { provider: 'fake', id: 'run-model' },
        thinkingLevel: 'medium',
        cwd: context.directory,
      });
      await waitForEvent(context.service, agent.id, 'message_update');

      expect(run).toMatchObject({
        agentId: agent.id,
        prompt: 'Inspect this release.',
        status: 'running',
        model: { provider: 'fake', id: 'run-model' },
        thinkingLevel: 'medium',
        cwd: context.directory,
      });
      expect(context.factory.requests).toEqual([
        expect.objectContaining({
          systemPrompt: 'You are a release engineer.',
          tools: ['read', 'bash'],
          model: { provider: 'fake', id: 'run-model' },
          thinkingLevel: 'medium',
          cwd: context.directory,
        }),
      ]);
      expect(context.factory.sessions[0]?.prompts).toEqual(['Inspect this release.']);
      const events = await context.service.listRunEvents(run.id, { afterSequence: 0 });
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.runId === run.id)).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('applies updated prompt and tool-call settings to new runs', async () => {
    const context = await createService();
    try {
      const agent = await context.service.createAgent({
        systemPrompt: 'Answer only from the supplied prompt.',
      });
      const updated = await context.service.renameAgent(agent.id, {
        systemPromptMode: 'replace',
        tools: [],
      });
      expect(updated).toMatchObject({
        systemPromptMode: 'replace',
        tools: [],
      });

      await context.service.createRun({ agentId: updated.id, prompt: 'Start.' });
      expect(context.factory.requests).toContainEqual(
        expect.objectContaining({
          systemPrompt: 'Answer only from the supplied prompt.',
          systemPromptMode: 'replace',
          tools: [],
        }),
      );
    } finally {
      await context.close();
    }
  });

  it('keeps a completed session available for follow-up chat', async () => {
    const context = await createService();
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Be concise.' });
      const run = await context.service.createRun({ agentId: agent.id, prompt: 'Start.' });
      const session = context.factory.sessions[0];
      if (!session) throw new Error('Fake session was not created');

      session.settle();
      await waitForEvent(context.service, agent.id, 'agent_settled');
      expect((await context.service.getRun(run.id))?.status).toBe('completed');

      const followUp = await context.service.followUpRun(run.id, { message: 'Continue.' });
      expect(followUp.status).toBe('running');
      expect(session.prompts).toEqual(['Start.', 'Continue.']);
      session.settle();
      await waitForEvent(context.service, agent.id, 'agent_settled');
      expect((await context.service.getRun(run.id))?.status).toBe('completed');

      const nextRun = await context.service.createRun({
        agentId: agent.id,
        prompt: 'Start another.',
      });
      expect(nextRun.status).toBe('running');
    } finally {
      await context.close();
    }
  });

  it('recovers a completed Pi session without replaying its prompt', async () => {
    const context = await createService();
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Remember context.' });
      const run = await context.service.createRun({ agentId: agent.id, prompt: 'Remember this.' });
      context.factory.sessions[0]?.settle();
      await waitForEvent(context.service, agent.id, 'supervisor.run_completed');
      await context.service.close();
      await context.connection.close();

      const connection = createSupervisorDatabase(context.filename);
      const factory = new FakePiSessionFactory();
      const service = new ManagedAgentService({
        db: connection.db,
        sessionFactory: factory,
        defaultCwd: context.directory,
      });
      await service.start();
      try {
        expect(factory.resumeRequests).toEqual([
          expect.objectContaining({
            sessionId: 'fake-pi-session-1',
            sessionFile: '/tmp/fake-pi-session-1.jsonl',
            cwd: context.directory,
          }),
        ]);
        expect(factory.sessions[0]?.prompts).toEqual([]);
        await service.followUpRun(run.id, { message: 'What did I say?' });
        expect(factory.sessions[0]?.prompts).toEqual(['What did I say?']);
      } finally {
        await service.close();
        await connection.close();
      }
    } finally {
      rmSync(context.directory, { recursive: true, force: true });
    }
  });

  it('keeps a failed run on the definition when session creation fails', async () => {
    const context = await createService({ createError: new Error('credential missing') });
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Be concise.' });
      const run = await context.service.createRun({ agentId: agent.id, prompt: 'Start.' });
      expect(run).toMatchObject({ status: 'failed', error: { code: 'agent_start_failed' } });
      expect(await context.service.getAgent(agent.id)).toEqual(agent);
      expect(context.factory.requests).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it('records prompt preflight rejection on the run only', async () => {
    const context = await createService({ preflightAccepted: false });
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Be concise.' });
      const run = await context.service.createRun({ agentId: agent.id, prompt: 'Start.' });
      expect(run).toMatchObject({ status: 'failed', error: { code: 'prompt_rejected' } });
      expect(await context.service.getAgent(agent.id)).not.toHaveProperty('status');
    } finally {
      await context.close();
    }
  });

  it('admits exactly one run when createRun calls race', async () => {
    const creation = new Deferred<void>();
    const context = await createService({ createDeferred: creation });
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Be concise.' });
      const first = context.service.createRun({ agentId: agent.id, prompt: 'First.' });
      await Promise.resolve();
      const second = context.service.createRun({ agentId: agent.id, prompt: 'Second.' });
      creation.resolve();
      const results = await Promise.allSettled([first, second]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: expect.any(ManagedAgentBusyError),
      });
      expect(context.factory.sessions).toHaveLength(1);
      const activeRuns = await context.connection.db
        .selectFrom('supervisor_agent_runs')
        .select(['id', 'status'])
        .where('agent_id', '=', agent.id)
        .where('status', 'in', ['queued', 'running'])
        .execute();
      expect(activeRuns).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it('keeps cancellation authoritative when the SDK abort rejects', async () => {
    const context = await createService({ abortMode: 'reject', shutdownTimeoutMs: 10 });
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Be concise.' });
      const run = await context.service.createRun({ agentId: agent.id, prompt: 'Start.' });
      const cancelled = await context.service.cancelRun(run.id);
      expect(cancelled.status).toBe('cancelled');
      const events = await context.service.listRunEvents(run.id, { afterSequence: 0 });
      expect(events.map((event) => event.type)).toContain('supervisor.run_cancelled');
      expect(events.map((event) => event.type)).not.toContain('supervisor.run_failed');
    } finally {
      await context.close();
    }
  });

  it('bounds shutdown with a hanging SDK abort and disposes once', async () => {
    const context = await createService({ abortMode: 'hang', shutdownTimeoutMs: 10 });
    const agent = await context.service.createAgent({ systemPrompt: 'Be concise.' });
    await context.service.createRun({ agentId: agent.id, prompt: 'Start.' });
    const session = context.factory.sessions[0];
    if (!session) throw new Error('Fake session was not created');
    await context.service.close();
    await context.service.close();
    expect(session.abortCount).toBe(1);
    expect(session.disposeCount).toBe(1);
    expect(session.unsubscribeCount).toBe(1);
    await context.connection.close();
    rmSync(context.directory, { recursive: true, force: true });
  });

  it('soft deletes a profile while retaining and terminalizing its run history', async () => {
    const context = await createService();
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Be concise.' });
      const run = await context.service.createRun({ agentId: agent.id, prompt: 'Keep history.' });
      const deleted = await context.service.deleteAgent(agent.id);
      expect(deleted.id).toBe(agent.id);
      expect(await context.service.getAgent(agent.id)).toBeNull();
      expect(await context.service.getRun(run.id)).toMatchObject({
        status: 'cancelled',
        error: { code: 'agent_deleted' },
      });
      expect(await context.service.listRunEvents(run.id, { afterSequence: 0 })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'supervisor.run_cancelled', runId: run.id }),
        ]),
      );
    } finally {
      await context.close();
    }
  });

  it('keeps run status as the concurrency boundary', async () => {
    const context = await createService();
    try {
      const agent = await context.service.createAgent({ systemPrompt: 'Be concise.' });
      await context.service.createRun({ agentId: agent.id, prompt: 'Start.' });
      await expect(
        context.service.createRun({ agentId: agent.id, prompt: 'Second.' }),
      ).rejects.toBeInstanceOf(ManagedAgentBusyError);
    } finally {
      await context.close();
    }
  });

  it('paginates definitions without skipping equal timestamps', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nextflow-managed-agent-pagination-'));
    const filename = join(directory, 'test.sqlite');
    const migration = createMigrationDatabase(filename);
    await migrateToLatest(migration.db);
    await migration.close();
    const connection = createSupervisorDatabase(filename);
    const ids = ['018bcfe4-7a4b-7000-8000-000000000001', '018bcfe4-7a4b-7000-8000-000000000002'];
    const service = new ManagedAgentService({
      db: connection.db,
      sessionFactory: new FakePiSessionFactory(),
      defaultCwd: directory,
      now: () => '2026-08-23T20:00:00.000Z',
      idFactory: () => ids.shift() ?? '018bcfe4-7a4b-7000-8000-000000000003',
    });
    try {
      await service.start();
      await service.createAgent({ systemPrompt: 'One.' });
      await service.createAgent({ systemPrompt: 'Two.' });
      const first = await service.listAgents({ limit: 1 });
      const second = await service.listAgents({ limit: 1, cursor: first.nextCursor ?? '' });
      expect(first.agents.map((agent) => agent.id)).toEqual([
        '018bcfe4-7a4b-7000-8000-000000000002',
      ]);
      expect(second.agents.map((agent) => agent.id)).toEqual([
        '018bcfe4-7a4b-7000-8000-000000000001',
      ]);
    } finally {
      await service.close();
      await connection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
