import { createHash } from 'node:crypto';
import { cp, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const FORMAT_VERSION = 1;

// Keep this list aligned with packages/database/src/migrations.ts. Backups
// must never be restored by an older binary without an explicit compatibility
// decision.
export const SUPPORTED_SCHEMA_MIGRATIONS = Object.freeze([
  '001_initial',
  '002_supervisor_agents',
  '003_workflow_runs_api',
  '004_supervisor_agent_command_receipts',
  '005_supervisor_agent_names',
  '006_supervisor_agent_runs',
  '007_supervisor_agent_definition_runtime_split',
  '008_supervisor_run_configuration',
  '009_supervisor_projects',
  '010_supervisor_run_admission_and_profiles',
  '011_supervisor_command_receipt_types',
  '012_supervisor_agent_run_attachments',
  '013_workspace_capabilities',
  '014_pi_session_ownership',
]);

async function exists(path) { return Boolean(await stat(path).catch(() => undefined)); }
async function hashFile(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
function inside(root, path) { const value = relative(root, path); return value && !value.startsWith(`..${sep}`) && value !== '..'; }

async function listFiles(root, directory = root) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Backup refuses symbolic links: ${path}`);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}

export async function verifySqlite(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = Object.values(database.prepare('PRAGMA integrity_check').get())[0];
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
    const migrations = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kysely_migration'").get()
      ? database.prepare('SELECT name FROM kysely_migration ORDER BY name').all().map((row) => row.name)
      : [];
    if (integrity !== 'ok') throw new Error(`SQLite integrity_check failed: ${integrity}`);
    if (foreignKeys.length > 0) throw new Error(`SQLite foreign_key_check found ${foreignKeys.length} violation(s)`);
    return { integrity, foreignKeyViolations: foreignKeys.length, migrations };
  } finally { database.close(); }
}

function readSessionOwnership(databasePath, sessionDirectory) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const hasRuns = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='supervisor_agent_runs'")
      .get();
    if (!hasRuns) return [];
    return database
      .prepare('SELECT id, pi_session_file FROM supervisor_agent_runs WHERE pi_session_file IS NOT NULL')
      .all()
      .map((row) => {
        const path = resolve(String(row.pi_session_file));
        if (!inside(resolve(sessionDirectory), path)) throw new Error(`Pi session ownership escapes the configured root for run ${row.id}`);
        return { runId: String(row.id), relativePath: relative(resolve(sessionDirectory), path) };
      });
  } finally { database.close(); }
}

export async function createBackup({ databasePath, sessionDirectory, destination, appVersion }) {
  const sourceDb = resolve(databasePath);
  const sourceSessions = resolve(sessionDirectory);
  const target = resolve(destination);
  if ([sourceDb, sourceSessions].some((source) => target === source || inside(source, target) || inside(target, source))) throw new Error('Backup destination must be separate from all source paths');
  if (await exists(target)) throw new Error(`Backup destination already exists: ${target}`);
  for (const suffix of ['-wal', '-shm']) if (await exists(`${sourceDb}${suffix}`)) throw new Error(`Application must be stopped: active SQLite sidecar exists (${basename(sourceDb)}${suffix})`);
  await verifySqlite(sourceDb);
  await mkdir(join(target, 'sessions'), { recursive: true, mode: 0o700 });
  await cp(sourceDb, join(target, 'pideck.sqlite'), { errorOnExist: true });
  if (await exists(sourceSessions)) await cp(sourceSessions, join(target, 'sessions'), { recursive: true, errorOnExist: true });
  const relativeFiles = ['pideck.sqlite', ...(await listFiles(join(target, 'sessions'))).map((file) => `sessions/${file}`)];
  const files = [];
  for (const path of relativeFiles) files.push({ path, sha256: await hashFile(join(target, path)), bytes: (await stat(join(target, path))).size });
  const db = await verifySqlite(join(target, 'pideck.sqlite'));
  const sessionOwnership = readSessionOwnership(sourceDb, sourceSessions);
  for (const ownership of sessionOwnership) if (!(await exists(join(sourceSessions, ownership.relativePath)))) throw new Error(`Owned Pi session file is missing for run ${ownership.runId}`);
  const manifest = { formatVersion: FORMAT_VERSION, appVersion, createdAt: new Date().toISOString(), schemaMigrations: db.migrations, sessionOwnership, files };
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

export async function verifyBackup(
  backupDirectory,
  supportedMigrations = SUPPORTED_SCHEMA_MIGRATIONS,
) {
  const root = resolve(backupDirectory);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (
    manifest.formatVersion !== FORMAT_VERSION ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.schemaMigrations) ||
    manifest.schemaMigrations.some((name) => typeof name !== 'string') ||
    (manifest.sessionOwnership !== undefined && !Array.isArray(manifest.sessionOwnership))
  ) throw new Error('Unsupported backup manifest');
  const sessionsRoot = resolve(root, 'sessions');
  for (const ownership of manifest.sessionOwnership ?? []) {
    if (
      !ownership ||
      typeof ownership !== 'object' ||
      typeof ownership.runId !== 'string' ||
      typeof ownership.relativePath !== 'string' ||
      !inside(sessionsRoot, resolve(sessionsRoot, ownership.relativePath))
    ) throw new Error('Backup session ownership escapes the backup root');
  }
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file !== 'object' ||
      typeof file.path !== 'string' ||
      typeof file.sha256 !== 'string'
    ) throw new Error('Unsupported backup manifest');
    const path = resolve(root, file.path);
    if (!inside(root, path) || (await hashFile(path)) !== file.sha256) throw new Error(`Backup hash verification failed: ${file.path}`);
  }
  if (supportedMigrations) {
    const unknown = manifest.schemaMigrations.filter((name) => !supportedMigrations.includes(name));
    if (unknown.length) throw new Error(`Backup schema is newer or incompatible: ${unknown.join(', ')}`);
  }
  await verifySqlite(join(root, 'pideck.sqlite'));
  return manifest;
}

export async function restoreBackup({ backupDirectory, databasePath, sessionDirectory, supportedMigrations }) {
  const manifest = await verifyBackup(backupDirectory, supportedMigrations);
  const targetDb = resolve(databasePath);
  const targetSessions = resolve(sessionDirectory);
  for (const suffix of ['-wal', '-shm']) if (await exists(`${targetDb}${suffix}`)) throw new Error('Restore requires a stopped application with no SQLite sidecars');
  const rollback = `${dirname(targetDb)}/pideck-rollback-${Date.now()}`;
  await mkdir(rollback, { recursive: true, mode: 0o700 });
  if (await exists(targetDb)) await rename(targetDb, join(rollback, 'pideck.sqlite'));
  if (await exists(targetSessions)) await rename(targetSessions, join(rollback, 'sessions'));
  await mkdir(dirname(targetDb), { recursive: true, mode: 0o700 });
  await cp(join(resolve(backupDirectory), 'pideck.sqlite'), targetDb, { errorOnExist: true });
  await cp(join(resolve(backupDirectory), 'sessions'), targetSessions, { recursive: true, errorOnExist: true });
  if (manifest.sessionOwnership?.length) {
    const database = new DatabaseSync(targetDb);
    try {
      const update = database.prepare('UPDATE supervisor_agent_runs SET pi_session_file = ? WHERE id = ?');
      for (const ownership of manifest.sessionOwnership) {
        const sessionFile = resolve(targetSessions, ownership.relativePath);
        if (!inside(targetSessions, sessionFile) || !(await exists(sessionFile))) throw new Error(`Restored Pi session ownership is invalid for run ${ownership.runId}`);
        update.run(sessionFile, ownership.runId);
      }
    } finally { database.close(); }
  }
  await verifySqlite(targetDb);
  return { rollbackDirectory: rollback };
}
