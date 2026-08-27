# Plan 002: Stop paid execution when durable event persistence fails

> **Executor instructions**: Execute exactly; preserve unrelated dirty-tree changes. Update the plan index when done.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- packages/supervisor/src/agent-service.ts packages/supervisor/tests/agent-service.test.ts`
> STOP if `enqueueSessionEvent`, `enqueueEventWork`, or `waitForEvents` no longer match the described semantics.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-durable-run-admission.md`
- **Category**: bug
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

Durable history is the product's source of truth. Current session-event callbacks fire-and-forget persistence, and `waitForEvents` swallows failures. Disk-full or database errors can therefore erase transcript/tool output while the provider keeps consuming tokens and the run later appears completed.

## Current state

`packages/supervisor/src/agent-service.ts:1085-1136`:

```ts
private enqueueSessionEvent(...): void {
  void this.enqueueEventWork(agentId, async () => { ... });
}
...
private async waitForEvents(agentId: string): Promise<void> {
  await this.eventTails.get(agentId)?.catch(() => undefined);
}
```

`finalizeRun` already appends status plus terminal event transactionally; preserve that invariant. Logging uses `sanitizeError` and must never include event payloads or secrets.

## Commands

- `pnpm --filter @pideck/supervisor test -- agent-service.test.ts` → all pass
- `pnpm --filter @pideck/supervisor typecheck` → exit 0
- `pnpm check && pnpm test && pnpm lint` → exit 0

## Scope

**In scope**: `packages/supervisor/src/agent-service.ts`, `packages/supervisor/tests/agent-service.test.ts`.

**Out of scope**: queue byte bounds (plan 011), process-level disk tests (plan 012), changing persisted event schemas.

## Steps

1. Add a per-active-run persistence-failure state and one idempotent handler invoked by rejected session-event work. Do not recursively enqueue the failure handler behind the failed tail.
   - **Verify**: typecheck.
2. On first non-recoverable persistence error: invalidate generation, stop accepting new SDK events, boundedly abort, wait/dispose, and attempt an independent transaction that terminalizes the run as `failed` with `event_persistence_failed`. If even terminal persistence fails, retain an in-memory degraded/fatal state and reject mutating commands with `command_outcome_unknown`; do not claim completion.
   - **Verify**: injected failure test proves abort and disposal occur once.
3. Make `waitForEvents` propagate failure to lifecycle callers. Update completion/cancellation/shutdown paths to handle it explicitly and never overwrite the persistence-failure outcome with `completed`.
   - **Verify**: tests cover completion and cancel races.
4. Ensure logs include run/agent IDs and sanitized error metadata only. Never log event payloads, prompts, tool inputs, or credentials.
   - **Verify**: logger-spy assertion.

## Test plan

Model after existing lifecycle tests in `packages/supervisor/tests/agent-service.test.ts`. Cover a failed ordinary event write, failed terminal write, multiple callback failures, operation completion racing failure, cancellation racing failure, abort rejection, and later commands against a degraded run.

## Done criteria

- [x] A durable event write failure cannot coexist with continuing accepted paid execution.
- [x] A run with missing history is never reported completed.
- [x] Failure handling is idempotent and bounded.
- [x] No sensitive payload is logged.
- [x] Focused tests and typecheck pass; the full test gate is sandbox-blocked on loopback bind.

## STOP conditions

- STOP if the database abstraction cannot inject failures without weakening production encapsulation.
- STOP if terminal failure cannot be persisted; report the proposed operational degraded-state contract.
- STOP if handling would drop events during ordinary `SQLITE_BUSY` retries rather than only after retry exhaustion.

## Maintenance notes

Any future event sink must participate in the same fail-closed policy. Reviewers should scrutinize promise rejection ownership and avoid unhandled rejections or recursive event-tail deadlocks.
