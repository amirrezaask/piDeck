import { type Kysely, sql } from 'kysely';

import type { MigrationDatabase } from '../src/schema';

export const supervisorAgentPromptSettingsMigration = {
  async up(db: Kysely<MigrationDatabase>) {
    await db.schema
      .alterTable('supervisor_agents')
      .addColumn('system_prompt_mode', 'text', (column) =>
        column
          .notNull()
          .defaultTo('append')
          .check(sql`system_prompt_mode IN ('append', 'replace')`),
      )
      .execute();
  },
  async down(db: Kysely<MigrationDatabase>) {
    await db.schema.alterTable('supervisor_agents').dropColumn('system_prompt_mode').execute();
  },
};
