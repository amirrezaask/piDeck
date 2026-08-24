import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createMigrationDatabase,
  createSupervisorDatabase,
  migrateToLatest,
} from '@nextflow/database';
import { describe, expect, it } from 'vitest';

import { ManagedAgentBusyError, ManagedAgentService } from '../src/agent-service';
import { FakePiSessionFactory } from './fake-pi-session';

async function createService(options: { preflightAccepted?: boolean; createError?: Error } = {}) {
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
  });
  await service.start();
  return {
    service,
    factory,
    connection,
    directory,
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
