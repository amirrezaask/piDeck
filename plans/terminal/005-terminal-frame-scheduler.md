# Plan 005: Unify terminal scheduling and end-to-end backpressure

> **Executor instructions**: Preserve local work, run every gate, and update
> `plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 717ed49f..HEAD -- packages/yaade-host-client packages/yaade-ui/src/panels packages/ghostty-react tests/bench tests/web/e2e`
> Confirm Plan 004 is DONE.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 004
- **Category**: perf / correctness
- **Planned at**: commit `717ed49f`, 2026-08-30

## Why this matters

YAADE already has server WebSocket flow control, a client output writer, Ghostty
dirty rows, animation-frame rendering, synchronized output, and hidden-pane
suppression. After worker migration these mechanisms must form one explicit
pipeline. Otherwise independent queues and acknowledgements can create excess
latency, unfairness, memory growth, or acknowledged-but-unparsed gaps.

## Current state

`terminal-output-writer.ts` currently provides microtask interactive flushes,
rAF flood flushes, a hidden-tab timer, optional parse slicing, replay isolation,
a pending cap, surrogate-safe slicing, and ACK suppression after shedding.
Current local work sets `GHOSTTY_OUTPUT_MAX_CHARS_PER_FLUSH` to 256 KiB.
`surface.ts` separately schedules render frames and suppresses DEC mode 2026
until close/timeout. The worker added in Plan 004 adds another queue and parsed
ACK. Preserve the existing correctness rules; centralize policy rather than
replacing them casually.

## Target design

Add a deep `TerminalFrameScheduler` module in `@yaade/ghostty-react` or
`@yaade/ui` at the seam where transport chunks become worker commands and
packed updates become renderer frames. Choose the lower package only if it does
not import host/RPC types; package imports must stay acyclic.

Track four independent milestones per sequence:

```text
received → posted-to-worker → parsed → presented
```

Only `parsed` is eligible for host cumulative ACK. `presented` is telemetry and
post-paint behavior, never transport correctness.

## Commands

- focused unit suites for writer, worker, scheduler, and transport → pass
- `vp run typecheck && vp run lint` → exit 0
- terminal compatibility/multiplexer E2E → pass
- `vp run test:bench` → budgets pass with queue/latency metrics recorded

## Scope

**In scope**

- `packages/ghostty-react/src/scheduler/**` (preferred new location)
- worker proxy/pool integration from Plan 004
- `packages/yaade-ui/src/panels/terminal-output-writer.ts` and tests
- `packages/yaade-ui/src/panels/TerminalPanel.tsx`
- `packages/yaade-host-client/src/terminal-v3-store.ts` only if existing typed
  flow-control hooks need scheduler telemetry; do not move rendering there
- terminal benchmark and focused E2E files

**Out of scope**

- Changing server binary protocol/window sizes without separate server evidence.
- React terminal state, arbitrary adaptive algorithms, unbounded queues,
  `SharedArrayBuffer`, or a global scheduler shared with non-terminal UI.

## Steps

### Step 1: Instrument the complete pipeline

Assign each incoming host frame/segment a local sequence linked to its server
ACK token. Record bounded timestamps/counters for received, posted, parsed,
update-ready, frame-submitted, and presented. Track queue bytes, oldest age,
worker service time, dirty rows, backend draw time when available, dropped or
superseded visual updates, and recovery generation.

Keep metrics in fixed-size rings; never retain PTY payloads. Expose aggregate
p50/p95/p99 and queue maxima through benchmark/test hooks only.

**Verify**: tests prove bounded retention, monotonic stages, and no payload text
in metrics.

### Step 2: Establish explicit budgets and fairness

Document defaults for:

- interactive input/output latency target;
- maximum main-thread task slice;
- maximum worker byte/time slice;
- maximum live pending bytes per terminal;
- maximum total worker-pool pending bytes;
- maximum hidden-tab parse delay;
- synchronized-output timeout;
- fair scheduling quantum between terminals.

Derive values from three benchmark runs; do not copy arbitrary constants.
Preserve server resync as the authority when a gap occurs.

