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

export const initialMigration: Migration = {
  async up(db) {
    await executeStatements(db as Kysely<MigrationDatabase>, [
      `
        CREATE TABLE IF NOT EXISTS identity_users (
          id TEXT PRIMARY KEY NOT NULL,
          email TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS identity_roles (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS identity_user_roles (
          user_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
          role_id TEXT NOT NULL REFERENCES identity_roles(id) ON DELETE CASCADE,
          assigned_at TEXT NOT NULL,
          assigned_by TEXT REFERENCES identity_users(id) ON DELETE SET NULL,
          PRIMARY KEY (user_id, role_id)
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS identity_sessions (
          id TEXT PRIMARY KEY NOT NULL,
          user_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS workflow_definitions (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          draft_json TEXT NOT NULL,
          draft_version INTEGER NOT NULL DEFAULT 1 CHECK (draft_version > 0),
          created_by TEXT NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS workflow_versions (
          id TEXT PRIMARY KEY NOT NULL,
          workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
          version INTEGER NOT NULL CHECK (version > 0),
          definition_json TEXT NOT NULL,
          definition_digest TEXT NOT NULL,
          published_by TEXT NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
          published_at TEXT NOT NULL,
          UNIQUE (workflow_id, version)
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS workflow_runs (
          id TEXT PRIMARY KEY NOT NULL,
          workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
          workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
          initiated_by TEXT NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
          input_json TEXT NOT NULL,
          status TEXT NOT NULL,
          current_step_instance_id TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_requested IN (0, 1)),
          failure_code TEXT,
          failure_message TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS workflow_step_instances (
          id TEXT PRIMARY KEY NOT NULL,
          run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          node_type TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          status TEXT NOT NULL,
          input_json TEXT,
          output_json TEXT,
          observed_json TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          UNIQUE (run_id, ordinal)
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS workflow_step_attempts (
          id TEXT PRIMARY KEY NOT NULL,
          step_instance_id TEXT NOT NULL REFERENCES workflow_step_instances(id) ON DELETE CASCADE,
          attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
          status TEXT NOT NULL,
          input_json TEXT,
          output_json TEXT,
          error_json TEXT,
          dispatch_record_id TEXT,
          supervisor_execution_id TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          UNIQUE (step_instance_id, attempt_number)
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS workflow_approval_requests (
          id TEXT PRIMARY KEY NOT NULL,
          run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
          step_instance_id TEXT NOT NULL REFERENCES workflow_step_instances(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          required_role_ids_json TEXT NOT NULL,
          matching_mode TEXT NOT NULL,
          minimum_approvals INTEGER NOT NULL CHECK (minimum_approvals > 0),
          initiator_may_approve INTEGER NOT NULL CHECK (initiator_may_approve IN (0, 1)),
          approved_destination TEXT,
          rejected_destination TEXT,
          upstream_digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          cancelled_at TEXT
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS workflow_approval_decisions (
          id TEXT PRIMARY KEY NOT NULL,
          approval_request_id TEXT NOT NULL REFERENCES workflow_approval_requests(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
          observed_role_ids_json TEXT NOT NULL,
          outcome TEXT NOT NULL,
          comment TEXT,
          upstream_digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (approval_request_id, user_id)
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS workflow_dispatch_records (
          id TEXT PRIMARY KEY NOT NULL,
          run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
          step_instance_id TEXT NOT NULL REFERENCES workflow_step_instances(id) ON DELETE CASCADE,
          step_attempt_id TEXT NOT NULL REFERENCES workflow_step_attempts(id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          supervisor_execution_id TEXT,
          next_attempt_at TEXT NOT NULL,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS workflow_audit_events (
          id TEXT PRIMARY KEY NOT NULL,
          actor_user_id TEXT REFERENCES identity_users(id) ON DELETE SET NULL,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          request_id TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS supervisor_executions (
          id TEXT PRIMARY KEY NOT NULL,
          idempotency_key TEXT NOT NULL,
          agent_type TEXT NOT NULL,
          request_json TEXT NOT NULL,
          status TEXT NOT NULL,
          timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
          output_json TEXT,
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS supervisor_execution_events (
          execution_id TEXT NOT NULL REFERENCES supervisor_executions(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (execution_id, sequence)
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS supervisor_idempotency_keys (
          idempotency_key TEXT PRIMARY KEY NOT NULL,
          execution_id TEXT NOT NULL UNIQUE REFERENCES supervisor_executions(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL
        )
      `,
      'CREATE INDEX IF NOT EXISTS idx_identity_user_roles_role ON identity_user_roles (role_id, user_id)',
      'CREATE INDEX IF NOT EXISTS idx_identity_sessions_user ON identity_sessions (user_id, expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow ON workflow_versions (workflow_id, version DESC)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs (status, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_runs_version ON workflow_runs (workflow_version_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_status ON workflow_step_instances (run_id, status, ordinal)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_attempts_status ON workflow_step_attempts (status, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_approvals_status ON workflow_approval_requests (status, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_decisions_request ON workflow_approval_decisions (approval_request_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_dispatch_status ON workflow_dispatch_records (status, next_attempt_at)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_dispatch_execution ON workflow_dispatch_records (supervisor_execution_id)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_audit_entity ON workflow_audit_events (entity_type, entity_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_supervisor_executions_status ON supervisor_executions (status, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_supervisor_events_execution_sequence ON supervisor_execution_events (execution_id, sequence)',
    ]);
  },

  async down(db) {
    await executeStatements(db as Kysely<MigrationDatabase>, [
      'DROP TABLE IF EXISTS supervisor_idempotency_keys',
      'DROP TABLE IF EXISTS supervisor_execution_events',
      'DROP TABLE IF EXISTS supervisor_executions',
      'DROP TABLE IF EXISTS workflow_audit_events',
      'DROP TABLE IF EXISTS workflow_dispatch_records',
      'DROP TABLE IF EXISTS workflow_approval_decisions',
      'DROP TABLE IF EXISTS workflow_approval_requests',
      'DROP TABLE IF EXISTS workflow_step_attempts',
      'DROP TABLE IF EXISTS workflow_step_instances',
      'DROP TABLE IF EXISTS workflow_runs',
      'DROP TABLE IF EXISTS workflow_versions',
      'DROP TABLE IF EXISTS workflow_definitions',
      'DROP TABLE IF EXISTS identity_sessions',
      'DROP TABLE IF EXISTS identity_user_roles',
      'DROP TABLE IF EXISTS identity_roles',
      'DROP TABLE IF EXISTS identity_users',
    ]);
  },
};
