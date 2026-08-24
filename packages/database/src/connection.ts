import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';

import type { MigrationDatabase, SupervisorDatabase, WorkflowDatabase } from './schema';

export interface DatabaseOptions {
  readonly?: boolean;
}

export interface NextflowDatabase<Schema> {
  readonly db: Kysely<Schema>;
  readonly sqlite: BetterSqlite3.Database;
  close(): Promise<void>;
}

function ensureParentDirectory(filename: string): void {
  if (filename === ':memory:' || filename.startsWith('file:')) {
    return;
  }

  mkdirSync(dirname(filename), { recursive: true });
}

export function openDatabase<Schema>(
  filename: string,
  options: DatabaseOptions = {},
): NextflowDatabase<Schema> {
  ensureParentDirectory(filename);

  const sqlite = new BetterSqlite3(filename, {
    readonly: options.readonly ?? false,
  });
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = new Kysely<Schema>({
    dialect: new SqliteDialect({ database: sqlite }),
  });

  let closed = false;
  return {
    db,
    sqlite,
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      await db.destroy();
    },
  };
}

export function createMigrationDatabase(filename: string): NextflowDatabase<MigrationDatabase> {
  return openDatabase<MigrationDatabase>(filename);
}

export function createWorkflowManagerDatabase(
  filename: string,
): NextflowDatabase<WorkflowDatabase> {
  return openDatabase<WorkflowDatabase>(filename);
}

export function createSupervisorDatabase(filename: string): NextflowDatabase<SupervisorDatabase> {
  return openDatabase<SupervisorDatabase>(filename);
}
