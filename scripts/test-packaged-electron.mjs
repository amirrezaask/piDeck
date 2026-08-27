import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findElectronArtifacts, selectHostBinary } from './lib/electron-artifacts.mjs';

const root = resolve(import.meta.dirname, '..');
const userData = await mkdtemp(join(tmpdir(), 'pideck packaged smoke '));
const nonce = randomBytes(24).toString('base64url');
const logs = [];
const children = new Set();

async function waitFor(condition, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await Promise.resolve()
      .then(condition)
      .catch(() => undefined);
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function launch(binary) {
  const markerPath = join(userData, 'pideck-smoke-ready.json');
  await rm(markerPath, { force: true });
  const child = spawn(binary, [`--user-data-dir=${userData}`], {
    env: { ...process.env, PIDECK_SMOKE_NONCE: nonce, HOME: userData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => logs.push(String(chunk).slice(0, 4096)));
  const marker = await waitFor(async () => {
    const value = JSON.parse(await readFile(markerPath, 'utf8'));
    return value.nonce === nonce &&
      value.preloadReady === true &&
      value.rendererReady === true &&
      value.builtinServerReady === true &&
      value.bridgeHealthReady === true &&
      value.requestBoundaryReady === true
      ? value
      : undefined;
  }, 'renderer and preload readiness');
  if (marker.pid !== child.pid) throw new Error('Readiness marker belongs to another process');
  return child;
}

async function stop(binary, child) {
  const quitter = spawn(binary, [`--user-data-dir=${userData}`, `--pideck-smoke-quit=${nonce}`], { env: { ...process.env, PIDECK_SMOKE_NONCE: nonce, HOME: userData }, stdio: 'ignore' });
  children.add(quitter);
  quitter.once('exit', () => children.delete(quitter));
  await waitFor(
    () => child.exitCode !== null || child.signalCode !== null,
    'graceful packaged shutdown',
    15_000,
  );
  await waitFor(
    () => quitter.exitCode !== null || quitter.signalCode !== null,
    'smoke quit helper shutdown',
    15_000,
  );
}

try {
  const { binaries } = await findElectronArtifacts(resolve(root, 'dist/electron'));
  const binary = selectHostBinary(binaries);
  if (!binary) throw new Error(`No packaged binary for ${process.platform}`);
  for (let launchNumber = 1; launchNumber <= 2; launchNumber += 1) {
    const child = await launch(binary);
    await stop(binary, child);
    if (child.exitCode !== 0) throw new Error(`Packaged launch ${launchNumber} exited ${child.exitCode}`);
  }
  const databasePath = join(userData, 'data', 'pideck.sqlite');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const integrity = database.prepare('PRAGMA integrity_check').get();
  database.close();
  if (Object.values(integrity)[0] !== 'ok') throw new Error('Packaged database integrity check failed');
  console.log(JSON.stringify({
    launches: 2,
    preloadReady: true,
    rendererReady: true,
    builtinServerReady: true,
    bridgeHealthReady: true,
    requestBoundaryReady: true,
    databaseIntegrity: 'ok',
    orphanProcesses: 0,
  }));
} catch (error) {
  console.error(logs.join('').replace(/(authorization|token|prompt)[^\n]*/gi, '$1=[redacted]').slice(-16_384));
  throw error;
} finally {
  for (const child of children) child.kill('SIGKILL');
  await rm(userData, { recursive: true, force: true });
}
