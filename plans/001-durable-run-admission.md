# Plan 001: Make accepted-run admission durable and compensating

> **Executor instructions**: Follow every step and verification gate. Preserve unrelated uncommitted work. Update `plans/README.md` when done unless a reviewer owns the index.
>
> **Drift check (run first)**: `git diff --stat e1a8022..HEAD -- packages/supervisor/src/agent-service.ts packages/supervisor/tests/agent-service.test.ts`
> Compare the current `startRun` preflight and queued-to-running transition with the excerpts below. STOP on semantic drift.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

Pi can accept and begin a paid prompt before the database transition from `queued` to `running` commits. Today a transient SQLite failure rejects the API path but leaves the Pi operation active and the durable row queued. Admission must either become durably `running` or abort/dispose and atomically terminalize the run as an uncertain/failed admission.

## Current state

- `packages/supervisor/src/agent-service.ts:997-1021` races preflight against prompt settlement, then performs a bare update:

```ts
if (accepted && active.generation === generation) {
  const result = await this.db
    .updateTable('supervisor_agent_runs')
    .set({ status: 'running', started_at: this.now() })
    .where('id', '=', runId)
    .where('status', '=', 'queued')
    .executeTakeFirst();
```

- Event finalization already uses `withBusyRetry` plus compare-and-set in `finalizeRun` around `packages/supervisor/src/agent-service.ts:1360-1405`; match that convention.
- Tests use deterministic fake sessions in `packages/supervisor/tests/agent-service.test.ts`.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `pnpm --filter @pideck/supervisor test -- agent-service.test.ts` | exit 0 |
| Typecheck | `pnpm --filter @pideck/supervisor typecheck` | exit 0 |
| Full baseline | `pnpm check && pnpm test && pnpm lint` | exit 0 |

## Scope

**In scope**:
- `packages/supervisor/src/agent-service.ts`
- `packages/supervisor/tests/agent-service.test.ts`
- `packages/database/src/retry.ts` only if the existing retry API cannot classify exhaustion

**Out of scope**:
- Session restart/resume behavior (plan 003)
- Renderer retries (plan 004)
- Public HTTP response-shape changes

## Steps

1. Add deterministic fault injection to the test fixture so the queued-to-running update can fail with a retryable busy error and with a non-retryable write error after prompt preflight succeeds.
   - **Verify**: focused test command runs the new tests and demonstrates the current failure before the production change.
2. Route the queued-to-running compare-and-set through `withBusyRetry`. Treat zero updated rows as a lost admission race, not success.
   - **Verify**: retryable-busy test shows exactly one Pi prompt and a final `running` row.
3. Add compensation for exhausted/non-retryable transition failures: invalidate the generation, attempt a bounded abort, wait boundedly for operations/events, atomically finalize the row with a stable public error code such as `run_admission_persistence_failed`, and dispose exactly once. Preserve the original error only in sanitized logs.
   - **Verify**: fault test proves no active session remains, the row is terminal, and one terminal event exists after all SDK events.
4. Ensure the command receipt is completed only after durable admission and failed deterministically after compensation; no receipt may remain `pending` on a handled failure.
   - **Verify**: add receipt assertions and rerun focused tests.

## Test plan

Add cases to `agent-service.test.ts` for retry then success, permanent transition failure, abort failure during compensation, cancellation racing compensation, one terminal event, no queued/running orphan, and single disposal.

## Done criteria

- [ ] No accepted prompt can leave a queued row with an active session.
- [ ] Retryable busy errors retry without duplicate prompts.
- [ ] Permanent failures terminalize and dispose exactly once.
- [ ] Focused and repository-wide commands pass.
- [ ] Only in-scope files plus `plans/README.md` changed.

## STOP conditions

- STOP if Pi's preflight callback does not mean the request can consume provider tokens.
- STOP if compensation requires changing public schemas; report the proposed schema first.
- STOP if a test cannot deterministically inject the transition failure without production-only hooks.

## Maintenance notes

Review ordering between preflight, status transition, event persistence, receipt completion, and disposal. Future admission states must retain the invariant: paid execution implies a durable non-terminal run row.
