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

export const supervisorAgentCommandReceiptsMigration: Migration = {
  async up(db) {
    await executeStatements(db as Kysely<MigrationDatabase>, [
      `
        CREATE TABLE IF NOT EXISTS supervisor_agent_command_receipts (
          id TEXT PRIMARY KEY NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          agent_id TEXT NOT NULL REFERENCES supervisor_agents(id) ON DELETE CASCADE,
          command_type TEXT NOT NULL CHECK (command_type IN ('create', 'prompt', 'abort', 'dispose')),
          request_digest TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'indeterminate')),
          result_json TEXT,
          error_code TEXT,
          error_message TEXT,
          http_status INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          CHECK (
            (status = 'pending' AND result_json IS NULL AND error_code IS NULL AND error_message IS NULL AND http_status IS NULL AND completed_at IS NULL)
            OR (status = 'succeeded' AND result_json IS NOT NULL AND error_code IS NULL AND error_message IS NULL AND http_status IS NOT NULL AND completed_at IS NOT NULL)
            OR (status IN ('failed', 'indeterminate') AND result_json IS NULL AND error_code IS NOT NULL AND error_message IS NOT NULL AND http_status IS NOT NULL AND completed_at IS NOT NULL)
          )
        )
      `,
      'CREATE INDEX IF NOT EXISTS idx_supervisor_agent_command_receipts_agent ON supervisor_agent_command_receipts (agent_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_supervisor_agent_command_receipts_status ON supervisor_agent_command_receipts (status, updated_at)',
    ]);
  },

  async down(db) {
    await executeStatements(db as Kysely<MigrationDatabase>, [
      'DROP TABLE IF EXISTS supervisor_agent_command_receipts',
    ]);
  },
};
