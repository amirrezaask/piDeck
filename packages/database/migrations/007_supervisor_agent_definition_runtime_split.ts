import { type Kysely, type Migration, sql } from 'kysely';

import type { MigrationDatabase } from '../src/schema';

/**
 * Brings databases created by the first managed-session implementation up to
 * the definition/run split. The old agent runtime columns are left in place
 * for SQLite upgrade safety; application contracts no longer read or expose
 * them. New databases already have run_id from migration 002.
 */
export const supervisorAgentDefinitionRuntimeSplitMigration: Migration = {
  async up(db) {
    const database = db as Kysely<MigrationDatabase>;
    const columns = await sql<{ name: string }>`PRAGMA table_info(supervisor_agent_events)`.execute(
      database,
    );
    if (!columns.rows.some((column) => column.name === 'run_id')) {
      await sql.raw('ALTER TABLE supervisor_agent_events ADD COLUMN run_id TEXT').execute(database);
    }
    await sql
      .raw(
        'CREATE INDEX IF NOT EXISTS idx_supervisor_agent_events_run ON supervisor_agent_events (run_id, sequence)',
      )
      .execute(database);
  },

  async down(db) {
    await sql
      .raw('DROP INDEX IF EXISTS idx_supervisor_agent_events_run')
      .execute(db as Kysely<MigrationDatabase>);
  },
};
