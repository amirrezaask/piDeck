import { type Kysely } from 'kysely';
import type { MigrationDatabase } from '../src/schema';

export const piSessionOwnershipMigration = {
  async up(db: Kysely<MigrationDatabase>) {
    await db.schema
      .alterTable('supervisor_agent_runs')
      .addColumn('pi_session_id', 'text')
      .execute();
    await db.schema
      .alterTable('supervisor_agent_runs')
      .addColumn('pi_session_file', 'text')
      .execute();
    await db.schema
      .alterTable('supervisor_agent_runs')
      .addColumn('pi_owner_instance', 'text')
      .execute();
    await db.schema
      .alterTable('supervisor_agent_runs')
      .addColumn('pi_recovery_state', 'text')
      .execute();
    await db.schema
      .alterTable('supervisor_agent_runs')
      .addColumn('pi_recovered_at', 'text')
      .execute();
    await db.schema
      .createIndex('supervisor_runs_pi_session_id_unique')
      .unique()
      .on('supervisor_agent_runs')
      .column('pi_session_id')
      .execute();
    await db.schema
      .createIndex('supervisor_runs_pi_session_file_unique')
      .unique()
      .on('supervisor_agent_runs')
      .column('pi_session_file')
      .execute();
  },
  async down(db: Kysely<MigrationDatabase>) {
    await db.schema.dropIndex('supervisor_runs_pi_session_file_unique').ifExists().execute();
    await db.schema.dropIndex('supervisor_runs_pi_session_id_unique').ifExists().execute();
    await db.schema.alterTable('supervisor_agent_runs').dropColumn('pi_recovered_at').execute();
    await db.schema.alterTable('supervisor_agent_runs').dropColumn('pi_recovery_state').execute();
    await db.schema.alterTable('supervisor_agent_runs').dropColumn('pi_owner_instance').execute();
    await db.schema.alterTable('supervisor_agent_runs').dropColumn('pi_session_file').execute();
    await db.schema.alterTable('supervisor_agent_runs').dropColumn('pi_session_id').execute();
  },
};
