#!/usr/bin/env node

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { buildSupervisorApp } from '@pideck/supervisor';
import { registerWebApp } from './web.js';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
}

const databasePath = resolve(process.env.NEXTFLOW_DATABASE_PATH ?? './data/pideck.sqlite');
const host = process.env.NEXTFLOW_SUPERVISOR_HOST ?? '127.0.0.1';
const port = Number(process.env.NEXTFLOW_SUPERVISOR_PORT ?? 4101);
const serviceToken = process.env.NEXTFLOW_SUPERVISOR_TOKEN?.trim();
if (!serviceToken) throw new Error('NEXTFLOW_SUPERVISOR_TOKEN is required');

mkdirSync(dirname(databasePath), { recursive: true });
const agentDefaultCwd = process.env.NEXTFLOW_AGENT_CWD?.trim();
const piSessionDirectory = process.env.NEXTFLOW_PI_SESSION_DIR?.trim();
const { server } = buildSupervisorApp({
  databasePath,
  logger: true,
  serviceToken,
  ...(agentDefaultCwd ? { agentDefaultCwd } : {}),
  ...(piSessionDirectory ? { piSessionDirectory } : {}),
});
registerWebApp(server, resolve(__dirname, '../../web/dist'));

let shutdownStarted = false;
async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  try {
    await server.close();
    process.exitCode = 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

const smokeNonce = process.env.PIDECK_SMOKE_NONCE;
if (smokeNonce && /^[A-Za-z0-9_-]{20,128}$/.test(smokeNonce)) {
  server.post('/v1/smoke/quit', async (request, reply) => {
    if (request.headers['x-pideck-smoke-nonce'] !== smokeNonce) {
      return reply.code(403).send({ error: 'invalid_smoke_nonce' });
    }
    setImmediate(() => void shutdown());
    return reply.send({ status: 'shutting_down' });
  });
}

void server.listen({ host, port }).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
