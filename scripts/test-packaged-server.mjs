import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const binary = resolve(
  root,
  process.platform === 'win32' ? 'dist/pideck-server.exe' : 'dist/pideck-server',
);
const directory = await mkdtemp(join(tmpdir(), 'pideck packaged server '));
const databasePath = join(directory, 'data with spaces', 'pideck.sqlite');
const sessionDirectory = join(directory, 'pi sessions');
const smokeNonce = randomBytes(24).toString('base64url');
const logs = [];
let child;

async function availablePort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a TCP port');
  await new Promise((resolveClose, reject) =>
    probe.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

async function waitForServer(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/v1/health`).catch(() => undefined);
    if (response?.status === 200) return;
    if (child?.exitCode !== null) {
      throw new Error(`Packaged server exited before readiness: ${child?.exitCode}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Timed out waiting for packaged server readiness');
}

async function waitForExit(timeoutMs = 15_000) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged server did not stop cleanly')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

try {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(binary, [], {
    cwd: directory,
    env: {
      ...process.env,
      HOME: directory,
      NEXTFLOW_DATABASE_PATH: databasePath,
      NEXTFLOW_PI_SESSION_DIR: sessionDirectory,
      NEXTFLOW_AGENT_CWD: directory,
      NEXTFLOW_SUPERVISOR_HOST: '127.0.0.1',
      NEXTFLOW_SUPERVISOR_PORT: String(port),
      NEXTFLOW_SUPERVISOR_TOKEN: '',
      PIDECK_SMOKE_NONCE: smokeNonce,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => logs.push(String(chunk).slice(0, 4096)));
  }
  await waitForServer(baseUrl);

  const shell = await fetch(`${baseUrl}/`);
  const clientRoute = await fetch(`${baseUrl}/sessions/smoke-run`);
  const loopbackApi = await fetch(`${baseUrl}/v1/agents`);
  const shellBody = await shell.text();

  if (shell.status !== 200 || !shellBody.includes('<title>piDeck</title>')) {
    throw new Error('Packaged server did not serve the embedded application shell');
  }
  if (clientRoute.status !== 200 || !(await clientRoute.text()).includes('<title>piDeck</title>')) {
    throw new Error('Packaged server did not provide SPA route fallback');
  }
  if (loopbackApi.status !== 200) {
    throw new Error('Packaged server did not allow unauthenticated loopback access');
  }

  const rejectedShutdown = await fetch(`${baseUrl}/v1/smoke/quit`, {
    method: 'POST',
    headers: { 'x-pideck-smoke-nonce': 'wrong-smoke-nonce-value' },
  });
  if (rejectedShutdown.status !== 403) {
    throw new Error('Packaged server smoke shutdown accepted the wrong nonce');
  }
  const shutdown = await fetch(`${baseUrl}/v1/smoke/quit`, {
    method: 'POST',
    headers: { 'x-pideck-smoke-nonce': smokeNonce },
  });
  if (shutdown.status !== 200) throw new Error('Packaged server rejected graceful shutdown');
  await waitForExit();
  if (child.exitCode !== 0) throw new Error(`Packaged server exited with ${child.exitCode}`);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const integrity = database.prepare('PRAGMA integrity_check').get();
  database.close();
  if (Object.values(integrity)[0] !== 'ok') {
    throw new Error('Packaged server database integrity check failed');
  }

  console.log(
    JSON.stringify({
      embeddedWebApp: true,
      authentication: 'loopback-only',
      databaseIntegrity: 'ok',
      gracefulShutdown: true,
    }),
  );
} catch (error) {
  console.error(
    logs
      .join('')
      .replace(/(authorization|token|prompt)[^\n]*/gi, '$1=[redacted]')
      .slice(-16_384),
  );
  throw error;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await rm(directory, { recursive: true, force: true });
}
