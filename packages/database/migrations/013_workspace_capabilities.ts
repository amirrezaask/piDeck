import { type Kysely } from 'kysely';
import type { MigrationDatabase } from '../src/schema';

export const workspaceCapabilitiesMigration = {
  async up(db: Kysely<MigrationDatabase>) {
    await db.schema
      .alterTable('supervisor_agent_runs')
      .addColumn('execution_mode', 'text', (column) => column.notNull().defaultTo('local'))
      .execute();
    await db.schema.alterTable('supervisor_agent_runs').addColumn('worktree_id', 'text').execute();
    await db.schema
      .alterTable('supervisor_agent_runs')
      .addColumn('parent_run_id', 'text')
      .execute();

    await db.schema
      .createTable('supervisor_worktrees')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('project_id', 'text', (column) =>
        column.notNull().references('supervisor_projects.id').onDelete('cascade'),
      )
      .addColumn('path', 'text', (column) => column.notNull().unique())
      .addColumn('branch', 'text', (column) => column.notNull())
      .addColumn('base_ref', 'text', (column) => column.notNull())
      .addColumn('status', 'text', (column) => column.notNull())
      .addColumn('error', 'text')
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addColumn('updated_at', 'text', (column) => column.notNull())
      .execute();

    await db.schema
      .createTable('supervisor_terminal_sessions')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('cwd', 'text', (column) => column.notNull())
      .addColumn('command', 'text', (column) => column.notNull())
      .addColumn('args_json', 'text', (column) => column.notNull())
      .addColumn('status', 'text', (column) => column.notNull())
      .addColumn('exit_code', 'integer')
      .addColumn('output', 'text', (column) => column.notNull().defaultTo(''))
      .addColumn('truncated', 'integer', (column) => column.notNull().defaultTo(0))
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addColumn('completed_at', 'text')
      .execute();

    await db.schema
      .createTable('supervisor_inbox_items')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('kind', 'text', (column) => column.notNull())
      .addColumn('run_id', 'text')
      .addColumn('title', 'text', (column) => column.notNull())
      .addColumn('body', 'text', (column) => column.notNull())
      .addColumn('options_json', 'text', (column) => column.notNull())
      .addColumn('status', 'text', (column) => column.notNull())
      .addColumn('response', 'text')
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addColumn('resolved_at', 'text')
      .execute();

    await db.schema
      .createIndex('supervisor_worktrees_project_status_idx')
      .on('supervisor_worktrees')
      .columns(['project_id', 'status'])
      .execute();
    await db.schema
      .createIndex('supervisor_inbox_status_created_idx')
      .on('supervisor_inbox_items')
      .columns(['status', 'created_at'])
      .execute();
    await db.schema
      .createIndex('supervisor_runs_parent_idx')
      .on('supervisor_agent_runs')
      .column('parent_run_id')
      .execute();
  },
  async down(db: Kysely<MigrationDatabase>) {
    await db.schema.dropIndex('supervisor_runs_parent_idx').ifExists().execute();
    await db.schema.dropTable('supervisor_inbox_items').ifExists().execute();
    await db.schema.dropTable('supervisor_terminal_sessions').ifExists().execute();
    await db.schema.dropTable('supervisor_worktrees').ifExists().execute();
    await db.schema.alterTable('supervisor_agent_runs').dropColumn('parent_run_id').execute();
    await db.schema.alterTable('supervisor_agent_runs').dropColumn('worktree_id').execute();
    await db.schema.alterTable('supervisor_agent_runs').dropColumn('execution_mode').execute();
  },
};
