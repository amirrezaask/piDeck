# Plan 026: Bound shared-worker queues and prioritize focused terminals fairly

> **Executor instructions**: Complete Plans 015, 025, and 027 first. This plan has a
> measurement gate: add a scheduler only when the shared-worker flood fixture
> violates the focused-latency or fairness target. If browser FIFO already meets
> the target, record the evidence, mark this plan `REJECTED (scheduler not
> justified)`, and stop after instrumentation. Preserve per-terminal command
> order in every outcome.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 8bbcd017..HEAD -- \
>   packages/ghostty-react/src/worker \
>   packages/ghostty-react/src/scheduler \
>   packages/ghostty-react/src/surface.ts \
>   packages/yaade-app/src/test-bridge.ts tests/bench tests/web/e2e \
>   docs/terminal-renderers.md
> git diff --stat -- \
>   packages/ghostty-react/src/worker \
>   packages/ghostty-react/src/scheduler \
>   packages/ghostty-react/src/surface.ts \
>   packages/yaade-app/src/test-bridge.ts tests/bench tests/web/e2e \
>   docs/terminal-renderers.md
> ```
>
> Use Plan 025's generation-scoped `{visible, focused}` state. Do not add a
> second focus source or infer focus from terminal output volume.

## Status

- **Status**: DONE
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 015, 025, and 027
- **Category**: frontend performance / fairness / backpressure
- **Planned at**: commit `8bbcd017`, 2026-08-30
- **Source finding**: SolPro worker-level focused/visible prioritization

## Why this matters

`TerminalWorkerPool` hashes all resident terminals across at most four workers
and posts commands into browser FIFO order. A hidden terminal producing a large
stream can delay parsing and key encoding for a focused terminal on the same
worker. Plan 025 removes hidden frame extraction, but hidden bytes still require
parser time.

Priority must improve focused latency without reordering one terminal's parser
stream, losing hidden bytes, or creating another unbounded queue.

## Current state

`worker-pool.ts` maps terminal IDs to workers and forwards each command through
`worker.postMessage`. It has no byte accounting, credit, completion tracking,
priority class, or fairness metric. Worker message handlers process validated
commands as they arrive. Plan 015/005 should already provide byte-bounded output
scheduling and parsed acknowledgements at higher layers.

## Target design if the measurement gate fails

```text
per worker:
  terminal FIFO queues (strict order within terminal)
  active terminal classes:
    focused-visible weight 8
    visible-background weight 4
    hidden-background weight 1
  deficit round robin by estimated command cost/bytes
  age promotion / maximum service wait
  bounded aggregate bytes and commands
  small in-flight credit window
```

Priority applies between terminals. It may not move a key command ahead of older
output for that same terminal because output can change keyboard mode.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Scheduler unit | `vp test packages/ghostty-react` | order/credit/fairness tests pass |
| Contention bench | `vp run test:bench` | gate chooses rejection or bounded scheduler |
| Multiplexer E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts` | exact final output/no starvation |
| Desktop | `vp run test:desktop` | shared worker policy passes |
| Type/lint | `vp run typecheck && vp run lint` | exit 0 |

## Scope

**In scope**

- `packages/ghostty-react/src/worker/worker-pool.ts`
- `terminal-worker.ts`/`protocol.ts` only for bounded completion/credit signals
- A focused worker scheduler module and deterministic tests if gate fails
- Integration with Plan 015 output bounds and Plan 025 focus/visibility state
- Payload-free queue/service metrics through the test bridge
- Multi-pane browser benchmark/E2E fixtures
- `docs/terminal-renderers.md` and `plans/README.md`

**Out of scope**

- Worker presentation suppression: Plan 025.
- General benchmark harness: Plan 027.
- New Web Workers per terminal or unbounded concurrency.
- Reordering commands within one terminal.
- Dropping/coalescing output bytes or parsed ACKs.
- Server-side actor/socket priorities.

## Steps

### Step 1: Measure same-worker contention

Create a deterministic fixture that forces one focused terminal and five
visible/hidden terminals onto one pool slot. Run:

- focused key encoding plus echoed output during hidden floods;
- focused 30 Hz TUI during background build output;
- two visible terminals with equal sustained output;
- one hidden terminal in each hash slot;
- dispose/resize/recovery during saturation.

Record per terminal:

```text
queued bytes/commands, oldest wait, service turns, bytes parsed,
key command-to-result, output received-to-parsed, starvation count,
worker event-loop turn duration and aggregate in-flight bytes
```

Use fixed input and rounds. Define the target from existing typing budgets and a
finite hidden service bound. Compare FIFO baseline against an ideal isolated
worker only as diagnosis, not as a shipping architecture.

**Verify**:

```bash
vp test packages/ghostty-react
vp run test:bench
```

Expected: a repeatable table shows whether focused p95/p99 or hidden maximum wait
violates the proposed bounds.

### Step 2: Choose the no-scheduler or scheduler outcome

If FIFO meets the target with margin across supported browser/Tauri runs:

- retain metrics and regression fixture;
- document results and avoid queue complexity;
- mark plan `REJECTED (scheduler not justified)`.

If it fails, document which class/worker/corpus fails and continue. Set explicit
byte/command/in-flight bounds using Plan 015 limits. Define overflow recovery
before writing scheduler code. The worker pool cannot accept bytes that its
upstream scheduler believes were parsed.

**Verify**: review the decision table and constants before implementation.

### Step 3: Introduce completion-based worker credits

For the scheduler outcome, make every posted command release a known credit:

- write/replay/reset: existing `parsed` event;
- key/paste/text/mouse/query: result or explicit completion;
- resize/theme/selection/scroll/full-frame: explicit completion if no result;
- create/dispose/recovery: lifecycle completion.

