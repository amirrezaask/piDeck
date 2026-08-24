import { type Kysely, type Migration, sql } from 'kysely';

import type { MigrationDatabase } from '../src/schema';

async function executeStatements(
  db: Kysely<MigrationDatabase>,
  statements: string[],
): Promise<void> {
  for (const statement of statements) {
    await sql.raw(statement).execute(db);
  }
}

export const supervisorProjectsMigration: Migration = {
  async up(db) {
    await executeStatements(db as Kysely<MigrationDatabase>, [
      `
        CREATE TABLE IF NOT EXISTS supervisor_projects (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL
        )
      `,
      'CREATE INDEX IF NOT EXISTS idx_supervisor_projects_last_used ON supervisor_projects (last_used_at DESC, id DESC)',
    ]);
  },

  async down(db) {
    await executeStatements(db as Kysely<MigrationDatabase>, [
      'DROP INDEX IF EXISTS idx_supervisor_projects_last_used',
      'DROP TABLE IF EXISTS supervisor_projects',
    ]);
  },
};
