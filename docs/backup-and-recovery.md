# Backup and recovery

piDeck backups contain prompts, source snippets, attachments, tool data, and Pi session history. Store them encrypted with access limited to the same people who may access the source repositories.

## Create a consistent backup

Stop the desktop app or standalone server cleanly first. The helper deliberately supports only quiesced backups and refuses a database with `-wal` or `-shm` sidecars. It never reads the default application directory implicitly and excludes `servers.json` and its encrypted server tokens.

Electron stores data beneath `app.getPath('userData')`: the database is `data/pideck.sqlite` and sessions are `data/pi-sessions`. Typical user-data roots are `~/Library/Application Support/piDeck` on macOS, `%APPDATA%\piDeck` on Windows, and `~/.config/piDeck` on Linux; confirm the path for the installed build rather than guessing. A standalone server uses `NEXTFLOW_DATABASE_PATH`; its session directory is `NEXTFLOW_PI_SESSION_DIR` or the `pi-sessions` sibling of the database.

```sh
node scripts/backup-pideck.mjs create \
  --database "/confirmed/stopped/data/pideck.sqlite" \
  --sessions "/confirmed/stopped/data/pi-sessions" \
  --destination "/encrypted-backups/pideck-2026-08-27"
node scripts/backup-pideck.mjs verify --backup "/encrypted-backups/pideck-2026-08-27"
```

The versioned manifest records the app version, schema migrations, relative paths, sizes, and SHA-256 hashes. Directories and manifests use restrictive permissions where the OS supports them. Never copy only the main SQLite file while the app is running.

## Restore

Use the same app version as the backup or a newer compatible version. Never restore a backup containing migrations unknown to the target version.

1. Stop piDeck and confirm no process owns the database.
2. Verify the backup before changing the destination.
3. Restore with explicit paths. Existing data is moved into a timestamped rollback directory.
4. The helper verifies hashes, `integrity_check`, and `foreign_key_check` before and after copying. Session paths in the manifest must remain beneath the backup root.
5. Start piDeck once and let forward migrations complete. Confirm history and one existing session before starting new work.

```sh
node scripts/backup-pideck.mjs restore \
  --backup "/encrypted-backups/pideck-2026-08-27" \
  --database "/confirmed/stopped/data/pideck.sqlite" \
  --sessions "/confirmed/stopped/data/pi-sessions"
```

If startup or verification fails, stop the app, move the restored database and sessions aside, and move the contents of the reported rollback directory back to their original locations. Do not downgrade or force migrations. Missing or corrupt session files can leave durable history readable but prevent continuation. Interrupted runs are recovered as interrupted; uncertain pre-crash prompts are never replayed automatically.

## Restore drill

Before every schema-changing release and at least quarterly: create a quiesced fixture backup, verify it, restore it into an empty temporary location, start the matching release against it, inspect history/session continuation, record duration, then delete the plaintext drill copy. Keep multiple generations under an explicit retention policy and periodically test the oldest retained compatible generation.
