import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ManagedAgentResponse } from '@nextflow/contracts';
import { createMigrationDatabase, migrateToLatest } from '@nextflow/database';
import { describe, expect, it } from 'vitest';
import { buildSupervisorApp } from '../app';
import { FakePiSessionFactory } from './fake-pi-session';

async function withAgentApp<T>(
  callback: (context: {
    server: ReturnType<typeof buildSupervisorApp>['server'];
    factory: FakePiSessionFactory;
    directory: string;
  }) => Promise<T>,
  options: {
    serviceToken?: string;
    piSessionFactory?: FakePiSessionFactory;
    bodyLimitBytes?: number;
  } = {},
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
    ...(options.serviceToken ? {} : { allowUnauthenticatedLoopback: true }),
    piSessionFactory: factory,
  });
  try {
    return await callback({ server: app.server, factory, directory });
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
  it('returns a structured 413 when an attachment request exceeds the body limit', async () => {
    await withAgentApp(
      async ({ server }) => {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/runs',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ prompt: 'x'.repeat(2_000) }),
        });
        expect(response.statusCode).toBe(413);
        expect(response.json()).toEqual({
          error: {
            code: 'payload_too_large',
            message: 'The request body exceeds the 34 MB attachment limit',
          },
        });
      },
      { bodyLimitBytes: 1_024 },
    );
  });

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

  it('persists projects and exposes them for the composer', async () => {
    await withAgentApp(async ({ server }) => {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { path: '~' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        name: homedir().split('/').at(-1),
        path: homedir(),
      });

      const listed = await server.inject({ method: 'GET', url: '/v1/projects?limit=100' });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({
        projects: [expect.objectContaining({ path: homedir() })],
        nextCursor: null,
      });
    });
  });

  it('deletes a saved project without affecting its directory', async () => {
    await withAgentApp(async ({ server }) => {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { path: '~' },
      });
      const project = created.json<{ id: string }>();

      const deleted = await server.inject({
        method: 'DELETE',
        url: `/v1/projects/${project.id}`,
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({ id: project.id, path: homedir() });

      const listed = await server.inject({ method: 'GET', url: '/v1/projects?limit=100' });
      expect(listed.json()).toMatchObject({ projects: [] });
    });
  });

  it('rejects project paths that do not exist', async () => {
    await withAgentApp(async ({ server }) => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { path: '/definitely/missing/pideck-path' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'validation_failed' },
      });
    });
  });

  it('creates an inert definition and starts a run-owned session', async () => {
    await withAgentApp(async ({ server, factory, directory }) => {
      const createdResponse = await server.inject({
        method: 'POST',
        url: '/v1/agents',
        payload: { ...createPayload, cwd: directory },
      });
      const created = createdResponse.json<ManagedAgentResponse>();
      expect(createdResponse.statusCode).toBe(201);
      expect(created).toMatchObject({
        name: 'CI review agent',
        systemPrompt: 'You are a CI agent.',
        model: { provider: 'fake', id: 'fake-model' },
        cwd: directory,
      });
      expect(created).not.toHaveProperty('status');
      expect(factory.requests).toEqual([]);

      const runResponse = await server.inject({
        method: 'POST',
        url: '/v1/runs',
        payload: {
          agentId: created.id,
          prompt: 'Review the pipeline.',
          attachments: [
            {
              name: 'pipeline.png',
              mimeType: 'image/png',
              data: 'aW1hZ2U=',
            },
          ],
        },
      });
      expect(runResponse.statusCode).toBe(202);
      const run = runResponse.json<{ id: string; status: string }>();
      expect(run.status).toBe('running');
      expect(factory.requests).toHaveLength(1);

      const attachments = await server.inject({
        method: 'GET',
        url: `/v1/runs/${run.id}/attachments`,
      });
      expect(attachments.statusCode).toBe(200);
      expect(attachments.json()).toEqual({
        attachments: [
          {
            name: 'pipeline.png',
            mimeType: 'image/png',
            data: 'aW1hZ2U=',
          },
        ],
      });

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

  it('returns the raw PI journal with supervisor lifecycle events', async () => {
    await withAgentApp(async ({ server, factory, directory }) => {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/agents',
        payload: { ...createPayload, cwd: directory },
      });
      const agent = created.json<{ id: string }>();
      const started = await server.inject({
        method: 'POST',
        url: '/v1/runs',
        payload: { agentId: agent.id, prompt: 'Inspect this.' },
      });
      const runId = started.json<{ id: string }>().id;
      const session = factory.sessions[0];
      if (!session) throw new Error('Expected a fake PI session');
      writeFileSync(session.sessionFile, '{"type":"message","role":"user"}\n');

      const response = await server.inject({
        method: 'GET',
        url: `/v1/runs/${runId}/debug-log`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        runId,
        available: true,
        content: '{"type":"message","role":"user"}\n',
        truncated: false,
        supervisorEvents: expect.arrayContaining([
          expect.objectContaining({ type: 'supervisor.prompt_accepted' }),
        ]),
      });
      rmSync(session.sessionFile, { force: true });
    });
  });

  it('replays idempotent run and intervention acknowledgements without repeating work', async () => {
    await withAgentApp(async ({ server, factory, directory }) => {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/agents',
        payload: { ...createPayload, cwd: directory },
      });
      const agent = created.json<{ id: string }>();
      const body = { agentId: agent.id, prompt: 'Retry safely.', idempotencyKey: 'run-retry-1' };
      const first = await server.inject({ method: 'POST', url: '/v1/runs', payload: body });
      const duplicate = await server.inject({ method: 'POST', url: '/v1/runs', payload: body });
      expect(first.statusCode).toBe(202);
      expect(duplicate.statusCode).toBe(202);
      expect(duplicate.json()).toMatchObject({
        id: first.json<{ id: string }>().id,
        acknowledgementId: expect.any(String),
      });
      expect(factory.sessions).toHaveLength(1);
      const receipt = await server.inject({
        method: 'GET',
        url: '/v1/command-receipts/run-retry-1',
      });
      expect(receipt.statusCode).toBe(200);
      expect(receipt.json()).toMatchObject({
        idempotencyKey: 'run-retry-1',
        command: 'run_create',
        status: 'succeeded',
        result: { id: first.json<{ id: string }>().id },
      });

      const conflict = await server.inject({
        method: 'POST',
        url: '/v1/runs',
        payload: { ...body, prompt: 'Different request.' },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: 'idempotency_conflict' } });

      const runId = first.json<{ id: string }>().id;
      const steerBody = { message: 'Steer once.', idempotencyKey: 'steer-retry-1' };
      const steer = await server.inject({
        method: 'POST',
        url: `/v1/runs/${runId}/steer`,
        payload: steerBody,
      });
      const steerRetry = await server.inject({
        method: 'POST',
        url: `/v1/runs/${runId}/steer`,
        payload: steerBody,
      });
      expect(steer.statusCode).toBe(202);
      expect(steerRetry.statusCode).toBe(202);
      expect(factory.sessions[0]?.steering).toEqual(['Steer once.']);
    });
  });

  it('returns a failed run when session creation fails while retaining the definition', async () => {
    const factory = new FakePiSessionFactory({ createError: new Error('no model credentials') });
    await withAgentApp(
      async ({ server, directory }) => {
        const create = await server.inject({
          method: 'POST',
          url: '/v1/agents',
          payload: { ...createPayload, cwd: directory },
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
