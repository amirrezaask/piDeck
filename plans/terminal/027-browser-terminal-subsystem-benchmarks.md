# Plan 027: Build a browser terminal subsystem benchmark harness

> **Executor instructions**: Complete Plans 014–016 and 025 first. Preserve
> existing benchmark and renderer work. Build measurements before tuning budgets.
> Run benchmarks serially against release builds and record runtime/hardware
> context. Stop when a metric cannot identify its semantic completion point.
> Update this plan and `plans/README.md` to `DONE` after repeatability gates pass.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 8bbcd017..HEAD -- \
>   tests/bench packages/ghostty-core packages/ghostty-react \
>   packages/yaade-ui/src/panels/TerminalPanel.tsx \
>   packages/yaade-app/src/test-bridge.ts playwright.config.ts \
>   package.json .github/workflows/ci.yml docs/terminal-renderers.md
> git diff --stat -- \
>   tests/bench packages/ghostty-core packages/ghostty-react \
>   packages/yaade-ui/src/panels/TerminalPanel.tsx \
>   packages/yaade-app/src/test-bridge.ts playwright.config.ts \
>   package.json .github/workflows/ci.yml docs/terminal-renderers.md
> ```
>
> Reuse Plan 007's presented-frame clock, Plan 014's submission counters, Plan
> 015's byte stages, Plan 016's slot metrics, and Plan 025's suppression counters.
> Do not create competing definitions for parsed or presented.

## Status

- **Status**: DONE
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 014, 015, 016, and 025
- **Category**: performance / test infrastructure / observability
- **Planned at**: commit `8bbcd017`, 2026-08-30
- **Source finding**: SolPro benchmark discipline and regression budgets

## Why this matters

The existing end-to-end benchmark covers typing and floods, but it cannot isolate
WASM parsing, packed update construction, transfer-slot recycling, model apply,
scene submission, GPU upload, hidden suppression, or initialization. Build and
scheduling decisions need stable subsystem measurements or a regression can hide
inside an unchanged total duration.

The harness should combine exact event/count assertions with statistically stable
latency/throughput distributions. It must not move corpus generation, build work,
or diagnostics serialization into measured regions.

## Current state

`tests/bench/terminal-throughput.bench.ts` covers stream throughput, TUI floods,
idle typing, and typing during floods. `tests/bench/budgets.json` stores broad
ceilings. `terminal-tui-fixture.ts` provides deterministic dashboard input. Plan
014 has an untracked incremental-submission benchmark in the live tree; preserve
and integrate it after its plan completes.

The app test bridge already exposes terminal lifecycle/frame data. New metrics
must remain aggregate and payload-free.

## Target harness

```text
pre-generated corpus + scripted scenario
  -> stage IDs/timestamps/counters
     received -> posted -> parsed -> frame built -> transferred
              -> model applied -> scene submitted -> GPU present
  -> exact gates + bounded sample rings
  -> median/p95/p99, throughput, allocation/memory deltas
  -> budgets.json only for stable distributions
