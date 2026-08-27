# Plan 007: Load all active runs and provide complete historical navigation

> **Executor instructions**: Preserve unrelated work and retain bounded startup behavior.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- apps/web/src/App.tsx apps/web/src/lib/supervisor-client.ts apps/web/src/App.test.tsx apps/web/src/lib/supervisor-client.test.ts`

## Status

- **Status**: DONE

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plan 006
- **Category**: bug
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

The API is cursor-paginated, but bootstrap requests only 100 agents/runs and discards `nextCursor`. A long-running older run can fall behind newer fleet activity and disappear from navigation. Active runs must always load; historical runs need explicit complete pagination/search without unbounded startup fetches.

## Current state

- `apps/web/src/App.tsx:683-687` and `:3831-3835` request `{ limit: 100 }` once.
- `apps/web/src/lib/supervisor-client.ts` exposes the response cursor but does not provide an iterator/helper for all pages.
- Server ordering is newest first in `packages/supervisor/src/agent-service.ts:listRuns`.

## Commands

- `pnpm --filter @pideck/web test -- src/lib/supervisor-client.test.ts src/App.test.tsx` → pass
- `pnpm check && pnpm test && pnpm lint` → pass

## Scope

**In scope**: web client/App/tests; supervisor list endpoint only if there is no efficient status-filtered active-run query.

**Out of scope**: loading every event for every run, redesigning the sidebar, changing cursor encoding.

## Steps

1. Add tested page-iteration helpers that detect non-advancing/repeated cursors and support abort/max-page safety.
2. Bootstrap all non-terminal runs independently using existing `status` filtering. If the current API supports one status only, either request each active status (`queued`, `running`) or add a bounded `active=true` query contract with schema/tests.
3. Load only the first historical page initially, merge active runs by ID, and expose “load more”/search for history. Route restoration for a known run ID should fetch that run directly even if not loaded in pages.
4. During server refresh, retain loaded pages and merge updates without duplicates or reordering active runs incorrectly.
5. Add loading/end/error states and keyboard-accessible load-more behavior.

## Test plan

Cover 250 runs, an old active run beyond page one, duplicate IDs across active/history fetches, repeated cursor defense, abort, route to unloaded run, load-more failure retaining prior pages, and end-of-list.

## Done criteria

- [x] Every active run is visible regardless of historical page position.
- [x] Any run URL can restore via direct fetch.
- [x] History pagination is bounded and cursor-safe.
- [x] No duplicate runs appear.
- [x] Focused gates pass; the full suite reaches one sandbox-blocked loopback-listen test.

## STOP conditions

- STOP if server status filtering cannot represent all active statuses without contract changes; specify the smallest contract addition.
- STOP if pagination would eagerly fetch unbounded history at startup.

## Maintenance notes

When new active states are introduced, update the active query and tests. Keep event loading lazy per selected run.
