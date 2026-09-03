# Plan 041: Prove reconnect, restart, multi-host, and resource durability under chaos and soak

> **Executor instructions**: Complete Plans 018, 019, 032, 033, 037, and 040.
> Plan 024 must have reached a documented PASS or BLOCKED feasibility decision.
> Preserve all pre-existing working-tree changes. Use deterministic failpoints and semantic completion fences instead of fixed
> sleeps as assertions. Keep the supported architecture: browser loss preserves PTYs; host
> loss ends PTYs and Plan 032 restores metadata/history as interrupted. Do not
> loosen a budget after observing a failure. Update this plan and
> `plans/README.md` to `DONE` after PR, nightly, and one full scheduled soak pass.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat a0bb3fc9..HEAD -- \
>   apps/server/src packages/yaade-host-client/src packages/yaade-app/src \
>   packages/ghostty-core/src packages/ghostty-react/src \
>   tests playwright.config.ts .github/workflows/ci.yml tests/bench/budgets.json
> git diff --stat -- \
>   apps/server/src packages/yaade-host-client/src packages/yaade-app/src \
>   packages/ghostty-core/src packages/ghostty-react/src \
>   tests playwright.config.ts .github/workflows/ci.yml tests/bench/budgets.json
> ```

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 018, 019, 024 (decision), 032, 033, 037, and 040
- **Category**: reliability / tests / resource safety
- **Planned at**: commit `a0bb3fc9`, 2026-08-30
- **Source finding**: Superlogical long-running reliability, reconnect, and failure-recovery gates

## Why this matters

Unit and E2E tests cover many happy paths, but terminal systems fail at boundaries:
ACK races, process exit during replay, slow disks, network duplication, renderer
faults, host kill, browser suspension, and days of bounded output. YAADE's
architecture has explicit flow control and replay limits; a deterministic chaos
harness must prove those limits converge without corrupting output, leaking
processes, or growing memory/handles over time.

## Current state

- `TerminalHost` owns PTYs, history, writer leases, and fan-out; Plan 019 moves it
  to actor-owned mutation.
- Browser reconnect tests exist, and Plan 029 covers worker fault recovery, but
  there is no one failure matrix across host, transport, storage, worker, and UI.
- History quotas are 256 MiB per terminal, 2 GiB total, and seven-day closed
  retention; client archive paging already yields between pages.
- CI has multi-platform server/runtime suites, but no enforced hours-long soak,
  resource-slope report, or failpoint-driven crash matrix.
- Browser and host completion must be observed through terminal sequence/ACK,
  semantic hash, process state, and painted frame rather than elapsed command time.

## Reliability tiers

- **PR chaos smoke**: deterministic matrix, ≤15 minutes per shard.
- **Nightly soak**: 2 hours, repeated reconnect/fault cycles, all supported OS
  server targets plus Chromium renderer.
- **Weekly soak**: 72 hours on Linux/Chromium and 24 hours on macOS/Windows,
  including 1M-line cold history and six-pane flood.
- **Release candidate**: one clean weekly-equivalent report for the candidate
  commit; failed runs cannot be replaced by rerunning without triage.

Record platform/hardware, seed, scenario, semantic fences, RSS/heap, threads,
file/handle counts, archive bytes, queue high water, reconnect/resync count, PTY
children, and failure artifact references. Never record terminal payload text.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| PR matrix | `vp run test:chaos` | deterministic fault matrix passes |
| Short soak | `vp run test:soak -- --duration=10m` | zero invariant violations/leak slope |
| Recovery | `vp exec playwright test --project=platform-e2e tests/recovery` | process/restart tests pass |
| Durability | `vp exec playwright test --project=web-e2e tests/web/durability` | browser/worker/network cases pass |
| Full | `vp run test:server && vp run test:terminal:integration && vp run test:bench` | exit 0 |

## Scope

**In scope**

- Test-only deterministic failpoint/fault proxy and virtual clocks where feasible
- Failure matrix for process, transport, storage, parser/worker, auth, browser
- PR/nightly/weekly soak runners and resource/invariant artifacts
- Platform orphan/process cleanup and reconnect correctness tests
- CI scheduling, retention, triage, release gate documentation, and root/package
  scripts needed for `test:chaos` and `test:soak`

**Out of scope**

- Production fault injection endpoints or unauthenticated debug routes
- Keeping a PTY alive after host process exit
- Fuzzing parser bytes; Plan 040
- Vendor observability/export; Plan 042
- Increasing queues/quotas simply to make soak tests pass

## Steps

### Step 1: Define scenario matrix, invariants, and completion fences

Create a checked-in scenario manifest with seed, topology, terminal workload,
fault sequence, expected state, maximum recovery, and resource ceilings. Include:
browser tab close/reload/crash/suspend; WebSocket drop/duplicate/delay/reorder at
message boundaries; ACK loss; host graceful/crash/restart; PTY exit; disk
slow/full/read-only/corrupt tail; history rotation; semantic gap/hash mismatch;
worker crash; renderer fallback; auth expiry/revoke; two hosts same IDs; and
clock movement.

Global invariants: exactly one writer, ordered raw bytes, semantic convergence,
no ACK beyond sent, bounded queues/cache/history, no process/FD/task leak, no
unauthorized reconnect, preserved catalog/interrupted host restart, and usable UI
or typed degraded state.

**Verify**:

```bash
vp run test:chaos -- --list
```

Expected: every layer/fault/invariant is machine-readable; unknown scenario keys
fail schema validation.

### Step 2: Add hermetic failpoints and a deterministic transport proxy

Add compile-time/test-feature failpoints at archive write/fsync/rename, actor
mailbox, snapshot publication, PTY spawn/exit, shutdown barrier, auth verify, and
store commit. Production builds must not expose trigger routes or environment
variables. Implement a local WebSocket proxy that can drop/delay/duplicate/close
whole frames deterministically without altering encrypted remote traffic.

Use controllable clocks/random IDs in service tests and exact barriers in E2E.
Each fault emits only a scenario event ID to the harness, not payload data.

**Verify**:

```bash
vp run test:server
vp run test:chaos -- --scenario=history-publish-crash
```

Expected: failpoint absence is proven in release build; crash scenario recovers
only committed blocks and reports exact invariant checks.

### Step 3: Implement browser/transport/worker durability scenarios

Drive real terminal markers through PTY output and observe raw sequence ACK plus
semantic state hash/painted marker. Exercise online/offline flapping, stale
socket events, server epoch change, replay trimmed, semantic resync, page
background/suspend, worker crash/recreate, WebGL context loss, renderer fallback,
and terminal switch during flood.

Assert no duplicate/missing marker, stale input, reconnect storm, spinner without
bound, or listener/worker/GPU resource growth. Test current writer and observer
separately and use two browser contexts where control changes.

**Verify**:

```bash
vp exec playwright test --project=web-e2e tests/web/durability
```

Expected: each scenario reaches a semantic fence within its predeclared bound or
an explicit typed degraded state.

### Step 4: Implement host/process/storage recovery scenarios

Test browser/Tauri close does not kill PTY, explicit terminal close does, and host
kill ends every descendant. Restart the same data dir and assert Plan 032's exact
catalog/interrupted/history behavior. Inject disk-full/read-only/slow write and
corrupt final block/manifest; validate Plan 018 durability fence and no false ACK.

Exercise shutdown with active output, archive rotation, store commit, and restart
concurrently. Platform tests must check process groups on Linux/macOS and Job
Objects/handles on Windows, including PID reuse defense.

**Verify**:

```bash
vp exec playwright test --project=platform-e2e tests/recovery
vp run test:terminal:integration
```

Expected: process and persistence contracts pass on all supported server OSes
with no orphan and no partial data claimed durable.

### Step 5: Build the resource soak runner

Use deterministic workloads: idle shells, rapid spawn/close, 30 Hz TUIs,
large-line output, six panes, 20 observers, 1M-line cold history, session switch,
and continuous search/page navigation. Sample host RSS/threads/tasks/FDs or
handles/PTY children/archive bytes and browser JS/WASM/GPU worker counts/heap
where APIs permit. Warm up, measure steady windows, and fit/report slopes plus
high water.

Define absolute ceilings from architecture budgets and a near-zero sustained
slope after retention/cache equilibrium. If a metric is unavailable on a
platform, mark it unavailable with reason; do not report zero. Kill the whole
process tree on timeout.

**Verify**:

```bash
vp run test:soak -- --duration=10m --seed=1
```

Expected: a JSON and human summary show all invariants, samples, slopes, maxima,
and cleanup; repeating seed 1 produces the same fault schedule.

### Step 6: Add multi-host and auth durability

Run two hosts with overlapping resource IDs, independent server epochs, different
latency, and separate verified devices. Restart/revoke/partition one while the
other streams. Assert server-qualified routes, no event bleed, independent
backoff, correct credential selection, and one host's flood cannot starve UI
control for the other.

Include identity mismatch at the same URL and expired/revoked device during
replay/control transfer. The client must stop the affected connection without
deleting or exposing the other host.

**Verify**:

```bash
vp run test:chaos -- --scenario=multi-host-isolation
vp exec playwright test --project=web-e2e tests/web/e2e/server-connections.web.spec.ts
```

Expected: exact host isolation and bounded recovery pass.

### Step 7: Wire required, nightly, weekly, and release gates

Add PR shards for representative deterministic faults, nightly 2-hour platform
jobs, and weekly long jobs. Pin workload/tool/browser versions. Upload redacted
scenario/resource artifacts even on success and full repro commands on failure.
Prevent overlapping scheduled runs from exhausting runners without silently
cancelling a release-candidate result.

Document triage classes: product bug, harness bug, infrastructure invalid, and
approved unavailable metric. Only infrastructure-invalid can be rerun without a
code/finding record.

**Verify**:

```bash
vp run test:chaos
vp run test:soak -- --duration=10m
vp run test:bench
vp run typecheck
vp run lint
```

Expected: local required equivalents pass and CI workflow validation exposes all
scheduled tiers and artifact retention.

## Test plan

- Full scenario manifest coverage at each failure layer.
- Raw sequence/semantic hash/paint completion, writer uniqueness, bounds.
- Platform host/process lifecycle and persistent restart/history.
- Multi-host auth/epoch/ID/backoff isolation.
- Idle, churn, TUI, observers, 1M history, six panes resource slopes.
- CI timeout/cleanup/artifact/reproducer behavior.

## Done criteria

- [ ] Deterministic chaos covers host, PTY, transport, storage, worker, renderer, auth, and multi-host failures.
- [ ] Every scenario ends at a semantic success/degraded fence, never sleep-only success.
- [ ] Raw order, semantic convergence, one writer, bounds, and authorization invariants hold.
- [ ] Host restart/process cleanup matches documented destructive-PTY contract.
- [ ] PR and nightly tiers are green and one 72-hour weekly report passes.
- [ ] Resource artifacts show bounded maxima and no sustained post-equilibrium leak slope.
- [ ] Failure artifacts are redacted and exactly reproducible.

## STOP conditions

- Fault injection is reachable in a production build.
- A scenario can pass based only on elapsed time or lack of thrown error.
- A fix merely raises an unbounded queue/cache/history limit.
- The harness logs terminal/auth payloads or cannot clean up descendants.
- Host crash is redefined as PTY-survivable without architecture approval.
- Failed long soaks are rerun without retaining/triaging the first result.

## Maintenance notes

Add every production incident as a deterministic short regression scenario, then
keep long soaks for leak/tail behavior. Rebaseline resource ceilings only with a
reviewed corpus/hardware/runtime change and retain before/after artifacts.