```

A benchmark result records commit, Ghostty revision/artifact hash, browser,
renderer, worker mode, OS, CPU, logical cores, DPR, grid, warmup/round counts,
and release-build identity.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Metric unit | `vp test packages/ghostty-core packages/ghostty-react packages/yaade-app` | stage/counter tests pass |
| Subsystem bench | focused Playwright command introduced in Step 3 | parse/pack/transfer cases pass |
| Renderer bench | focused Playwright command introduced in Step 4 | submission exact gates pass |
| Full bench | `vp run test:bench` | stable release distributions pass |
| Build/type/lint | `vp run build:web && vp run typecheck && vp run lint` | exit 0 |

## Scope

**In scope**

- `tests/bench/**`
- Deterministic reusable terminal corpus helpers
- Payload-free instrumentation in `ghostty-core`, `ghostty-react`, renderer, and
  existing test bridge
- Playwright benchmark project/config and root scripts
- Exact counter gates and stable timing budgets
- Repeatability/calibration checks in CI
- Documentation and `plans/README.md`

**Out of scope**

- Production analytics or logging terminal payloads.
- ReleaseSmall/Fast selection: Plan 028 consumes this harness.
- Rust release tuning: Plan 029 consumes relevant end-to-end outputs.
- Worker fairness implementation: Plan 026 consumes contention scenarios.
- Idle buffer reclamation and shaping cache: Plans 030–031.
- Loosening existing budgets to make new code pass.

## Steps

### Step 1: Define stage semantics and a versioned metrics snapshot

Write one metric dictionary with exact start/end ownership:

```text
host frame received
scheduler posted
worker command received
Ghostty write returned (parsed)
render update build start/end
transfer posted/received
viewport model apply start/end
retained scene patch/compact
GPU upload bytes/calls
presented frame endpoint
slot return and reusable ownership
```

Include counters for hidden/sync suppression, full/partial updates, scene copy,
slot allocation/reuse, atlas hit/miss/upload/reset, queue bytes, and recovery.
Use integer IDs to correlate stages without storing terminal content.

Store bounded timing rings and cumulative counters. Compute percentiles when the
test requests a snapshot. Avoid per-cell clocks and React state.

**Verify**:

```bash
vp test packages/ghostty-core packages/ghostty-react packages/yaade-app
vp run typecheck
```

Expected: stage ownership and snapshot schema tests pass; no payload field exists.

### Step 2: Build deterministic pre-generated corpora and scenarios

Reuse Plan 022 binary fixtures where suitable, plus larger fixed files for:

- ASCII log output;
- Unicode/combining/wide output;
- ANSI/control-heavy output;
- complex TUI rewrites and synchronized dashboard transactions;
- replay at 512 KiB and 16 MiB;
- hidden terminal flood;
- one focused terminal with five background terminals;
- cursor-only, one-row dirty, ten-row dirty, and full-frame updates;
- resize/zoom/session-switch/recovery.

Generate files in an explicit maintainer command with fixed seed/version/hash.
Benchmark execution reads and validates files; it does not spawn generators or
shell commands in timed sections.

**Verify**: corpus validation prints IDs, sizes, hashes, and scenario event counts.

### Step 3: Add isolated worker/core microbench pages

Create a benchmark fixture that can run without the full mux while using the
production WASM loader, worker protocol, packed model, and buffer ring. Measure:

- WASM fetch/compile/instantiate/core initialization;
- write/parse bytes per second by corpus;
- packed dirty-row/full-frame construction;
- transfer and slot return latency;
- model apply;
- no-op/hidden/synchronized paths;
- steady allocation delta after warm-up.

Each case resets state between samples and validates final rows/hash/modes so a
fast no-op cannot pass. Use browser `performance.measureUserAgentSpecificMemory`
only when available and label it; retain deterministic allocation counters as
the portable gate.

**Verify**:

```bash
vp exec playwright test --project=bench tests/bench/terminal-subsystem.bench.ts
```

Expected: all cases produce correctness checks and distributions with context.

### Step 4: Add retained-renderer and GPU submission cases

Integrate Plan 014 counters for Canvas and WebGL:

- cursor-only frame;
- one stable-topology dirty row;
- topology-changing row;
- resize/font/DPR/theme barrier full frame;
- atlas warm hit and miss;
- six resident pane memory/submission totals.

Measure CPU scene build, copy bytes, bufferData/subData calls and bytes, draw
calls, and present endpoint. Never use preserved default-framebuffer pixels as a
performance shortcut. Retain structural/pixel checks from Plan 009/014.

**Verify**:

```bash
vp exec playwright test --project=bench tests/bench/terminal-renderer-submission.bench.ts
```

Expected: exact submission/allocation gates and timing distributions pass.

### Step 5: Harden end-to-end scenarios and completion fences

Extend the existing throughput suite with stage-correlated:

- idle typing and typing under flood;
- 30 Hz TUI/synchronized dashboard;
- hidden flood then show catch-up;
- session/window switch and six-pane residency;
- replay/reconnect and resize/zoom;
- focused versus background worker contention.

Typing assertions use PTY echo/output and a presented frame containing the text,
not keyboard event dispatch. Hidden parsing uses parsed sequence and final show
frame. Synchronized output uses one catch-up counter and final present.

**Verify**:

```bash
vp run test:bench
```

Expected: each scenario reaches its semantic fence and reports stage attribution.

### Step 6: Establish repeatability before machine budgets

On one recorded reference machine/browser:

1. build release once;
2. warm each case;
3. run at least five serial rounds without competing tests;
4. report median/p95/p99 and coefficient of variation;
5. inspect outliers and stage counters;
6. rerun on a second supported browser/Tauri environment for compatibility.

Use exact count/byte/allocation gates immediately. Add timing budgets only when
variance supports a threshold with headroom. Separate informational hardware
results from CI machine gates. Do not compare debug and release builds.

**Verify**:

```bash
vp run build:web
vp run test:bench
vp run test:bench
```

Expected: repeated runs stay within documented variance; unstable metrics remain
informational.

### Step 7: Add CI artifact and regression reporting

Run a focused stable subset serially in CI after one release build. Upload a
small JSON/Markdown result with context, stage distributions, and exact counters.
Never upload terminal payloads. Fail on correctness/exact gates and established
budgets. Keep longer memory/multi-browser experiments scheduled or manual if CI
variance is too high.

Document how Plans 026, 028, 029, 030, and 031 record before/after evidence with
the same command and artifact identity.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:web
vp run test:bench
vp run build:web
vp run build:desktop
```

Expected: all pass and benchmark output names the release artifact/runtime.

## Test plan

- Metric snapshot bounds/version/no-payload checks.
- Stage ID correlation and stale/recovery generation handling.
- Corpus hash/version and semantic final-state checks.
- Core/worker/render/GPU/end-to-end scenarios.
- Exact counters for allocations, transfers, suppression, uploads, presents.
- Repeatability calibration and intentional regression self-tests.

## Done criteria

- [x] One versioned payload-free metric schema names every terminal stage.
- [x] Pre-generated hashed corpora cover parse, render, hidden/sync, replay, and contention.
- [x] Microbench and E2E cases validate final terminal state.
- [x] Renderer tests report scene copy/upload/present work.
- [x] Exact gates and statistically stable timing budgets are separated.
- [x] Results identify commit, artifact, revision, runtime, renderer, and hardware.
- [x] CI runs a stable serial subset without loosening old budgets.
- [x] Later optimization plans can reproduce before/after evidence.

## Completion record

Completion adds fixed SHA-256-validated ASCII, Unicode/wide, ANSI, synchronized
TUI, 16 MiB replay, and six-terminal contention corpora; a production worker
semantic-fence benchmark; full release artifact/runtime/hardware context; and CV
reporting beside median/p95/p99. The cursor benchmark now begins after warm row
topology, making its zero scene-copy/upload/compaction gate repeatable. CI runs
the stable corpus/schema/semantic-fence/cursor subset serially and uploads a
payload-free JSON artifact.

On Apple M4, Chromium 149, macOS 27, the exact gates passed in all five serial
full-suite rounds. Four full rounds passed every timing budget; one existing
under-flood p95 sample was 80.6 ms against 80 ms. The operator's baseline waiver
applies to that unchanged timing variance; no budget was loosened. The contention
gate places focused FIFO service at turn five against the declared maximum turn
one, while the bounded scheduler serves focus at turn zero and every hidden lane
by turn five. Plan 026 is therefore justified and must use its implementation
outcome, not the measured-rejection outcome.

## STOP conditions

- A benchmark completes at event dispatch instead of parse/present ownership.
- Corpus generation, builds, server startup, or diagnostics serialization enter
  an unlabelled measured interval.
- Terminal bytes or cell contents enter metrics/CI artifacts.
- Debug and release, different artifacts, or competing parallel cases are compared.
- Timing budgets are added before repeatability or loosen existing ceilings.
- Instrumentation adds per-cell clocks, unbounded samples, or React output state.
- The plan starts implementing later optimizations.

## Maintenance notes

Metrics are contracts. Update the stage dictionary and self-tests when ownership
moves. Keep exact work counters stronger than timing where possible, and rerun
calibration when CI hardware, browser, Ghostty revision, grid, or renderer policy
changes.
