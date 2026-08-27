import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, restoreBackup, verifyBackup } from '../lib/pideck-backup.mjs';

test('quiesced backup verifies, detects tampering, and restores with rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pideck backup test '));
  try {
    const source = join(root, 'source'); const databasePath = join(source, 'pideck.sqlite'); const sessions = join(source, 'pi sessions');
    await mkdir(sessions, { recursive: true });
    const database = new DatabaseSync(databasePath);
    await writeFile(join(sessions, 'agent-1.jsonl'), '{"type":"session"}\n', { mode: 0o600 });
    database.exec('PRAGMA foreign_keys=ON; CREATE TABLE kysely_migration(name TEXT PRIMARY KEY, timestamp TEXT NOT NULL); CREATE TABLE agents(id TEXT PRIMARY KEY); CREATE TABLE supervisor_agent_runs(id TEXT PRIMARY KEY, pi_session_file TEXT); INSERT INTO kysely_migration VALUES (\'001_initial\', \'now\'); INSERT INTO agents VALUES (\'agent-1\');');
    database.prepare('INSERT INTO supervisor_agent_runs VALUES (?, ?)').run('run-1', join(sessions, 'agent-1.jsonl'));
    database.close();
    const original = await readFile(databasePath);
    const backup = join(root, 'backup with spaces');
    await createBackup({ databasePath, sessionDirectory: sessions, destination: backup, appVersion: '0.1.0' });
    assert.deepEqual(await readFile(databasePath), original);
    await verifyBackup(backup, ['001_initial']);
    const target = join(root, 'restore'); await mkdir(target); await writeFile(join(target, 'pideck.sqlite'), 'old');
    const restored = await restoreBackup({ backupDirectory: backup, databasePath: join(target, 'pideck.sqlite'), sessionDirectory: join(target, 'sessions'), supportedMigrations: ['001_initial'] });
    assert.match(restored.rollbackDirectory, /pideck-rollback-/);
    assert.equal((await readFile(join(target, 'sessions', 'agent-1.jsonl'), 'utf8')).trim(), '{"type":"session"}');
    const restoredDatabase = new DatabaseSync(join(target, 'pideck.sqlite'), { readOnly: true });
    assert.equal(restoredDatabase.prepare('SELECT pi_session_file FROM supervisor_agent_runs WHERE id = ?').get('run-1').pi_session_file, join(target, 'sessions', 'agent-1.jsonl'));
    restoredDatabase.close();
    await writeFile(join(backup, 'sessions', 'agent-1.jsonl'), 'tampered');
    await assert.rejects(verifyBackup(backup), /hash verification failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup refuses active WAL and source/destination overlap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pideck backup refusal '));
  try {
    const databasePath = join(root, 'pideck.sqlite'); const database = new DatabaseSync(databasePath); database.exec('CREATE TABLE value(id INTEGER)'); database.close();
    await writeFile(`${databasePath}-wal`, 'active');
    await assert.rejects(createBackup({ databasePath, sessionDirectory: join(root, 'sessions'), destination: join(root, 'backup'), appVersion: 'test' }), /must be stopped/);
    await rm(`${databasePath}-wal`);
    await assert.rejects(createBackup({ databasePath, sessionDirectory: join(root, 'sessions'), destination: join(root, 'sessions', 'backup'), appVersion: 'test' }), /separate/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
