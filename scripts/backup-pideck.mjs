import { readFile } from 'node:fs/promises';
import {
  createBackup,
  restoreBackup,
  SUPPORTED_SCHEMA_MIGRATIONS,
  verifyBackup,
} from './lib/pideck-backup.mjs';

const [command, ...args] = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const required = (name) => { const result = value(name); if (!result) throw new Error(`Missing ${name}`); return result; };
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (command === 'create') {
  const manifest = await createBackup({ databasePath: required('--database'), sessionDirectory: required('--sessions'), destination: required('--destination'), appVersion: packageJson.version });
  console.log(`Backup verified: ${manifest.files.length} files`);
} else if (command === 'verify') {
  const manifest = await verifyBackup(required('--backup'), SUPPORTED_SCHEMA_MIGRATIONS);
  console.log(`Backup verified: ${manifest.files.length} files`);
} else if (command === 'restore') {
  const result = await restoreBackup({
    backupDirectory: required('--backup'),
    databasePath: required('--database'),
    sessionDirectory: required('--sessions'),
    supportedMigrations: SUPPORTED_SCHEMA_MIGRATIONS,
  });
  console.log(`Restore verified; rollback copy: ${result.rollbackDirectory}`);
} else throw new Error('Usage: backup-pideck.mjs create|verify|restore [options]');
