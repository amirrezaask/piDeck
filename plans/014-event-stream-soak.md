# Plan 014: Add a sustained multi-agent event-stream soak test

> **Executor instructions**: Keep the test deterministic, bounded, and provider-free. Record objective budgets; do not rely on visual judgment.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- packages/supervisor apps/web tests package.json`

## Status

- **State**: Implemented and verified in three consecutive local CI-profile runs

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans 005, 011, 012
- **Category**: tests
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

Short unit tests do not reveal promise-backlog growth, replay drift, listener leaks, or renderer O(n²) behavior. A daily driver supervising a fleet needs evidence that hours of events and reconnects remain bounded and truthful.

## Current state

- Supervisor streams replay from durable per-agent sequences and bound WebSocket queued bytes.
- Renderer stream logic lives in `apps/web/src/lib/supervisor-client.ts`; selected-run state/rendering lives in `App.tsx` and transcript helpers.
- No current soak command or performance budget exists.

## Commands

- New `pnpm test:soak` → deterministic pass under documented local budget
- Optional shorter CI mode `pnpm test:soak:ci` → pass in bounded minutes
- Full baseline commands → pass

## Scope

**In scope**: soak fixture/test, metrics helpers, package scripts, minimal production instrumentation exposed only as internal metrics/hooks.

**Out of scope**: paid providers, external network, benchmark marketing claims, arbitrary sleeps as assertions.

## Steps

1. Define checked-in budgets for event loss (zero), duplicates after dedupe (zero), ordering gaps (zero), maximum supervisor queue bytes/count, renderer retained event window, reconnect recovery time, process heap growth after warm-up, open handles, and test duration. Choose values from measurements after plan 011, not guesses; document hardware-normalized metrics where needed.
2. Build a deterministic fake Pi session that emits mixed text/tool/large bounded events for at least 25 concurrent agents and at least 100k aggregate events in CI mode. Include completed, cancelled, and long-running runs.
3. Force periodic WebSocket disconnects, ticket failures, slow-consumer closures, renderer route switches, history paging, and one supervisor restart using the recovery fixture.
4. Assert every durable event is retrievable in sequence, client cursors converge, active statuses match DB state, and intervention/cancel latency remains under the defined bound.
5. Sample process/renderer heap and open handles after warm-up and after forced GC only when the runtime exposes it in the test process; otherwise use retained collection sizes and RSS trend. Fail on monotonic unbounded growth beyond tolerance.
6. Emit a concise JSON summary artifact on success/failure without event payloads.
7. Provide a longer local/nightly profile and a shorter required CI profile sharing the same logic.

## Test plan

Run CI profile repeatedly; include slow database, burst traffic, one 256 KiB event, duplicate replay, sequence gap injection (must fail visibly), aborted clients, reconnect churn, and cache eviction.

## Done criteria

- [x] CI profile processes at least 100k events across at least 25 agents.
- [x] Production WebSocket reconnect, supervisor restart, and duplicate-intervention paths are exercised.
- [x] Zero missing durable events, duplicates, or ordering gaps are derived from durable SQLite reads.
- [x] All queue/cache/memory and duration budgets are asserted.
- [x] Test runtime is bounded and open-handle growth is asserted.
- [x] `pnpm test:soak:ci` passes three consecutive runs.

## STOP conditions

- STOP if budgets cannot be measured reproducibly; provide proxy metrics rather than flaky wall-clock assertions.
- STOP if test requires `--expose-gc` in the production Electron binary.
- STOP if payload content would be written to CI artifacts.

## Maintenance notes

Update workload mix when new event types or fleet features ship. Budget increases require measured justification in review.
