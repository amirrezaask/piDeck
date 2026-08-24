import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMigrationDatabase, migrateToLatest } from '@nextflow/database';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSupervisorApp } from '../src/app';
import { FakePiSessionFactory } from './fake-pi-session';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

async function createListeningApp(): Promise<{ baseUrl: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'nextflow-agent-websocket-'));
  const filename = join(directory, 'test.sqlite');
  const migration = createMigrationDatabase(filename);
  await migrateToLatest(migration.db);
  await migration.close();
  const app = buildSupervisorApp({
    databasePath: filename,
    serviceToken: 'ws-secret',
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

function openSocket(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, headers ? { headers } : undefined);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      reject(new Error(`Unexpected WebSocket response: ${response.statusCode}`));
    });
  });
}

describe('Supervisor agent event WebSocket', () => {
  it('authenticates, replays after the requested sequence, and emits JSON frames', async () => {
    const { baseUrl } = await createListeningApp();
    const headers = {
      Authorization: 'Bearer ws-secret',
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
    const run = (await runResponse.json()) as { id: string };

    await expect(
      openSocket(`${baseUrl.replace('http:', 'ws:')}/v1/runs/${run.id}/stream`),
    ).rejects.toThrow();

    const events: Array<{ sequence: number; type: string }> = [];
    const socket = new WebSocket(
      `${baseUrl.replace('http:', 'ws:')}/v1/runs/${run.id}/stream?afterSequence=1`,
      { headers: { Authorization: 'Bearer ws-secret' } },
    );
    const opened = new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const promptAccepted = new Promise<void>((resolve, reject) => {
      socket.on('message', (value) => {
        try {
          const event = JSON.parse(value.toString()) as { sequence: number; type: string };
          events.push(event);
          if (event.type === 'supervisor.prompt_accepted') resolve();
        } catch (error) {
          reject(error);
        }
      });
      socket.once('error', reject);
    });
    await opened;
    await promptAccepted;
    socket.close();

    expect(events).not.toContainEqual(expect.objectContaining({ sequence: 1 }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'supervisor.prompt_accepted' }));
  });
});
