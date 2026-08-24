import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { buildSupervisorApp } from '@pideck/supervisor';

const envPath = resolve('../../.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const databasePath = resolve(process.env.NEXTFLOW_DATABASE_PATH ?? '../../data/pideck.sqlite');
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

async function shutdown(): Promise<void> {
  await server.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

void server.listen({ host, port }).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
