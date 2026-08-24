import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMigrationDatabase, migrateToLatest } from '@nextflow/database';
import { describe, expect, it } from 'vitest';

import { buildSupervisorApp } from '../src/app';
import type { PiSessionFactory } from '../src/pi-session';
import { FakePiSessionFactory } from './fake-pi-session';

async function withApp<T>(
  callback: (app: ReturnType<typeof buildSupervisorApp>['server']) => Promise<T>,
  options: { serviceToken?: string; piSessionFactory?: PiSessionFactory } = {},
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'nextflow-supervisor-http-'));
  const filename = join(directory, 'test.sqlite');
  const migration = createMigrationDatabase(filename);
  await migrateToLatest(migration.db);
  await migration.close();
  const app = buildSupervisorApp({ databasePath: filename, ...options });
  try {
    return await callback(app.server);
  } finally {
    await app.server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function waitForStatus(
  app: ReturnType<typeof buildSupervisorApp>['server'],
  id: string,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/v1/executions/${id}` });
    const execution = response.json<{ status: string }>();
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(execution.status)) {
      return execution.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('execution did not finish');
}

describe('Supervisor HTTP API', () => {
  it('requires the configured service credential outside health checks', async () => {
    await withApp(
      async (app) => {
        const health = await app.inject({ method: 'GET', url: '/v1/health' });
        const unauthorized = await app.inject({ method: 'GET', url: '/v1/executions' });
        const authorized = await app.inject({
          method: 'GET',
          url: '/v1/executions',
          headers: { authorization: 'Bearer service-secret' },
        });

        expect(health.statusCode).toBe(200);
        expect(unauthorized.statusCode).toBe(401);
        expect(authorized.statusCode).toBe(200);
      },
      { serviceToken: 'service-secret' },
    );
  });

  it('creates and manages Pi agents through asynchronous HTTP commands', async () => {
    const factory = new FakePiSessionFactory();
    await withApp(
      async (app) => {
        const created = await app.inject({
          method: 'POST',
          url: '/v1/agents',
          payload: {
            systemPrompt: 'You are a CI agent.',
          },
        });
        const agent = created.json<{ id: string }>();
        const run = await app.inject({
          method: 'POST',
          url: '/v1/runs',
          payload: { agentId: agent.id, prompt: 'Review the pipeline.' },
        });
        const busy = await app.inject({
          method: 'POST',
          url: '/v1/runs',
          payload: { agentId: agent.id, prompt: 'Run another task.' },
        });
        const runId = run.json<{ id: string }>().id;
        const steer = await app.inject({
          method: 'POST',
          url: `/v1/runs/${runId}/steer`,
          payload: { message: 'Prioritize failing jobs.' },
        });
        const aborted = await app.inject({
          method: 'POST',
          url: `/v1/runs/${runId}/cancel`,
        });
        const events = await app.inject({
          method: 'GET',
          url: `/v1/agents/${agent.id}/events?afterSequence=0`,
        });

        expect(created.statusCode).toBe(201);
        expect(run.statusCode).toBe(202);
        expect(busy.statusCode).toBe(409);
        expect(busy.json<{ error: { code: string } }>().error.code).toBe('agent_busy');
        expect(steer.statusCode).toBe(202);
        expect(aborted.json<{ status: string }>().status).toBe('cancelled');
        expect(
          events.json<{ events: Array<{ type: string }> }>().events.map((event) => event.type),
        ).toEqual(expect.arrayContaining(['supervisor.agent_created', 'agent_start']));
      },
      { piSessionFactory: factory },
    );
  });

  it('executes mock agents and deduplicates idempotent requests', async () => {
    await withApp(async (app) => {
      const body = {
        idempotencyKey: 'http-run:step:1',
        agentType: 'echo',
        input: { message: 'hello' },
        config: {},
        timeoutMs: 1000,
      };
      const first = await app.inject({ method: 'POST', url: '/v1/executions', payload: body });
      const duplicate = await app.inject({ method: 'POST', url: '/v1/executions', payload: body });
      const firstExecution = first.json<{ id: string }>();
      const duplicateExecution = duplicate.json<{ id: string }>();
      const status = await waitForStatus(app, firstExecution.id);
      const events = await app.inject({
        method: 'GET',
        url: `/v1/executions/${firstExecution.id}/events`,
      });

      expect(first.statusCode).toBe(201);
      expect(duplicate.statusCode).toBe(200);
      expect(duplicateExecution.id).toBe(firstExecution.id);
      expect(status).toBe('succeeded');
      expect(events.json<{ events: unknown[] }>().events).toHaveLength(3);
    });
  });
});
