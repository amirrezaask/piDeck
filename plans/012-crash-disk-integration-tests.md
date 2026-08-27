# Plan 012: Add real crash, restart, and disk-write-failure integration tests

> **Executor instructions**: Tests must use temporary directories/processes. Never point them at repository `data/` or the user's Pi session directory.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- packages/supervisor packages/database packages/test-agents package.json turbo.json`

## Status

- **State**: Implemented and verified 2026-08-27
- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans 001, 002, 003, 010
- **Category**: tests
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

Most current lifecycle tests run services in-process and database tests primarily use memory databases. They do not prove WAL recovery, process death between admission phases, session reconstruction, or truthful behavior after writes fail. These are the exact failure modes that can orphan token spend or history.

## Current state

- Supervisor test structure lives under `packages/supervisor/tests` and uses fake Pi sessions.
- Database migration tests are in `packages/database/tests/database.test.ts`.
- `packages/test-agents` provides deterministic agents suitable for subprocess fixtures.
- Root `pnpm test` runs Turbo package tests.

## Commands

- New integration command, e.g. `pnpm test:recovery` → exit 0
- `pnpm test` → includes or depends on recovery tests as appropriate
- `pnpm check && pnpm lint && pnpm format:check` → pass

## Scope

**In scope**:
- `tests/recovery/**` or `packages/supervisor/tests/recovery/**` (new)
- a dedicated test fixture executable under `packages/test-agents` or `packages/supervisor/tests/fixtures`
- package/root scripts and test config
- minimal injectable filesystem/database fault adapter if production code otherwise cannot be tested

**Out of scope**: real paid provider calls, user databases, nondeterministic network dependencies.

## Steps

1. Create a child-process supervisor fixture using temporary database and Pi-session directories plus deterministic fake sessions. Expose control hooks over IPC/stdin only in the test fixture, not production HTTP.
2. Add kill-point tests at: before run insert, after queued commit, after Pi session identity commit, after prompt preflight, after running commit, during event write, after provider completion before terminal event, and during graceful shutdown.
3. Restart a fresh process on the same temporary directories after each forced kill. Assert DB integrity, one run/session owner, no prompt replay, truthful terminal/recoverable status, contiguous event sequence, and valid follow-up where supported.
4. Add real SQLite lock tests with two connections/processes and exhausted `SQLITE_BUSY` retries.
5. Add disk-write failure cases using a deterministic database adapter fault or supported filesystem mechanism. Avoid chmod-only tests as the sole method because root/Windows semantics differ. Cover admission write, ordinary event write, terminal write, and migration write.
6. Verify WAL sidecars/checkpoint behavior by closing/reopening and running `PRAGMA integrity_check` and `foreign_key_check`.
7. Make failures produce diagnostic artifacts containing IDs/statuses only—never prompts, event payloads, or credentials.

## Test plan

Each kill/failure point is its own named test with bounded timeout and guaranteed process cleanup. Run cases serially where they share lock timing. Repeat the race-heavy subset multiple times locally without flakes.

## Done criteria

- [x] Tests use real on-disk SQLite and separate OS processes.
- [x] All eight lifecycle-specific supervisor kill points recover without prompt replay.
- [x] Admission, ordinary-event, terminal, and migration write failures are injected deterministically without chmod-only behavior.
- [x] No test can touch non-temporary data.
- [x] Every long-lived child process is released or killed in `finally`.
- [x] `pnpm test:recovery` and the repository-wide test suite pass.

## STOP conditions

- STOP if a fault method could affect the user's filesystem/database.
- STOP if tests need provider credentials or internet.
- STOP if process cleanup is not reliable on macOS, Linux, and Windows; add platform abstraction before proceeding.

## Maintenance notes

Add new lifecycle commit points to this matrix. Keep the fixture protocol private to tests and deterministic enough for CI.
