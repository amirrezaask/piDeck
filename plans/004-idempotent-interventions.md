# Plan 004: Make run creation, steer, follow-up, and cancellation retry-safe

> **Executor instructions**: Preserve unrelated changes. Use the existing receipt model; do not create a second deduplication system.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- apps/web/src/App.tsx apps/web/src/lib/supervisor-client.ts packages/supervisor/src/agent-service.ts packages/contracts/src/supervisor-agent.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plan 001
- **Category**: bug
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

The server already supports durable idempotency receipts, but the renderer sends no key for normal create/steer/follow-up operations. When the supervisor accepts a paid command but its HTTP response is lost, a user retry can spend tokens twice. One logical submission must retain one stable key until its outcome is reconciled.

## Current state

- `apps/web/src/App.tsx:941` calls `client.createRun(input)` without a key.
- `App.tsx:1043-1066` sends steer/follow-up bodies without `idempotencyKey`.
- `apps/web/src/lib/supervisor-client.ts:304-309` forwards request bodies unchanged.
- `packages/supervisor/src/agent-service.ts:1204-1254` implements receipt creation/replay.

## Commands

- `pnpm --filter @pideck/web test -- src/lib/supervisor-client.test.ts src/App.test.tsx` → pass
- `pnpm --filter @pideck/supervisor test -- agent-http.test.ts agent-service.test.ts` → pass
- `pnpm check && pnpm test && pnpm lint` → pass

## Scope

**In scope**: renderer client/App and tests; supervisor receipt reconciliation/tests; contracts only if a receipt lookup shape is absent.

**Out of scope**: automatic generic HTTP retries, storing prompt/attachment bytes in localStorage, changing command payload limits.

## Steps

1. Define one client-side submission object containing stable UUID, command kind, target, request digest, created time, and UI state. Generate it once when the user submits, not per network attempt.
2. Send that UUID as the existing `idempotencyKey` for run creation, steer, follow-up, and cancel. Ensure Electron bridge allowlists the existing `idempotency-key` header or body shape without exposing tokens.
3. Preserve an uncertain submission in memory and session-scoped storage after network/5xx failure; disable blind duplicate submission and offer/reuse the same key for retry. Persist text metadata only; do not persist image base64 or secrets.
4. Add or use a receipt-status endpoint so `idempotency_in_progress` and lost responses can be reconciled to succeeded/failed/unknown. On reconnect, resolve uncertain submissions before enabling another logical command.
5. Clear the draft only after a succeeded receipt. Preserve draft/attachments on definitive failure and uncertain outcomes.

## Test plan

Cover accepted-then-response-lost for each command, retry with same key, changed payload with same key conflict, app rerender/reconnect reconciliation, pending receipt, failed receipt, and no duplicate session method call. Model server tests after `packages/supervisor/tests/agent-http.test.ts:217-260`.

## Done criteria

- [ ] One UI submission maps to one durable idempotency key.
- [ ] Lost responses cannot cause duplicate Pi calls or token spend.
- [ ] Uncertain outcomes are shown explicitly and reconciled.
- [ ] Drafts clear only on durable success.
- [ ] Focused/full gates pass.

## STOP conditions

- STOP if receipt rows cannot be queried without exposing request contents; add only status/result metadata.
- STOP if a solution requires persisting attachment data in browser storage.
- STOP if server command digests are not stable for semantically identical retries.

## Maintenance notes

Keys identify logical user intent, not HTTP attempts. Any new token-spending command must require an idempotency key from the renderer and receive an accepted-then-disconnected regression test.
