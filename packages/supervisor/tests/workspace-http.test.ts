import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildSupervisorApp } from '../app';

describe('workspace capability HTTP API', () => {
  it('exposes fleet, inbox state transitions, terminal lists, worktrees, and search', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pideck-workspace-http-'));
    const app = buildSupervisorApp({
      databasePath: join(directory, 'db.sqlite'),
      allowUnauthenticatedLoopback: true,
    });
    try {
      expect((await app.server.inject({ method: 'GET', url: '/v1/fleet' })).statusCode).toBe(200);
      expect((await app.server.inject({ method: 'GET', url: '/v1/worktrees' })).json()).toEqual({
        worktrees: [],
      });
      expect(
        (await app.server.inject({ method: 'GET', url: '/v1/terminal-sessions' })).json(),
      ).toEqual({ sessions: [] });
      const created = await app.server.inject({
        method: 'POST',
        url: '/v1/inbox',
        payload: { kind: 'question', title: 'Choose?', body: 'Select one', options: ['A', 'B'] },
      });
      expect(created.statusCode).toBe(201);
      const item = created.json();
      const resolved = await app.server.inject({
        method: 'POST',
        url: `/v1/inbox/${item.id}/resolve`,
        payload: { response: 'A' },
      });
      expect(resolved.json()).toMatchObject({ status: 'resolved', response: 'A' });
      expect(
        (await app.server.inject({ method: 'GET', url: '/v1/sessions/search?q=none' })).json(),
      ).toEqual({ results: [] });
    } finally {
      await app.server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
