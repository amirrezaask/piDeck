import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSupervisorApp } from '@pideck/supervisor';
import { afterEach, describe, expect, it } from 'vitest';

import { registerWebApp } from './web.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

async function createWebApp() {
  const directory = mkdtempSync(join(tmpdir(), 'pideck web server '));
  const webRoot = join(directory, 'web dist');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(
    join(webRoot, 'index.html'),
    '<!doctype html><html><head><title>piDeck fixture</title></head><body>app shell</body></html>',
  );
  writeFileSync(join(webRoot, 'assets', 'app.js'), 'globalThis.pideckFixture = true;');
  writeFileSync(join(directory, 'secret.txt'), 'must not be served');

  const app = buildSupervisorApp({
    databasePath: join(directory, 'pideck.sqlite'),
    allowUnauthenticatedLoopback: true,
  });
  registerWebApp(app.server, webRoot);
  await app.server.ready();
  cleanup.push(async () => {
    await app.server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return app.server;
}

describe('standalone web application serving', () => {
  it('serves the application shell and static assets with correct content types', async () => {
    const server = await createWebApp();

    const shell = await server.inject({ method: 'GET', url: '/' });
    const asset = await server.inject({ method: 'GET', url: '/assets/app.js?v=1' });

    expect(shell.statusCode).toBe(200);
    expect(shell.headers['content-type']).toContain('text/html');
    expect(shell.body).toContain('<title>piDeck fixture</title>');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.body).toBe('globalThis.pideckFixture = true;');
  });

  it('uses the application shell for client-side routes without shadowing API routes', async () => {
    const server = await createWebApp();

    const clientRoute = await server.inject({ method: 'GET', url: '/sessions/run-1' });
    const health = await server.inject({ method: 'GET', url: '/v1/health' });

    expect(clientRoute.statusCode).toBe(200);
    expect(clientRoute.headers['content-type']).toContain('text/html');
    expect(clientRoute.body).toContain('app shell');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', service: 'supervisor' });
  });

  it.each(['/..%2fsecret.txt', '/%2e%2e%2fsecret.txt'])(
    'rejects escaping asset path %s',
    async (url) => {
      const server = await createWebApp();
      const response = await server.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_path' });
      expect(response.body).not.toContain('must not be served');
    },
  );

  it('rejects malformed URL encoding before serving an asset', async () => {
    const server = await createWebApp();
    const response = await server.inject({ method: 'GET', url: '/%E0%A4%A' });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('must not be served');
  });
});
