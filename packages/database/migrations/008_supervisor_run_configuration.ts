import { type Kysely, type Migration, sql } from 'kysely';

import type { MigrationDatabase } from '../src/schema';

/**
 * Snapshots runtime configuration on each run. Agent rows remain reusable
 * instruction profiles while model, thinking level, and cwd belong to a session.
 */
export const supervisorRunConfigurationMigration: Migration = {
  async up(db) {
    const database = db as Kysely<MigrationDatabase>;
    const columns = await sql<{ name: string }>`PRAGMA table_info(supervisor_agent_runs)`.execute(
      database,
    );
    const names = new Set(columns.rows.map((column) => column.name));
    if (!names.has('model_provider')) {
      await sql
        .raw('ALTER TABLE supervisor_agent_runs ADD COLUMN model_provider TEXT')
        .execute(database);
    }
    if (!names.has('model_id')) {
      await sql.raw('ALTER TABLE supervisor_agent_runs ADD COLUMN model_id TEXT').execute(database);
    }
    if (!names.has('thinking_level')) {
      await sql
        .raw('ALTER TABLE supervisor_agent_runs ADD COLUMN thinking_level TEXT')
        .execute(database);
    }
    if (!names.has('cwd')) {
      await sql
        .raw("ALTER TABLE supervisor_agent_runs ADD COLUMN cwd TEXT NOT NULL DEFAULT '.'")
        .execute(database);
    }
  },

  async down() {
    // SQLite cannot safely drop these compatibility columns in-place.
  },
};
