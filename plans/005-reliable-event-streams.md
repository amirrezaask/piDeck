# Plan 005: Make event-stream failures, cancellation, and reconnects truthful

> **Executor instructions**: Follow all gates and preserve unrelated dirty-tree changes.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- apps/web/src/lib/supervisor-client.ts apps/web/src/lib/supervisor-client.test.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

A daily-driver control surface must not treat missing events as a clean close. The current async queue can lose a failure when a consumer is already waiting, ticket acquisition bypasses retry/cancellation, and reconnect attempts accumulate forever even after healthy connections. Together these can silently freeze live state after ordinary network interruptions.

## Current state

`apps/web/src/lib/supervisor-client.ts:567-576` stores a failure and then resolves waiters as done:

```ts
fail(error: Error): void {
  this.failure = error;
  this.end();
}
...
while (this.waiters.length > 0) this.waiters.shift()?.({ done: true, value: undefined });
```

At `:409-413`, `websocketTicket()` is awaited before the socket read/retry error handling. At `:403-489`, `reconnectAttempt` is never reset on `onopen`.

## Commands

- `pnpm --filter @pideck/web test -- src/lib/supervisor-client.test.ts` → all pass
- `pnpm --filter @pideck/web typecheck` → exit 0
- `pnpm check && pnpm test && pnpm lint` → exit 0

## Scope

**In scope**: `apps/web/src/lib/supervisor-client.ts`, its test file.

**Out of scope**: App snapshot handling (plan 006), transcript memory (plan 011), server WebSocket protocol changes unless a test proves required.

## Steps

1. Change `AsyncEventQueue` so `fail(error)` rejects all pending/future readers with that error; normal `end()` still resolves them as done. Guarantee exactly one terminal state.
2. Move WebSocket ticket acquisition and construction inside the reconnect attempt's guarded block. Pass the stream `AbortSignal` through ticket HTTP requests and stop without reporting failure on user abort.
3. Count consecutive failures, not lifetime disconnects. Reset the counter only after a connection opens and demonstrates health (open plus valid message, or a documented stable-open threshold); avoid reset loops caused by immediately-closing sockets.
4. Keep sequence gaps fatal to the current stream, show state `failed`, and preserve the last durable cursor. Do not skip to the received sequence.
5. Ensure every socket/ticket request removes listeners and timers on reconnect and abort.

## Test plan

Script WebSocket doubles to cover: waiting reader receives gap error, waiting reader receives socket error, normal close, ticket 503 then recovery, hung ticket aborted, eight historical disconnects separated by healthy messages, nine consecutive failures, invalid JSON, duplicate replay, and listener cleanup.

## Done criteria

- [ ] Sequence/socket failures cannot become clean EOF.
- [ ] Ticket failures retry and are abortable.
- [ ] Healthy connections reset consecutive-failure budget safely.
- [ ] No cursor advances across a gap.
- [ ] Focused/full gates pass.

## STOP conditions

- STOP if browser/Electron fetch adapters cannot receive `AbortSignal`; report the adapter change needed.
- STOP if changing queue semantics breaks non-stream callers; enumerate them before expanding scope.

## Maintenance notes

Keep connection state semantic: `connected` means live and validated, `reconnecting` means retrying, `stale` means usable durable data without a trusted live channel, and `failed` requires operator-visible recovery.
