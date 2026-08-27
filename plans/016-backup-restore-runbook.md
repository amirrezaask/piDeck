# Plan 016: Document and verify SQLite and Pi-session backup/restore

> **Executor instructions**: Test only on temporary fixture data. Never copy, inspect, or publish the user's actual database, prompts, tokens, or session files.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- README.md docs scripts packages/supervisor/src/app.ts apps/client/src/main.ts`

## Status

- **State**: Implemented and fixture-tested

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans 003, 010, 012
- **Category**: docs
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

Prompts, events, attachments, and Pi session files are sensitive durable state. The README warns about sensitivity but provides no safe backup, restore, integrity, version-compatibility, or disaster-recovery procedure. A daily-driver user needs a tested way to recover without copying an inconsistent WAL database or replaying paid work.

## Current state

- Electron database: `app.getPath('userData')/data/pideck.sqlite` in `apps/client/src/main.ts:startBuiltinServer`.
- Default Pi sessions: sibling `pi-sessions` directory derived in `packages/supervisor/src/app.ts:163-168`.
- Standalone paths are controlled by `NEXTFLOW_DATABASE_PATH` and `NEXTFLOW_PI_SESSION_DIR`.
- README currently says to treat SQLite/session data as sensitive but has no runbook.

## Commands

- New `pnpm test:backup-restore` → fixture backup/restore succeeds
- `pnpm check && pnpm test && pnpm lint && pnpm format:check` → pass
- Markdown link/check command if added → pass

## Scope

**In scope**:
- `docs/backup-and-recovery.md` (new)
- README link/summary
- `scripts/backup-pideck.mjs`, `scripts/verify-pideck-backup.mjs`, or equivalent safe helpers if needed
- tests using temporary data

**Out of scope**: cloud backup vendor integration, encrypting the primary live database, exposing backup contents through HTTP.

## Steps

1. Specify supported consistency modes:
   - Preferred online backup via SQLite's supported backup API while supervisor owns the DB, if the runtime adapter exposes it safely.
   - Otherwise documented quiesced backup: stop Electron/standalone server cleanly, verify no process owns the DB, then copy the database plus Pi session directory. Do not recommend copying only the main DB while WAL writes are active.
2. Implement a safe helper if it materially reduces operator error. It must refuse destination=source, create a versioned manifest with app/schema versions and relative file hashes, use restrictive permissions, exclude server-token config by default, and never print contents.
3. Document Electron and standalone path discovery without guessing; include macOS/Windows/Linux notes and environment overrides. State that backups contain source code, prompts, attachments, and possibly credentials embedded in conversations.
4. Document restore into a stopped application: preserve the existing destination as rollback copy, verify manifest/hashes, validate SQLite `integrity_check`/`foreign_key_check`, verify session files remain under the configured root, then launch the same or compatible app version and allow migrations once.
5. Document rollback after failed restore, lost/corrupt session files, newer-schema backup on older app, and interrupted runs. Explicitly state that uncertain pre-crash prompts are never automatically replayed.
6. Add a fixture test that creates agents/runs/events/session files, backs up, deletes the fixture, restores, verifies hashes/integrity/history/session continuation, and proves source data is unchanged.
7. Add a periodic restore-drill checklist and retention guidance. Recommend encrypted storage and access controls without prescribing a vendor.

## Test plan

Temporary fixture cases: clean quiesced backup, active-WAL refusal or supported online snapshot, tampered hash, wrong schema version, missing session file, destination collision, paths with spaces, restrictive permissions where supported, and full restore followed by supervisor startup.

## Done criteria

- [x] README links a complete tested runbook.
- [x] Procedure captures DB/WAL consistency and Pi session files together.
- [x] Restore verifies hashes, SQLite integrity, foreign keys, schema compatibility, and session paths.
- [x] Helper/test never accesses real user paths or logs content.
- [x] `pnpm test:backup-restore` passes; full gates are recorded in the implementation handoff.

## STOP conditions

- STOP if the SQLite runtime lacks an online backup API and the app cannot be reliably quiesced; do not document unsafe live copying.
- STOP if restore would downgrade a newer schema destructively.
- STOP if a helper would include encrypted server-token config without explicit opt-in and documentation.

## Maintenance notes

Run a restore drill before each schema-changing release. Update path/schema/session compatibility notes whenever migrations or Pi SDK session format changes.
