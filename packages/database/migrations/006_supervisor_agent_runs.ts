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

export const supervisorAgentRunsMigration: Migration = {
  async up(db) {
    await executeStatements(db as Kysely<MigrationDatabase>, [
      `
        CREATE TABLE IF NOT EXISTS supervisor_agent_runs (
          id TEXT PRIMARY KEY NOT NULL,
          agent_id TEXT NOT NULL REFERENCES supervisor_agents(id) ON DELETE CASCADE,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          CHECK ((error_code IS NULL AND error_message IS NULL) OR (error_code IS NOT NULL AND error_message IS NOT NULL))
        )
      `,
      'CREATE INDEX IF NOT EXISTS idx_supervisor_agent_runs_created ON supervisor_agent_runs (created_at DESC, id DESC)',
      'CREATE INDEX IF NOT EXISTS idx_supervisor_agent_runs_agent_created ON supervisor_agent_runs (agent_id, created_at DESC, id DESC)',
      'CREATE INDEX IF NOT EXISTS idx_supervisor_agent_runs_status ON supervisor_agent_runs (status, created_at DESC)',
    ]);
  },

  async down(db) {
    await executeStatements(db as Kysely<MigrationDatabase>, [
      'DROP INDEX IF EXISTS idx_supervisor_agent_runs_status',
      'DROP INDEX IF EXISTS idx_supervisor_agent_runs_agent_created',
      'DROP INDEX IF EXISTS idx_supervisor_agent_runs_created',
      'DROP TABLE IF EXISTS supervisor_agent_runs',
    ]);
  },
};