Generation and command sequence identify completion. Duplicate/stale completion
cannot release current credit. Worker crash returns all in-flight ownership to
recovery logic rather than treating commands as parsed.

Transfer byte buffers only when a command is posted, not while it waits in the
pool queue. Define who owns queued `ArrayBuffer`/`Uint8Array` and when disposal
releases it.

**Verify**:

```bash
vp test packages/ghostty-react
```

Expected: credit, stale completion, crash, transfer ownership, and dispose tests
pass with a fake worker.

### Step 4: Implement bounded weighted deficit round robin

Maintain one strict FIFO per terminal. Select terminals by explicit focus/
visibility class and byte deficit. Requirements:

- no command overtakes an older command for the same terminal;
- command cost includes byte payload plus fixed control cost;
- focus/visibility changes affect the next unsent turn;
- age promotion enforces a measured maximum wait for hidden queues;
- lifecycle failure/dispose can cancel that terminal through an explicit rule;
- latest unsent resize/theme may coalesce only where existing protocol contracts
  permit it;
- total queue and in-flight bytes remain within coordinated Plan 015 bounds;
- scheduling uses microtask/task yielding so one drain cannot monopolize main.

Keep policy in one tested module. `worker-pool.ts` owns worker lifecycle and calls
it; surface/components do not implement lane logic.

**Verify**:

```bash
vp test packages/ghostty-react
vp run typecheck
```

Expected: deterministic weight, aging, no-starvation, strict order, bounds,
coalescing, and cancellation tests pass.

### Step 5: Prove recovery and backpressure semantics

Saturate each queue and worker credit window. Verify:

- upstream stops posting rather than growing memory;
- no accepted output byte disappears or changes order;
- replay recovery starts when existing Plan 015 semantics require it;
- focused priority cannot bypass the same terminal's prior mode-changing output;
- hidden terminals advance within the service bound;
- worker replacement does not double-release buffers or ACK unparsed output.

Add high-water diagnostics without payloads. Queue metrics use bounded rings or
counters and reset cleanly on runtime disposal.

**Verify**:

```bash
vp test packages/ghostty-react
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts
```

Expected: saturation/recovery tests pass and all terminals reach exact final text.

### Step 6: Re-run contention benchmarks and visible tests

Compare identical baseline and scheduler builds. Require:

- focused input/result and received-to-parsed p95 do not regress over 5%;
- the originally failing focused p95/p99 returns within existing typing budget;
- hidden maximum service wait stays within the approved bound;
- total memory remains within Plan 015 limits;
- single-terminal throughput does not regress over 5% without a documented win.

Use scoped DOM, PTY output, console, and worker diagnostics for multi-pane E2E.
Update docs with either implemented policy or measured rejection.

**Verify**:

```bash
vp run typecheck
vp run lint
vp test packages/ghostty-react packages/yaade-ui
vp run test:bench
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-compatibility.web.spec.ts \
  tests/web/e2e/terminal-multiplexer.web.spec.ts
vp run test:desktop
```

Expected: all correctness gates pass; performance decision meets the stated
thresholds without loosening old budgets.

## Test plan

- Baseline contention and isolated diagnostic comparison.
- Credit accounting for every command/result and stale generation.
- Weighted/aged service, byte cost, strict per-terminal order, bounds.
- Focus/visibility changes, dispose, crash, worker recreation, replay recovery.
- One, two, and six terminal throughput/latency/fairness.
- Browser/Tauri final PTY text and payload-free metrics.

## Done criteria

Implementation outcome:

- [x] Shared worker queues and in-flight commands have coordinated byte/command bounds.
- [x] Focused/visible weighting preserves strict per-terminal order.
- [x] Hidden terminals make progress within a tested maximum wait.
- [x] Worker crash/dispose cannot falsely ACK or leak transferred buffers.
- [x] Focused and single-terminal benchmark thresholds pass.

Measured-rejection outcome:

- [ ] FIFO baseline meets focused and hidden fairness targets across supported runs.
- [ ] Regression fixture and metrics remain in the repository.
- [ ] README status records `REJECTED (scheduler not justified)`.

Both outcomes require full unit, browser, and Tauri correctness gates.

## Completion record

Plan 027's repeatable same-worker gate disproves the rejection condition: FIFO
places the focused command at service turn five against the declared maximum
turn one. The existing bounded weighted deficit scheduler serves it at turn zero
while all five hidden lanes are serviced by turn five. It retains one strict
FIFO per terminal, 32 MiB / 8,192-command aggregate bounds, an eight-command
credit window, generation-qualified completion, queued-buffer ownership until
dispatch, and explicit crash/dispose reset.

The contention decision passed five consecutive runs. Scheduler units, worker
units, focused multi-terminal browser checks, Tauri tests, typecheck, and the
single-terminal/full benchmark gates pass except for the already waived
under-flood timing variance recorded in Plan 027. No budget was loosened and the
plan is completed through its implementation outcome, not `REJECTED`.

## STOP conditions

- Priority requires reordering commands within a terminal.
- A queue or credit window lacks byte and command bounds.
- Output can be dropped/coalesced or acknowledged before worker parsing.
- Hidden work can starve indefinitely.
- Scheduler duplicates Plan 015 buffering without coordinated ownership.
- The measured FIFO baseline passes but implementation proceeds without another
  demonstrated requirement.
- Work expands into presentation suppression or benchmark infrastructure owned
  by another plan.

## Maintenance notes

Treat focus as latency priority, not correctness priority. Each terminal retains
one causal command stream. Update command cost/completion tables when protocol
commands change, and keep saturation/recovery tests beside that table. Re-run the
contention fixture when worker count or hashing policy changes.
