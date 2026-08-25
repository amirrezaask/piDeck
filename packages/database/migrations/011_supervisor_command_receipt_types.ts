import { type Kysely, type Migration, sql } from 'kysely';

import type { MigrationDatabase } from '../src/schema';

/** Extends the original receipt table to cover durable PI run interventions. */
export const supervisorCommandReceiptTypesMigration: Migration = {
  async up(db) {
    const database = db as Kysely<MigrationDatabase>;
    await sql
      .raw('DROP INDEX IF EXISTS idx_supervisor_agent_command_receipts_agent')
      .execute(database);
    await sql
      .raw('DROP INDEX IF EXISTS idx_supervisor_agent_command_receipts_status')
      .execute(database);
    await sql
      .raw(
        'ALTER TABLE supervisor_agent_command_receipts RENAME TO supervisor_agent_command_receipts_old',
      )
      .execute(database);
    await sql
      .raw(`
        CREATE TABLE supervisor_agent_command_receipts (
          id TEXT PRIMARY KEY NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          agent_id TEXT NOT NULL REFERENCES supervisor_agents(id) ON DELETE CASCADE,
          command_type TEXT NOT NULL CHECK (command_type IN (
            'create', 'prompt', 'abort', 'dispose',
            'run_create', 'steer', 'follow_up', 'cancel'
          )),
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
      `)
      .execute(database);
    await sql
      .raw(`
        INSERT INTO supervisor_agent_command_receipts
          (id, idempotency_key, agent_id, command_type, request_digest, status,
           result_json, error_code, error_message, http_status, created_at, updated_at, completed_at)
        SELECT id, idempotency_key, agent_id, command_type, request_digest, status,
               result_json, error_code, error_message, http_status, created_at, updated_at, completed_at
        FROM supervisor_agent_command_receipts_old
      `)
      .execute(database);
    await sql.raw('DROP TABLE supervisor_agent_command_receipts_old').execute(database);
    await sql
      .raw(
        'CREATE INDEX idx_supervisor_agent_command_receipts_agent ON supervisor_agent_command_receipts (agent_id, created_at DESC)',
      )
      .execute(database);
    await sql
      .raw(
        'CREATE INDEX idx_supervisor_agent_command_receipts_status ON supervisor_agent_command_receipts (status, updated_at)',
      )
      .execute(database);
  },

  async down() {
    // Keep the widened check during rollback. Migration 004 removes the table
    // on a full rollback, while an isolated down must not destroy receipts.
  },
};
