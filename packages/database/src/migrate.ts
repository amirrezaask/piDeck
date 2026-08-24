import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { createMigrationDatabase } from './connection';
import { migrateToLatest } from './migrations';

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const envPath = resolve(workspaceRoot, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  const databasePath = resolve(
    workspaceRoot,
    process.env.NEXTFLOW_DATABASE_PATH ?? './data/pideck.sqlite',
  );
  const connection = createMigrationDatabase(databasePath);

  try {
    const results = (await migrateToLatest(connection.db)) ?? [];
    if (results.length === 0) {
      console.log('Database is already up to date.');
      return;
    }

    for (const result of results) {
      console.log(`${result.migrationName}: ${result.status}`);
    }
  } finally {
    await connection.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
