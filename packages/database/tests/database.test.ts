import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createId,
  createMigrationDatabase,
  getMigrationStatus,
  migrateToLatest,
  rollbackLastMigration,
  withBusyRetry,
} from '../index';

describe('database foundation', () => {
  it('enables SQLite safety pragmas and applies the initial migration', async () => {
    const connection = createMigrationDatabase(':memory:');
    try {
      await migrateToLatest(connection.db);

      expect(connection.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(connection.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);

      const tables = connection.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'kysely_%'")
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(25);
      expect(tables.map((table) => table.name)).toEqual(
        expect.arrayContaining([
          'supervisor_worktrees',
          'supervisor_terminal_sessions',
          'supervisor_inbox_items',
        ]),
      );
    } finally {
      await connection.close();
    }
  });

  it('installs the cross-process active-run admission index', async () => {
    const connection = createMigrationDatabase(':memory:');
    try {
      await migrateToLatest(connection.db);
      const indexes = connection.sqlite
        .prepare('PRAGMA index_list(supervisor_agent_runs)')
        .all() as Array<{ name: string; unique: number; partial: number }>;
      expect(indexes).toContainEqual(
        expect.objectContaining({
          name: 'idx_supervisor_agent_runs_one_active',
          unique: 1,
          partial: 1,
        }),
      );
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'supervisor_runs_pi_session_id_unique', unique: 1 }),
          expect.objectContaining({ name: 'supervisor_runs_pi_session_file_unique', unique: 1 }),
        ]),
      );
      const columns = connection.sqlite
        .prepare('PRAGMA table_info(supervisor_agent_runs)')
        .all() as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          'pi_session_id',
          'pi_session_file',
          'pi_owner_instance',
          'pi_recovery_state',
          'pi_recovered_at',
        ]),
      );
    } finally {
      await connection.close();
    }
  });

  it('rejects events whose run belongs to a different agent', async () => {
    const connection = createMigrationDatabase(':memory:');
    try {
      await migrateToLatest(connection.db);
      await connection.db
        .insertInto('supervisor_agents')
        .values({
          id: '018bcfe4-7a4b-7000-8000-000000000001',
          name: 'Agent',
          system_prompt: 'Prompt',
          system_prompt_mode: 'append',
          cwd: '/tmp',
          tools_json: null,
          requested_model_provider: null,
          requested_model_id: null,
          thinking_level: null,
          created_at: '2026-08-23T20:00:00.000Z',
          updated_at: '2026-08-23T20:00:00.000Z',
          deleted_at: null,
        })
        .execute();
      await connection.db
        .insertInto('supervisor_agents')
        .values({
          id: '018bcfe4-7a4b-7000-8000-000000000002',
          name: 'Agent 2',
          system_prompt: 'Prompt',
          system_prompt_mode: 'append',
          cwd: '/tmp',
          tools_json: null,
          requested_model_provider: null,
          requested_model_id: null,
          thinking_level: null,
          created_at: '2026-08-23T20:00:00.000Z',
          updated_at: '2026-08-23T20:00:00.000Z',
          deleted_at: null,
        })
        .execute();
      await connection.db
        .insertInto('supervisor_agent_runs')
        .values({
          id: '018bcfe4-7a4b-7000-8000-000000000003',
          agent_id: '018bcfe4-7a4b-7000-8000-000000000001',
          prompt: 'Start',
          model_provider: null,
          model_id: null,
          thinking_level: null,
          cwd: '/tmp',
          status: 'running',
          error_code: null,
          error_message: null,
          created_at: '2026-08-23T20:00:00.000Z',
          started_at: '2026-08-23T20:00:00.000Z',
          completed_at: null,
        })
        .execute();
      await expect(
        connection.db
          .insertInto('supervisor_agent_events')
          .values({
            agent_id: '018bcfe4-7a4b-7000-8000-000000000002',
            run_id: '018bcfe4-7a4b-7000-8000-000000000003',
            sequence: 1,
            event_type: 'invalid',
            payload_json: '{}',
            created_at: '2026-08-23T20:00:00.000Z',
          })
          .execute(),
      ).rejects.toThrow(/run_agent_mismatch/);
    } finally {
      await connection.close();
    }
  });

  it('reports migration state and can roll the migration back', async () => {
    const connection = createMigrationDatabase(':memory:');
    try {
      expect(
        (await getMigrationStatus(connection.db)).every((item) => item.status === 'NotExecuted'),
      ).toBe(true);
      await migrateToLatest(connection.db);
      expect(
        (await getMigrationStatus(connection.db)).every((item) => item.status === 'Executed'),
      ).toBe(true);
      await rollbackLastMigration(connection.db);
      const afterOneRollback = await getMigrationStatus(connection.db);
      expect(afterOneRollback.at(-1)?.status).toBe('NotExecuted');
      expect(afterOneRollback.slice(0, -1).every((item) => item.status === 'Executed')).toBe(true);
      while ((await getMigrationStatus(connection.db)).some((item) => item.status === 'Executed')) {
        await rollbackLastMigration(connection.db);
      }
      expect(
        (await getMigrationStatus(connection.db)).every((item) => item.status === 'NotExecuted'),
      ).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it('physically rolls migration 013 back and reapplies it on a populated disk database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pideck-migration-013-'));
    const filename = join(directory, 'migration.sqlite');
    const connection = createMigrationDatabase(filename);
    try {
      await migrateToLatest(connection.db);
      await rollbackLastMigration(connection.db); // 014 depends on columns added after 013.

      const now = '2026-08-26T00:00:00.000Z';
      connection.sqlite
        .prepare(
          `INSERT INTO supervisor_agents
            (id, name, system_prompt, cwd, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(['agent-013', 'Migration agent', 'Preserve me', '/tmp', now, now]);
      connection.sqlite
        .prepare(
          `INSERT INTO supervisor_projects
            (id, name, path, created_at, updated_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(['project-013', 'Migration project', '/tmp/project-013', now, now, now]);
      connection.sqlite
        .prepare(
          `INSERT INTO supervisor_agent_runs
            (id, agent_id, prompt, status, created_at, cwd, execution_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(['run-013', 'agent-013', 'Preserve this run', 'completed', now, '/tmp', 'local']);
      connection.sqlite
        .prepare(
          `INSERT INTO supervisor_worktrees
            (id, project_id, path, branch, base_ref, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run([
          'worktree-013',
          'project-013',
          '/tmp/project-013-worktree',
          'migration',
          'main',
          'ready',
          now,
          now,
        ]);
      connection.sqlite
        .prepare(
          `INSERT INTO supervisor_terminal_sessions
            (id, cwd, command, args_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(['terminal-013', '/tmp', 'true', '[]', 'completed', now]);
      connection.sqlite
        .prepare(
          `INSERT INTO supervisor_inbox_items
            (id, kind, run_id, title, body, options_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(['inbox-013', 'question', 'run-013', 'Question', 'Body', '[]', 'pending', now]);

      await expect(
        connection.db.transaction().execute(async (transaction) => {
          await transaction.schema
            .alterTable('supervisor_agent_runs')
            .addColumn('interrupted_migration_probe', 'text')
            .execute();
          throw new Error('simulated interrupted migration');
        }),
      ).rejects.toThrow('simulated interrupted migration');
      expect(
        (
          connection.sqlite.prepare('PRAGMA table_info(supervisor_agent_runs)').all() as Array<{
            name: string;
          }>
        ).map(({ name }) => name),
      ).not.toContain('interrupted_migration_probe');

      while (
        (await getMigrationStatus(connection.db)).find(
          (migration) => migration.name === '013_workspace_capabilities',
        )?.status === 'Executed'
      ) {
        await rollbackLastMigration(connection.db);
      }

      const rolledBackColumns = connection.sqlite
        .prepare('PRAGMA table_info(supervisor_agent_runs)')
        .all() as Array<{ name: string }>;
      expect(rolledBackColumns.map(({ name }) => name)).not.toEqual(
        expect.arrayContaining(['execution_mode', 'worktree_id', 'parent_run_id']),
      );
      expect(
        connection.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'supervisor_%'",
          )
          .all(),
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'supervisor_worktrees' }),
          expect.objectContaining({ name: 'supervisor_terminal_sessions' }),
          expect.objectContaining({ name: 'supervisor_inbox_items' }),
        ]),
      );
      expect(
        connection.sqlite
          .prepare('SELECT prompt FROM supervisor_agent_runs WHERE id = ?')
          .all(['run-013']),
      ).toEqual([{ prompt: 'Preserve this run' }]);
      expect(
        connection.sqlite
          .prepare('SELECT name FROM supervisor_projects WHERE id = ?')
          .all(['project-013']),
      ).toEqual([{ name: 'Migration project' }]);

      await migrateToLatest(connection.db);
      const reappliedColumns = connection.sqlite
        .prepare('PRAGMA table_info(supervisor_agent_runs)')
        .all() as Array<{ name: string }>;
      expect(reappliedColumns.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['execution_mode', 'worktree_id', 'parent_run_id']),
      );
      expect(connection.sqlite.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);

      while ((await getMigrationStatus(connection.db)).some((item) => item.status === 'Executed')) {
        await rollbackLastMigration(connection.db);
      }
      await migrateToLatest(connection.db);
      expect(
        (await getMigrationStatus(connection.db)).every((item) => item.status === 'Executed'),
      ).toBe(true);
      expect(connection.sqlite.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      await connection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retries transient lock failures without retrying successful work', async () => {
    let attempts = 0;
    const result = await withBusyRetry(
      () => {
        attempts += 1;
        if (attempts < 3)
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY_SNAPSHOT' });
        return 'completed';
      },
      { initialDelayMs: 0 },
    );

    expect(result).toBe('completed');
    expect(attempts).toBe(3);
  });

  it('creates UUIDv7 identifiers', () => {
    const id = createId(1_700_000_000_000);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
