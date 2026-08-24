import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ManagedAgentResponse } from '@nextflow/contracts';
import { createMigrationDatabase, migrateToLatest } from '@nextflow/database';
import { describe, expect, it } from 'vitest';
import { buildSupervisorApp } from '../src/app';
import { FakePiSessionFactory } from './fake-pi-session';

async function withAgentApp<T>(
  callback: (context: {
    server: ReturnType<typeof buildSupervisorApp>['server'];
    factory: FakePiSessionFactory;
  }) => Promise<T>,
  options: { serviceToken?: string; piSessionFactory?: FakePiSessionFactory } = {},
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'nextflow-agent-http-'));
  const filename = join(directory, 'test.sqlite');
  const migration = createMigrationDatabase(filename);
  await migrateToLatest(migration.db);
  await migration.close();
  const factory = options.piSessionFactory ?? new FakePiSessionFactory();
  const app = buildSupervisorApp({
    databasePath: filename,
    ...options,
    piSessionFactory: factory,
  });
  try {
    return await callback({ server: app.server, factory });
  } finally {
    await app.server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const createPayload = {
  name: 'CI review agent',
  systemPrompt: 'You are a CI agent.',
  cwd: '/tmp/project',
  tools: ['read', 'bash'] as const,
  model: { provider: 'fake', id: 'fake-model' },
  thinkingLevel: 'high' as const,
};

describe('Supervisor managed-agent HTTP API', () => {
  it('protects definition and run resources with the service credential', async () => {
    await withAgentApp(
      async ({ server }) => {
        expect((await server.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(200);
        expect((await server.inject({ method: 'GET', url: '/v1/agents' })).statusCode).toBe(401);
        expect(
          (
            await server.inject({
              method: 'GET',
              url: '/v1/agents',
              headers: { authorization: 'Bearer service-secret' },
            })
          ).statusCode,
        ).toBe(200);
      },
      { serviceToken: 'service-secret' },
    );
  });

  it('creates an inert definition and starts a run-owned session', async () => {
    await withAgentApp(async ({ server, factory }) => {
      const createdResponse = await server.inject({
        method: 'POST',
        url: '/v1/agents',
        payload: createPayload,
      });
      const created = createdResponse.json<ManagedAgentResponse>();
      expect(createdResponse.statusCode).toBe(201);
      expect(created).toMatchObject({
        name: 'CI review agent',
        systemPrompt: 'You are a CI agent.',
        model: { provider: 'fake', id: 'fake-model' },
        cwd: '/tmp/project',
      });
      expect(created).not.toHaveProperty('status');
      expect(factory.requests).toEqual([]);

      const runResponse = await server.inject({
        method: 'POST',
        url: '/v1/runs',
        payload: { agentId: created.id, prompt: 'Review the pipeline.' },
      });
      expect(runResponse.statusCode).toBe(202);
      const run = runResponse.json<{ id: string; status: string }>();
      expect(run.status).toBe('running');
      expect(factory.requests).toHaveLength(1);

      const runEvents = await server.inject({
        method: 'GET',
        url: `/v1/runs/${run.id}/events`,
      });
      expect(runEvents.statusCode).toBe(200);
      expect(runEvents.json<{ events: Array<{ runId: string | null }> }>().events).toEqual(
        expect.arrayContaining([expect.objectContaining({ runId: run.id })]),
      );

      const steer = await server.inject({
        method: 'POST',
        url: `/v1/runs/${run.id}/steer`,
        payload: { message: 'Prioritize failed jobs.' },
      });
      const followUp = await server.inject({
        method: 'POST',
        url: `/v1/runs/${run.id}/follow-up`,
        payload: { message: 'Then summarize.' },
      });
      expect(steer.statusCode).toBe(202);
      expect(followUp.statusCode).toBe(202);
      expect(factory.sessions[0]?.steering).toEqual(['Prioritize failed jobs.']);
      expect(factory.sessions[0]?.followUps).toEqual(['Then summarize.']);

      const cancel = await server.inject({ method: 'POST', url: `/v1/runs/${run.id}/cancel` });
      expect(cancel.statusCode).toBe(200);
      expect(cancel.json<{ status: string }>().status).toBe('cancelled');
      expect(
        (await server.inject({ method: 'GET', url: `/v1/agents/${created.id}` })).json(),
      ).not.toHaveProperty('status');
    });
  });

  it('returns a failed run when session creation fails while retaining the definition', async () => {
    const factory = new FakePiSessionFactory({ createError: new Error('no model credentials') });
    await withAgentApp(
      async ({ server }) => {
        const create = await server.inject({
          method: 'POST',
          url: '/v1/agents',
          payload: createPayload,
        });
        const agent = create.json<ManagedAgentResponse>();
        const run = await server.inject({
          method: 'POST',
          url: '/v1/runs',
          payload: { agentId: agent.id, prompt: 'Retry.' },
        });
        expect(create.statusCode).toBe(201);
        expect(run.statusCode).toBe(202);
        expect(run.json()).toMatchObject({
          status: 'failed',
          error: { code: 'agent_start_failed' },
        });
        expect(
          (await server.inject({ method: 'GET', url: `/v1/agents/${agent.id}` })).json(),
        ).not.toHaveProperty('status');
      },
      { piSessionFactory: factory },
    );
  });
});
