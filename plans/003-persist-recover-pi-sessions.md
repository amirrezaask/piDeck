# Plan 003: Persist and recover Pi session ownership across restarts

> **Executor instructions**: This is a high-risk storage/lifecycle change. Follow all steps; do not invent provider-resume semantics. Preserve unrelated working-tree changes.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- packages/supervisor/src/agent-service.ts packages/supervisor/src/pi-session.ts packages/database/src/schema.ts packages/database/src/migrations.ts packages/database/migrations packages/supervisor/tests`
> STOP if Pi SDK session APIs differ from the assumptions below.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans 001 and 002
- **Category**: architecture
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

The supervisor creates JSONL-backed Pi sessions but does not persist their IDs/files on run records. On startup it intentionally marks every queued/running run failed, so a restart loses the ability to continue the same context even when the Pi session file survived. Recovery must avoid both duplicate model execution and falsely claiming control over an operation that cannot be reattached.

## Current state

- `packages/supervisor/src/agent-service.ts:237-248` says sessions are process-local and are not reconstructed.
- `packages/supervisor/src/pi-session.ts:23-41` exposes `sessionId` and `sessionFile`.
- `SdkPiSessionFactory.create` uses `SessionManager.create(...)` at `pi-session.ts:193-202`, but the factory exposes no resume method.
- Migrations are registered explicitly in `packages/database/src/migrations.ts`; copy existing migration style and add the next monotonic migration after 013.

## Commands

- `pnpm --filter @nextflow/database test` → all pass
- `pnpm --filter @pideck/supervisor test` → all pass
- `pnpm check && pnpm test && pnpm lint && pnpm format:check` → exit 0

## Suggested executor toolkit

Read the installed Pi SDK documentation and type declarations for `SessionManager`, session-file loading, and `createAgentSession` before coding. Use the repository's Effect patterns only if Effect is actually present; do not introduce it.

## Scope

**In scope**:
- `packages/database/migrations/014_pi_session_ownership.ts` (new)
- `packages/database/src/migrations.ts`, `packages/database/src/schema.ts`
- `packages/supervisor/src/pi-session.ts`, `packages/supervisor/src/agent-service.ts`
- relevant database and supervisor tests
- contracts only if a session-recovery status must be exposed

**Out of scope**:
- Provider-specific remote-request cancellation APIs
- Importing package internals; obey `packages/README.md`
- Automatically replaying a prompt whose acceptance is uncertain

## Steps

1. Inspect the exact Pi SDK resume API and write a short design comment in the test describing what can and cannot be reattached after process death. If active network execution cannot be reattached, recovery must mark it `interrupted`/failed without replay, while still allowing later continuation from the persisted session file.
2. Add migration 014 columns to run records for Pi session ID, canonical session file, ownership generation/process instance, and recovery state/timestamp as required. Add constraints/triggers so session identity cannot point to another run. Never store provider credentials.
   - **Verify**: migration applies to empty and 013-populated databases.
3. Extend `PiSessionFactory` with an explicit `resume` operation whose input is the persisted session file/ID and expected cwd. Validate the file resides under the configured session directory and matches the durable run/cwd before opening it.
   - **Verify**: factory tests reject missing, outside-root, malformed, or mismatched sessions.
4. During `startRun`, persist session identity before prompt submission. If identity persistence fails, abort/dispose and compensate using plan 001's policy.
   - **Verify**: test proves no prompt is issued before durable identity.
5. Replace blanket startup failure with reconciliation: queued-without-session rows fail safely; running rows with valid session files become recoverable/interrupted without replay; completed rows may be resumed for follow-up from their saved session. Never replay the last prompt automatically.
   - **Verify**: restart test continues a completed session with prior context exactly once.
6. Ensure cancellation/control endpoints return a truthful unavailable/uncertain result for pre-crash execution that cannot be reattached, while follow-up is enabled only after session reconstruction succeeds.

## Test plan

Add migration round-trip tests and fake/real-session integration tests covering: identity persisted before prompt, restart after completion then follow-up, restart during queued/running state, missing/corrupt/moved session file, cwd mismatch, duplicate recovery attempts, no prompt replay, and shutdown/restart idempotency.

## Done criteria

- [x] Every created Pi session is durably associated with exactly one run before paid prompt submission.
- [x] Completed sessions can be reconstructed for follow-up after restart when the SDK supports it.
- [x] Interrupted requests are never silently replayed.
- [x] Missing/corrupt session files produce explicit durable recovery state.
- [x] Migration and focused supervisor gates pass; the full test gate is sandbox-blocked on loopback bind.

## STOP conditions

- STOP if the Pi SDK has no supported API for loading a specific session file; report this and propose an upstream/API adapter rather than parsing JSONL manually.
- STOP if safe recovery requires persisting provider credentials.
- STOP if existing migration 014 appears after drift.

## Maintenance notes

Session-file format belongs to Pi, not piDeck. Keep the adapter narrow and test against the pinned Pi version. Future Pi upgrades must run recovery compatibility tests before release.
