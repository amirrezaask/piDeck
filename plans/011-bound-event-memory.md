# Plan 011: Bound event ingestion, retained transcript memory, and render work

> **Executor instructions**: Preserve durable history. Never solve memory pressure by silently dropping authoritative persisted events.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- packages/supervisor/src/agent-service.ts packages/supervisor/src/app.ts apps/web/src/App.tsx apps/web/src/lib/transcript.ts packages/supervisor/tests apps/web/src`

## Status

- **State**: Implemented 2026-08-27
- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans 002 and 005
- **Category**: perf
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

Every SDK callback appends an unbounded promise chain. The renderer retains every selected-run event and performs copy+Map+sort over the full history for each new event, then renders the entire transcript. Long or high-volume runs can exhaust memory or make cancel/steer controls unresponsive precisely when live supervision matters.

## Current state

- `packages/supervisor/src/agent-service.ts:1085-1132` has one tail promise per agent but no queued count/bytes.
- `apps/web/src/App.tsx:807-835` merges every event into React state.
- `App.tsx:5399-5405` rebuilds and sorts all events for each merge.
- The server WebSocket already closes slow consumers at a bounded queued-byte threshold in `packages/supervisor/src/app.ts:318-346`; match its explicit-overflow philosophy.

## Commands

- Supervisor focused tests → `pnpm --filter @pideck/supervisor test`
- Web focused tests → `pnpm --filter @pideck/web test`
- Coverage → `pnpm test:coverage` must meet threshold
- Full gates → `pnpm check && pnpm test && pnpm lint`

## Suggested executor toolkit

Use `frontend-performance` and `react-patterns` skills if available for reducer/windowing work. Measure before claiming improvement.

## Scope

**In scope**: supervisor event queue/accounting and tests; web event reducer/cache/transcript rendering and tests; a focused virtualization dependency only if native implementation is demonstrably worse.

**Out of scope**: deleting persisted history, changing event semantic order, loading all run histories globally, visual redesign.

## Steps

1. Add metrics/tests that record event count, approximate bytes, queue depth, persistence latency, renderer commit count, and selected-run heap proxy for a deterministic 10k-event fixture.
2. Replace opaque promise chaining with explicit per-agent bounded ingestion accounting. If SDK backpressure is unavailable, define overflow behavior: stop/abort the run under plan 002's fail-closed policy and persist one bounded `event_backpressure_exceeded` terminal/truncation record when possible. Never continue paid work while silently dropping events.
3. Enforce aggregate payload byte limits during normalization rather than constructing/stringifying a potentially huge payload first.
4. Replace full-array sort on every event with an incremental sequence-keyed reducer: append contiguous events O(1), replace duplicates without resorting, and treat gaps through plan 005.
5. Keep durable cursor/history server-side while rendering a bounded/virtualized window. Fetch older transcript pages on demand and preserve scroll anchoring, selection, accessibility, and copy behavior.
6. Evict inactive run attachment/event caches using a documented small LRU; do not retain base64 from every opened run.

## Test plan

Cover 10k contiguous events, replay duplicates, out-of-order/gap events, 256 KiB payload edge, aggregate oversize, queue overflow, abort/finalize behavior, old-history loading, scroll anchor, cache eviction, and keyboard/screen-reader semantics.

## Done criteria

- [x] Supervisor queue has explicit count/byte limits and fail-closed overflow.
- [x] Aggregate normalized payload cannot exceed configured bound by more than fixed metadata overhead.
- [x] Normal contiguous delivery avoids Map construction and sorting; immutable React state copying is capped at 1,000 retained events.
- [x] Rendered/retained active window is bounded while full durable history remains retrievable page-by-page from the server.
- [x] 10k-event measurement: retained heap proxy fell from 10,000 to 1,000 events; deterministic Vitest fixture completed in 17–43 ms locally.
- [x] Focused gates pass; repository-wide test is blocked only by sandbox `listen EPERM` in the pre-existing WebSocket test.

## STOP conditions

- STOP if the Pi SDK offers a supported backpressure API not yet considered; use it rather than polling/dropping.
- STOP if virtualization breaks transcript accessibility or copy semantics.
- STOP if overflow handling would claim completion after dropped events.

## Maintenance notes

Budgets are product contracts. Expose them through options and keep defaults conservative. Review any future richer event payload against aggregate byte accounting.
