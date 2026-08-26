# Plan 008: Enforce configured service authentication on loopback requests

> **Executor instructions**: This is a security boundary. Do not preserve insecure compatibility silently.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- apps/server/src/main.ts packages/supervisor/src/app.ts packages/supervisor/tests`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

The standalone server requires a token in configuration but bypasses it for every loopback HTTP caller. Any local process can read prompts/history or create/cancel paid work. A configured token must always take precedence; unauthenticated loopback is a separate explicit mode only when no token exists.

## Current state

- `apps/server/src/main.ts:23-30` passes both `serviceToken` and `allowUnauthenticatedLoopback: true`.
- `packages/supervisor/src/app.ts:391-405` checks the loopback bypass before the service token.
- The Electron embedded server does not opt into unauthenticated loopback and must remain authenticated.

## Commands

- `pnpm --filter @pideck/supervisor test -- agent-http.test.ts agent-websocket.test.ts` → pass
- `pnpm --filter @pideck/server typecheck` → pass
- `pnpm check && pnpm test && pnpm lint` → pass

## Scope

**In scope**: standalone main, supervisor auth hook/upgrade auth, tests, `.env.example`/README only if behavior documentation changes.

**Out of scope**: user accounts, multi-tenant authorization, token rotation protocol.

## Steps

1. Define precedence: when `serviceToken` is non-empty, every protected HTTP and WebSocket request requires it/ticket regardless of peer address. Only when no token exists and explicit loopback mode is true may loopback bypass authentication.
2. Reorder HTTP and WebSocket auth logic to enforce the same rule. Keep `/v1/health` public only if intentionally documented.
3. Remove `allowUnauthenticatedLoopback: true` from standalone startup because standalone already requires a token; alternatively retain it only as inert defense with a test proving token precedence.
4. Add loopback injection/upgrade tests for missing, wrong, and correct token and ticket.

## Test plan

Test token+loopback, token+remote, no-token+explicit-loopback, no-token+remote, WebSocket ticket issuance, and direct WebSocket bearer auth. Assert protected mutation/history routes reject unauthenticated localhost.

## Done criteria

- [ ] Configured token is mandatory on loopback and remote peers.
- [ ] HTTP and WebSocket policies match.
- [ ] No token value appears in logs/tests/docs.
- [ ] Focused/full gates pass.

## STOP conditions

- STOP if existing browser development depends on token bypass; replace it with an explicit dev credential, not a production bypass.
- STOP if proxy address trust is introduced; that requires a separate trusted-proxy design.

## Maintenance notes

Keep authentication and authorization server-side. Localhost is a transport location, not an identity boundary.
