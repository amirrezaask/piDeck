# Plan 010: Make migration 013 rollback and reapply safely

> **Executor instructions**: Work only against disposable test databases. Never run rollback commands against the user's `data/pideck.sqlite`.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- packages/database/migrations/013_workspace_capabilities.ts packages/database/src/schema.ts packages/database/src/migrations.ts packages/database/tests/database.test.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: migration
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

Migration 013 adds three run columns, but its `down` drops only new tables. Kysely then records the migration as rolled back even though the columns remain; the next `up` fails on duplicate columns. This blocks recovery from a bad release and means current metadata-only rollback tests provide false confidence.

## Current state

- `packages/database/migrations/013_workspace_capabilities.ts:5-14` unconditionally adds `execution_mode`, `worktree_id`, and `parent_run_id`.
- `:75-80` intentionally leaves them behind.
- `packages/database/tests/database.test.ts:133-154` checks migration status but not physical schema or rollback→reapply.

## Commands

- `pnpm --filter @nextflow/database test` → all pass
- `pnpm --filter @nextflow/database typecheck` → pass
- `pnpm check && pnpm test && pnpm lint` → pass

## Scope

**In scope**: migration 013, database migration tests, schema type only if required for test helpers.

**Out of scope**: modifying an existing user database manually, squashing migrations, renumbering 013.

## Steps

1. Add on-disk migration tests that migrate through 013, insert representative projects/runs/worktrees/inbox/terminal rows, roll back 013, inspect `PRAGMA table_info/index_list/foreign_key_list`, reapply 013, and verify preserved pre-013 data.
2. Choose one safe strategy based on supported SQLite runtime:
   - Preferred: rebuild `supervisor_agent_runs` in `down` to the exact 012 schema inside the migration transaction, preserving all 012 columns/data/indexes/triggers.
   - Acceptable only with documented policy: make `up` detect compatible leftover columns and validate exact type/default/nullability before skipping them, so rollback/reapply is operationally symmetric even if columns remain.
3. Restore/drop every index and trigger affected by the table rebuild. Re-enable/verify foreign keys after migration.
4. Add explicit incompatible-leftover-schema failure; never silently accept wrong column definitions.
5. Extend the test to rollback all migrations and migrate to latest again on a temporary file.

## Test plan

Use a temporary on-disk database, not only `:memory:`. Cover populated database, null/non-null new fields, child rows, rollback→reapply, all-down→all-up, integrity check, foreign-key check, and interrupted transaction rollback.

## Done criteria

- [ ] 013 down then up succeeds on populated data.
- [ ] Physical schema matches declared migration status.
- [ ] `PRAGMA integrity_check` returns `ok`; `foreign_key_check` returns no rows.
- [ ] No production/user DB is touched.
- [ ] Focused/full gates pass.

## STOP conditions

- STOP if the exact 012 table schema cannot be reconstructed from migrations.
- STOP if rollback would discard non-null 013 data without an explicit product decision.
- STOP if SQLite DDL is observed to auto-commit outside the migrator transaction.

## Maintenance notes

Every future migration test must verify physical schema and forward-after-rollback, not only Kysely metadata.