**Verify**: a test with six terminals and one flood proves each quiet terminal
is serviced within the documented bound.

### Step 3: Separate interactive and flood lanes

Keep small echoes/key responses on a low-latency microtask/worker lane while
large output uses bounded fair slices. Preserve byte order per terminal: lanes
may choose scheduling priority but never overtake an earlier sequence. Once a
terminal enters flood mode, use hysteresis so it does not oscillate every chunk.

**Verify**: deterministic scheduler tests cover threshold edges, hysteresis,
ordering, and an interactive echo queued during a flood.

### Step 4: Coalesce presentation, never parsing correctness

Worker may parse multiple chunks before the next display frame and emit only
the latest compatible packed update for presentation, but it must still emit
parsed acknowledgements for every fully parsed sequence. Merge dirty rows and
cursor/title/scrollbar metadata by generation. Never merge across reset,
resize, alternate-screen generation, worker recovery, or authoritative replay.

DEC synchronized output suppresses presentation while parsing and ACK continue;
close or timeout emits one authoritative full update.

**Verify**: tests distinguish parsed sequence count from rendered frame count
and cover every merge barrier.

### Step 5: Handle hidden/background clients intentionally

Hidden panes continue parsing and ACKing but do not build/upload visual frames;
retain only the current model and issue one full repaint when shown. Hidden
documents use timer/message scheduling because rAF may stop. Rate-limit visual
telemetry and cursor blinking while backgrounded.

**Verify**: E2E backgrounds/switches panes during output, then shows them with
complete final text and one full repaint rather than replay-driven churn.

### Step 6: Integrate queue pressure with existing flow control

When local pending pressure approaches its budget, first reduce visual update
frequency and worker quantum overhead—not parser correctness. If bytes must be
shed, preserve current gap detection: suppress cumulative ACKs, request
server-authoritative replay, discard stale local generations, and resume only
after replay is parsed. Never ACK to free memory.

**Verify**: existing renderer-stall replay E2E plus worker-stall and six-terminal
pressure tests pass without missing final markers.

### Step 7: Add performance regression gates

Extend `terminal-throughput.bench.ts` with:

- six-pane fairness under one flood;
- queue-age and pending-byte maxima;
- long-task count/duration;
- received→parsed and received→presented p50/p95/p99;
- idle CPU/cursor behavior for visible and hidden panes.

Adopt scheduler defaults only when typing-under-flood p95 improves or remains
within 5%, stream/flood throughput remains within 5%, queues remain bounded,
and no fairness deadline is missed. Tighten budgets where repeatable; never
loosen existing budgets to land the scheduler.

## Test plan

Model queue tests on `terminal-output-writer.test.ts`, protocol/replay behavior
on `terminal-compatibility.web.spec.ts`, and measurements on
`terminal-throughput.bench.ts`. Add property-style sequences for enqueue,
parse, reset, replay, resize, hide/show, recover, dispose, and ACK.

## Done criteria

- [ ] Received, posted, parsed, and presented are distinct measured stages.
- [ ] Only parsed bytes drive host ACK.
- [ ] All queues, metrics, and worker slices are bounded.
- [ ] Six-terminal fairness has a tested deadline.
- [ ] Presentation coalescing respects reset/resize/replay/recovery barriers.
- [ ] Hidden panes parse without rendering and repaint authoritatively on show.
- [ ] Functional and benchmark gates pass without budget loosening.

## STOP conditions

- Implementing the scheduler requires acknowledging posted rather than parsed
  bytes.
- Package placement introduces an import cycle or makes a lower layer depend on
  React/host RPC contracts.
- Worker or renderer queues cannot expose bounded pressure metrics.
- Fairness requires reordering bytes within a terminal.
- Any benchmark improves throughput by materially regressing idle typing.

## Maintenance notes

Keep policy values centralized and documented with benchmark provenance. New
queues must participate in stage metrics and pressure bounds. Reviewers should
focus on ACK semantics, merge barriers, hidden-tab behavior, fairness, and
payload retention.
