import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import { createMigrationDatabase, createSupervisorDatabase, migrateToLatest } from '..';

const directories: string[] = [];

function temporaryDatabase(): { directory: string; filename: string } {
  const directory = mkdtempSync(join(tmpdir(), 'pideck-recovery-'));
  directories.push(directory);
  return { directory, filename: join(directory, 'recovery.sqlite') };
}

function child(code: string, filename: string) {
  return spawn(process.execPath, ['--input-type=module', '--eval', code, filename], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH },
  });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe.sequential('on-disk SQLite recovery', () => {
  it('recovers a committed WAL write after abrupt child-process death', async () => {
    const { filename } = temporaryDatabase();
    const migration = createMigrationDatabase(filename);
    await migrateToLatest(migration.db);
    await migration.close();

    const process = child(
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(process.argv[1]);
       db.exec("PRAGMA journal_mode=WAL; INSERT INTO supervisor_agents (id,name,system_prompt,requested_model_provider,requested_model_id,thinking_level,cwd,tools_json,created_at,updated_at,deleted_at) VALUES ('018bcfe4-7a4b-7000-8000-000000000111','crash fixture','fixture',NULL,NULL,'off','/tmp',NULL,'2026-01-01','2026-01-01',NULL)");
       process.stdout.write('committed');
       setInterval(() => {}, 1000);`,
      filename,
    );
    await once(process.stdout, 'data');
    process.kill('SIGKILL');
    await once(process, 'exit');

    const reopened = createSupervisorDatabase(filename);
    try {
      expect(reopened.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(reopened.sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(
        await reopened.db.selectFrom('supervisor_agents').select('name').executeTakeFirst(),
      ).toEqual({ name: 'crash fixture' });
      reopened.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      await reopened.close();
    }
  });

  it('exhausts SQLITE_BUSY while another process owns the write lock, then restarts cleanly', async () => {
    const { filename } = temporaryDatabase();
    const migration = createMigrationDatabase(filename);
    await migrateToLatest(migration.db);
    await migration.close();

    const locker = child(
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(process.argv[1]);
       db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE');
       process.stdout.write('locked');
       process.stdin.once('data', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });`,
      filename,
    );
    try {
      await once(locker.stdout, 'data');
      const contender = child(
        `import { DatabaseSync } from 'node:sqlite';
         const db = new DatabaseSync(process.argv[1]);
         db.exec('PRAGMA busy_timeout=25');
         try { db.exec('BEGIN IMMEDIATE'); process.exit(2); }
         catch (error) { process.stderr.write(String(error.code)); process.exit(error.code === 'ERR_SQLITE_ERROR' ? 0 : 3); }`,
        filename,
      );
      let diagnostic = '';
      contender.stderr.on('data', (chunk) => {
        diagnostic += String(chunk);
      });
      expect((await once(contender, 'exit'))[0]).toBe(0);
      expect(diagnostic).toContain('ERR_SQLITE_ERROR');
    } finally {
      locker.stdin.write('release');
      await once(locker, 'exit');
    }

    const reopened = createSupervisorDatabase(filename);
    try {
      expect(reopened.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(reopened.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      await reopened.close();
    }
  });

  it('fails deterministic writes through a read-only connection without modifying data', async () => {
    const { filename } = temporaryDatabase();
    const migration = createMigrationDatabase(filename);
    await migrateToLatest(migration.db);
    await migration.close();

    const writer = child(
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(process.argv[1], { readOnly: true });
       try { db.exec("INSERT INTO supervisor_agents (id,name,system_prompt,thinking_level,cwd,created_at,updated_at) VALUES ('018bcfe4-7a4b-7000-8000-000000000222','must not persist','fixture','off','/tmp','2026-01-01','2026-01-01')"); process.exit(2); }
       catch { process.exit(0); }`,
      filename,
    );
    expect((await once(writer, 'exit'))[0]).toBe(0);

    const reopened = createSupervisorDatabase(filename);
    try {
      expect(await reopened.db.selectFrom('supervisor_agents').select('id').execute()).toEqual([]);
    } finally {
      await reopened.close();
    }
  });

  it('fails a migration write through a read-only connection without partial schema state', async () => {
    const { filename } = temporaryDatabase();
    const seed = createMigrationDatabase(filename);
    await seed.close();

    const migrator = child(
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(process.argv[1], { readOnly: true });
       try { db.exec('CREATE TABLE migration_must_not_persist (id TEXT PRIMARY KEY)'); process.exit(2); }
       catch { process.exit(0); }`,
      filename,
    );
    expect((await once(migrator, 'exit'))[0]).toBe(0);

    const reopened = createSupervisorDatabase(filename);
    try {
      expect(reopened.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
      const tables = reopened.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .all(['migration_must_not_persist']);
      expect(tables).toEqual([]);
    } finally {
      await reopened.close();
    }
  });
});
