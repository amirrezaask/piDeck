import { describe, expect, it } from 'vitest';

import {
  createId,
  createMigrationDatabase,
  getMigrationStatus,
  migrateToLatest,
  rollbackLastMigration,
  withBusyRetry,
} from '../src';

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
      expect(tables).toHaveLength(20);
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
