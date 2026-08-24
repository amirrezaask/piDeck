import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMigrationDatabase, migrateToLatest } from '@nextflow/database';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSupervisorApp } from '../src/app';
import { FakePiSessionFactory } from './fake-pi-session';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

async function createListeningApp(): Promise<{ baseUrl: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'nextflow-agent-sse-'));
  const filename = join(directory, 'test.sqlite');
  const migration = createMigrationDatabase(filename);
  await migrateToLatest(migration.db);
  await migration.close();
  const app = buildSupervisorApp({
    databasePath: filename,
    serviceToken: 'sse-secret',
    piSessionFactory: new FakePiSessionFactory(),
  });
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.server.address();
  if (!address || typeof address === 'string') throw new Error('Supervisor TCP address missing');
  cleanup.push(async () => {
    await app.server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('Supervisor agent SSE endpoint', () => {
  it('authenticates, replays after the requested sequence, and emits valid SSE frames', async () => {
    const { baseUrl } = await createListeningApp();
    const headers = {
      Authorization: 'Bearer sse-secret',
      'Content-Type': 'application/json',
    };
    const createdResponse = await fetch(`${baseUrl}/v1/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        systemPrompt: 'You are a stream test agent.',
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { id: string };
    const runResponse = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId: created.id, prompt: 'Start streaming.' }),
    });
    expect(runResponse.status).toBe(202);

    const unauthorized = await fetch(`${baseUrl}/v1/agents/${created.id}/stream`);
    expect(unauthorized.status).toBe(401);

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/v1/agents/${created.id}/stream?afterSequence=1`, {
      headers: { Authorization: 'Bearer sse-secret' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    if (!response.body) throw new Error('SSE response body missing');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    while (!body.includes('event: supervisor.prompt_accepted')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);

    expect(body).not.toContain('id: 1\n');
    expect(body).toMatch(/id: 2\nevent: [^\n]+\ndata: \{"agentId":/);
    expect(body).toContain('event: supervisor.prompt_accepted');
    for (const frame of body.split('\n\n').filter((item) => item.startsWith('id:'))) {
      const data = frame
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6);
      expect(() => JSON.parse(data ?? '')).not.toThrow();
    }
  });
});
