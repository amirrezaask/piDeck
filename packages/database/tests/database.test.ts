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
      expect(tables).toHaveLength(22);
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
