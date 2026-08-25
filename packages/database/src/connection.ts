import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { Kysely, SqliteDialect } from 'kysely';

import type { MigrationDatabase, SupervisorDatabase, WorkflowDatabase } from './schema';

interface SqliteStatement {
  readonly reader: boolean;
  all(parameters?: ReadonlyArray<unknown>): unknown[];
  run(parameters?: ReadonlyArray<unknown>): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  iterate(parameters?: ReadonlyArray<unknown>): IterableIterator<unknown>;
}

interface RuntimeStatement {
  readonly columnNames?: readonly string[];
  columns?(): readonly unknown[];
  all(...parameters: unknown[]): unknown[];
  run(...parameters: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  iterate(...parameters: unknown[]): IterableIterator<unknown>;
  get(...parameters: unknown[]): unknown;
}

interface RuntimeDatabase {
  close(): void;
  prepare(sql: string): RuntimeStatement;
}

interface SqliteRuntimeModule {
  readonly Database?: new (
    filename: string,
    options?: { readonly?: boolean; create?: boolean },
  ) => RuntimeDatabase;
  readonly DatabaseSync?: new (
    filename: string,
    options?: { readonly readOnly?: boolean },
  ) => RuntimeDatabase;
}

/**
 * The small subset of SQLite exposed by the database package. Keeping this
 * wrapper here lets the application use Node's built-in SQLite implementation
 * or Bun's built-in SQLite implementation without a native addon dependency.
 */
export interface NativeSqliteDatabase {
  close(): void;
  prepare(sql: string): SqliteStatement;
  pragma<T = unknown>(name: string, options?: { readonly simple?: boolean }): T;
}

const runtimeRequire = createRequire(__filename);

function wrapStatement(database: RuntimeDatabase, sql: string): SqliteStatement {
  const statement = database.prepare(sql);
  const reader = statement.columnNames
    ? statement.columnNames.length > 0
    : (statement.columns?.().length ?? 0) > 0;
  return {
    reader,
    all(parameters = []) {
      return statement.all(...parameters);
    },
    run(parameters = []) {
      return statement.run(...parameters);
    },
    iterate(parameters = []) {
      return statement.iterate(...parameters);
    },
  };
}

function createSqliteDatabase(filename: string, options: DatabaseOptions): NativeSqliteDatabase {
  const moduleName = process.versions.bun ? 'bun:sqlite' : 'node:sqlite';
  const runtime = runtimeRequire(moduleName) as SqliteRuntimeModule;
  const database = runtime.DatabaseSync
    ? new runtime.DatabaseSync(filename, { readOnly: options.readonly ?? false })
    : runtime.Database
      ? new runtime.Database(filename, options.readonly ? { readonly: true } : { create: true })
      : undefined;
  if (!database) throw new Error(`SQLite runtime is unavailable: ${moduleName}`);

  return {
    close() {
      database.close();
    },
    prepare(sql) {
      return wrapStatement(database, sql);
    },
    pragma<T = unknown>(name: string, options?: { readonly simple?: boolean }): T {
      const statement = database.prepare(`PRAGMA ${name}`);
      if (options?.simple) {
        const row = statement.get() as Record<string, unknown> | undefined;
        return (row ? Object.values(row)[0] : undefined) as T;
      }
      return statement.all() as T;
    },
  };
}

export interface DatabaseOptions {
  readonly?: boolean;
}

export interface NextflowDatabase<Schema> {
  readonly db: Kysely<Schema>;
  readonly sqlite: NativeSqliteDatabase;
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

  const sqlite = createSqliteDatabase(filename, options);
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
