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

export const supervisorAgentsMigration: Migration = {
  async up(db) {
    await executeStatements(db as Kysely<MigrationDatabase>, [
      `
        CREATE TABLE IF NOT EXISTS supervisor_agents (
          id TEXT PRIMARY KEY NOT NULL,
          system_prompt TEXT NOT NULL,
          cwd TEXT NOT NULL,
          tools_json TEXT,
          requested_model_provider TEXT,
          requested_model_id TEXT,
          thinking_level TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS supervisor_agent_events (
          agent_id TEXT NOT NULL REFERENCES supervisor_agents(id) ON DELETE CASCADE,
          run_id TEXT,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (agent_id, sequence)
        )
      `,
      'CREATE INDEX IF NOT EXISTS idx_supervisor_agents_created ON supervisor_agents (created_at DESC, id DESC)',
      'CREATE INDEX IF NOT EXISTS idx_supervisor_agent_events_sequence ON supervisor_agent_events (agent_id, sequence)',
      'CREATE INDEX IF NOT EXISTS idx_supervisor_agent_events_run ON supervisor_agent_events (run_id, sequence)',
    ]);
  },

  async down(db) {
    await executeStatements(db as Kysely<MigrationDatabase>, [
      'DROP TABLE IF EXISTS supervisor_agent_events',
      'DROP TABLE IF EXISTS supervisor_agents',
    ]);
  },
};
