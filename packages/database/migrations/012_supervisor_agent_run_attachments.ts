import { type Kysely, type Migration, sql } from 'kysely';

import type { MigrationDatabase } from '../src/schema';

export const supervisorAgentRunAttachmentsMigration: Migration = {
  async up(db) {
    await sql
      .raw(`
        CREATE TABLE IF NOT EXISTS supervisor_agent_run_attachments (
          run_id TEXT NOT NULL REFERENCES supervisor_agent_runs(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK (position >= 0 AND position < 4),
          name TEXT NOT NULL,
          mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, position)
        )
      `)
      .execute(db as Kysely<MigrationDatabase>);
  },

  async down(db) {
    await sql
      .raw('DROP TABLE IF EXISTS supervisor_agent_run_attachments')
      .execute(db as Kysely<MigrationDatabase>);
  },
};
