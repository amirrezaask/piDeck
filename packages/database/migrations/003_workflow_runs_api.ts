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

export const workflowRunsApiMigration: Migration = {
  async up(db) {
    await executeStatements(db as Kysely<MigrationDatabase>, [
      'ALTER TABLE workflow_runs ADD COLUMN idempotency_key TEXT',
      'ALTER TABLE workflow_runs ADD COLUMN request_digest TEXT',
      'ALTER TABLE workflow_runs ADD COLUMN correlation_id TEXT',
      "ALTER TABLE workflow_runs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'",
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_idempotency ON workflow_runs (idempotency_key) WHERE idempotency_key IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_created ON workflow_runs (workflow_id, created_at DESC, id DESC)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_runs_correlation ON workflow_runs (correlation_id, created_at DESC) WHERE correlation_id IS NOT NULL',
    ]);
  },

  async down(db) {
    await executeStatements(db as Kysely<MigrationDatabase>, [
      'DROP INDEX IF EXISTS idx_workflow_runs_correlation',
      'DROP INDEX IF EXISTS idx_workflow_runs_workflow_created',
      'DROP INDEX IF EXISTS idx_workflow_runs_idempotency',
      'ALTER TABLE workflow_runs DROP COLUMN metadata_json',
      'ALTER TABLE workflow_runs DROP COLUMN correlation_id',
      'ALTER TABLE workflow_runs DROP COLUMN request_digest',
      'ALTER TABLE workflow_runs DROP COLUMN idempotency_key',
    ]);
  },
};
