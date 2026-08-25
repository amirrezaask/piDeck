import { type Kysely, type Migration, sql } from 'kysely';

import type { MigrationDatabase } from '../src/schema';

/**
 * Makes the process-local active-run check enforceable across supervisor
 * processes as well.  The cleanup before the index is intentionally
 * conservative: if an older database contains more than one active run for a
 * profile, the newest run (UUIDv7 ordering) wins and the others become failed
 * recovery records instead of being silently deleted.
 */
export const supervisorRunAdmissionAndProfilesMigration: Migration = {
  async up(db) {
    const database = db as Kysely<MigrationDatabase>;
    const columns = await sql<{ name: string }>`PRAGMA table_info(supervisor_agents)`.execute(
      database,
    );
    if (!columns.rows.some((column) => column.name === 'deleted_at')) {
      await sql.raw('ALTER TABLE supervisor_agents ADD COLUMN deleted_at TEXT').execute(database);
    }

    await sql
      .raw(`
        UPDATE supervisor_agent_runs
        SET
          status = 'failed',
          error_code = 'supervisor_recovered_duplicate_active_run',
          error_message = 'The run was superseded while repairing duplicate active runs',
          completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        WHERE status IN ('queued', 'running')
          AND id NOT IN (
            SELECT MAX(id)
            FROM supervisor_agent_runs
            WHERE status IN ('queued', 'running')
            GROUP BY agent_id
          )
      `)
      .execute(database);

    await sql
      .raw(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_supervisor_agent_runs_one_active
        ON supervisor_agent_runs (agent_id)
        WHERE status IN ('queued', 'running')
      `)
      .execute(database);

    // SQLite cannot add a foreign key to the existing event table in place.
    // This trigger provides the same safety property for new writes while
    // preserving all existing event rows during upgrades.
    await sql
      .raw(`
        CREATE TRIGGER IF NOT EXISTS supervisor_agent_events_run_agent_fk
        BEFORE INSERT ON supervisor_agent_events
        WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
          SELECT 1
          FROM supervisor_agent_runs
          WHERE id = NEW.run_id AND agent_id = NEW.agent_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'supervisor_agent_event_run_agent_mismatch');
        END
      `)
      .execute(database);
  },

  async down(db) {
    const database = db as Kysely<MigrationDatabase>;
    await sql.raw('DROP TRIGGER IF EXISTS supervisor_agent_events_run_agent_fk').execute(database);
    await sql.raw('DROP INDEX IF EXISTS idx_supervisor_agent_runs_one_active').execute(database);
    // SQLite versions used by deployments support DROP COLUMN, but leaving the
    // nullable compatibility column in place is safer than rebuilding a live
    // table during rollback. It is ignored by older application code.
  },
};
