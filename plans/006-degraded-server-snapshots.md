# Plan 006: Preserve active-run visibility during partial server failure

> **Executor instructions**: Preserve unrelated work. Use explicit degraded state; do not hide errors.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/lib/server-connections.ts`

## Status

- **Status**: DONE

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plan 005
- **Category**: bug
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

Bootstrap currently loads agents, runs, projects, and models through one `Promise.all`. A models or projects failure discards the entire server snapshot, hiding active spend and removing monitoring/cancel access even when run endpoints still work. Run and server identity must survive auxiliary degradation.

## Current state

`apps/web/src/App.tsx:680-704` and `:3828-3845` each use:

```ts
const [agentResponse, runResponse, projectResponse, modelResponse] = await Promise.all([
  serverClient.listAgents({ limit: 100 }),
  serverClient.listRuns({ limit: 100 }),
  serverClient.listProjects({ limit: 100 }),
  serverClient.listModels(),
]);
```

`ServerSnapshot` currently assumes all four resources succeeded. Match existing direct operational language in `apps/web/PRODUCT.md`: live state must remain trustworthy under partial supervisor failure.

## Commands

- `pnpm --filter @pideck/web test -- src/App.test.tsx` → pass
- `pnpm --filter @pideck/web typecheck` → pass
- `pnpm check && pnpm test && pnpm lint` → pass

## Scope

**In scope**: `apps/web/src/App.tsx`, `App.test.tsx`, snapshot-related helper types/modules if extracted.

**Out of scope**: visual redesign, pagination (plan 007), new server APIs.

## Steps

1. Replace per-server inner `Promise.all` with independently settled resource loads. Treat runs and server identity as critical; agents/projects/models may be degraded independently.
2. Expand snapshot state with resource-level status/error timestamps. Preserve the last successful value during refresh failure rather than replacing it with empty data.
3. Activate a server snapshot whenever server identity is known, even if one resource fails. Keep active runs visible and cancel/stream controls available when their endpoints work.
4. Show a concise per-server degraded warning identifying failed resources and a targeted retry. Do not use one global error that implies all run data is unavailable.
5. Deduplicate bootstrap and Settings refresh logic into one tested helper so semantics cannot drift.

## Test plan

Add table-driven tests for each single endpoint failing, runs failing while models succeed, multiple failures, refresh retaining prior runs, later recovery, route restoration under model failure, and cancellation while projects are degraded.

## Done criteria

- [x] Auxiliary endpoint failure never removes known active runs.
- [x] Last-known data is visibly marked stale, not presented as live.
- [x] Resource retry can recover without app reload.
- [x] Duplicate bootstrap/refresh aggregation is removed.
- [x] Focused gates pass; the full suite reaches one sandbox-blocked loopback-listen test.

## STOP conditions

- STOP if `ServerSnapshot` is consumed outside `App.tsx` in a way requiring a public contract change.
- STOP if active controls cannot be safely enabled without agent data; document exact dependency.

## Maintenance notes

Future endpoints must declare whether they are critical or auxiliary. Fleet truth should degrade by resource, never all-or-nothing by server.
