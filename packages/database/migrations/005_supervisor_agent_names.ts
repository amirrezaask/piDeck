import { type Kysely, type Migration, sql } from 'kysely';

import type { MigrationDatabase } from '../src/schema';

export const supervisorAgentNamesMigration: Migration = {
  async up(db) {
    await sql
      .raw("ALTER TABLE supervisor_agents ADD COLUMN name TEXT NOT NULL DEFAULT 'Pi agent'")
      .execute(db as Kysely<MigrationDatabase>);
  },

  async down(db) {
    await sql
      .raw('ALTER TABLE supervisor_agents DROP COLUMN name')
      .execute(db as Kysely<MigrationDatabase>);
  },
};
