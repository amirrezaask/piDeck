# Plan 030: Reclaim oversized terminal buffers after measured idle periods

> **Executor instructions**: Complete Plans 016, 018, 019, 025, and 027 first.
> Inventory allocations before changing policy. Preserve fixed queue bounds and
> durable history. Use fake clocks in unit tests and release-browser memory
> evidence. Stop if reclamation requires dropping terminal state or causes
> grow/shrink oscillation. Mark this plan and its README row `DONE` after idle
> memory and resumed-output gates pass.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 8bbcd017..HEAD -- \
>   packages/ghostty-core/src/render-update.ts \
>   packages/ghostty-react/src/worker packages/ghostty-react/src/scheduler \
>   packages/ghostty-react/src/renderers/webgl2 \
>   packages/yaade-ui/src/panels/terminal-output-writer.ts \
>   apps/server/src/terminal.rs apps/server/src/terminal_history.rs \
>   apps/server/src/wire.rs tests/bench docs
> git diff --stat -- \
>   packages/ghostty-core/src/render-update.ts \
>   packages/ghostty-react/src/worker packages/ghostty-react/src/scheduler \
>   packages/ghostty-react/src/renderers/webgl2 \
>   packages/yaade-ui/src/panels/terminal-output-writer.ts \
>   apps/server/src/terminal.rs apps/server/src/terminal_history.rs \
>   apps/server/src/wire.rs tests/bench docs
> ```
>
> Reconcile live code from prior plans. Plan 016 should have three recyclable
> worker slots; Plan 018 should have bounded history staging; Plan 019 should own
> actor scratch; Plan 025 should expose hidden/presentation state.

## Status

- **Status**: DONE
- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 016, 018, 019, 025, and 027
- **Category**: memory / performance / lifecycle
- **Planned at**: commit `8bbcd017`, 2026-08-30
- **Source finding**: SolPro idle high-water allocation recommendation

## Why this matters

Growth-by-powers-of-two prevents steady allocation churn, but one large replay,
resize, or flood can leave each resident terminal holding peak-sized typed
arrays, scratch canvases, GPU buffers, write batches, and compression staging.
With several hidden terminals, retained high-water capacity can dominate idle
memory long after output returns to normal.

Reclamation must occur at owner-safe points with hysteresis. Shrinking on every
small frame would trade idle memory for allocation churn and visible latency.

## Current state

`GhosttyRenderUpdateBuilder` grows typed arrays and does not shrink them. Plan
016 will retain three returned slots. WebGL batches and GPU buffers grow to power
of two capacities. Glyph-atlas scratch canvases retain their largest dimensions.
Plan 018/019 may introduce reusable Rust staging/write buffers. Current metrics
expose some allocated and used bytes but no cross-layer idle high-water decision.

Useful caches and terminal state are different from transient capacity. Ghostty
scrollback, indexed history, retained rows, and atlas entries must not disappear
under a generic trim call.

## Target policy

```text
owner records: allocated bytes, used bytes, last use, recent-use high water
trim eligible when:
  no in-flight ownership
  no queued work
  no write/presentation activity for measured idle interval
  allocated > minimum and allocated / recent target exceeds hysteresis
  reclaimable bytes exceed threshold
  cooldown since last grow/trim elapsed

trim -> replace/free owner-local backing storage
resume -> correctness first; one bounded regrow and full render barrier as needed
```

Choose intervals, ratios, and byte thresholds from Plan 027 memory scenarios.
Use one low-frequency owner timer or explicit idle maintenance turn, not a timer
per buffer/frame.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Policy/client unit | `vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui` | ownership/hysteresis tests pass |
| Server | `vp run test:server && vp run test:terminal:integration` | staging/durability pass |
| Memory bench | `vp run test:bench` | idle capacity falls; resume budget passes |
| Browser E2E | focused compatibility/multiplexer Playwright commands | post-trim frame/output correct |
| Builds | `vp run build:web && vp run build:desktop && vp run build:server` | exit 0 |

## Scope

**In scope**

- Allocation/usage inventory and payload-free memory counters
- Worker render-slot typed arrays after all transfer ownership returns
- Output scheduler/coalescing scratch that prior plans make reusable
- WebGL retained batch backing arrays, GPU buffer capacity, and glyph scratch
  canvases at safe frame barriers
- Plan 018 history compression/index staging and Plan 019 PTY write scratch
- One tested idle/hysteresis/cooldown policy per owner
- Resume/regrow correctness, browser/Tauri memory scenarios, server stress tests
- Documentation and `plans/README.md`

**Out of scope**

- Dropping exact replay/history records, scrollback, terminal parser state,
  retained visible scene, or active queued bytes.
- Shrinking Ghostty internal allocations through private APIs or core recreation.
- Atlas eviction policy redesign or document-wide context budgets.
- Garbage-collection forcing as production policy.
- Mobile-only behavior or OS memory-pressure APIs without cross-platform fallback.
- Reducing fixed queue capacity without backpressure analysis.

## Steps

### Step 1: Inventory retained capacity by owner

Extend Plan 027 snapshots with used/allocated bytes and peak/last-use for:

```text
three render slots by typed-array field
worker/main output coalescing scratch
viewport/retained row batches
WebGL CPU batches and GPU buffers
glyph scratch canvases and atlas texture separately
server PTY/write scratch
history ingest/compression/index staging
Ghostty-reported memory when public, marked nonreclaimable here
```

Avoid double counting transferred `ArrayBuffer` ownership. Distinguish durable,
cache, in-flight, queued, and transient classes. Add a six-terminal scenario:
small steady state, one 16 MiB replay/flood, final small frame, idle, resume.

**Verify**:

```bash
vp run test:bench
vp run test:server
```

Expected: reports identify which capacities remain above use and their owners.

### Step 2: Define measured trim constants and one policy helper per runtime

From inventory, set named constants for minimum retained capacity, idle interval,
recent-use window, shrink ratio, minimum bytes reclaimed, and cooldown. Example
values in tests may use short fake durations; production values need benchmark
evidence.

Policy requirements:

- active growth resets idle eligibility;
- trim never runs with leased/transferred/in-flight storage;
- recent normal workload determines target, rounded to existing growth buckets;
- target retains headroom and package-specific minimums;
- a trim/grow cycle cannot repeat inside cooldown;
- owner disposal frees immediately without idle policy;
- low memory APIs may request evaluation but cannot bypass safety checks.

Write deterministic pure policy tests with fake clocks before integrating.

**Verify**:

```bash
vp test packages/ghostty-core packages/ghostty-react
cargo test --manifest-path apps/server/Cargo.toml idle_reclaim
```

Expected: eligibility, hysteresis, cooldown, minimum, and active-work tests pass.

### Step 3: Reclaim returned worker/client transient buffers

When all Plan 016 slot buffers have returned to the worker and a slot is free,
replace oversized typed arrays with target-capacity arrays. Never revoke a
transferred main-thread lease. Preserve exactly three slots and lease epochs.

Trim reusable output concatenation and decode/control scratch only after queues
are empty and replay ACK fences have completed. Do not trim viewport arrays that
hold authoritative rows. Add allocated/reclaimed/regrow counters.

A trim command/state update uses terminal generation and is idempotent. Hidden
busy terminals are not idle merely because they build no frames under Plan 025.

**Verify**:

```bash
vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui
```

Expected: detached/in-flight slots reject trim, idle slots reclaim, resume output
matches exact final state, and allocation count does not oscillate.

### Step 4: Reclaim WebGL CPU/GPU scratch at a frame barrier

For eligible terminals:

- replace oversized empty/rebuildable CPU batch arrays at target capacity;
- call `bufferData` with smaller capacity only at a renderer-owned barrier;
- retain authoritative row scene and schedule one full re-upload before present;
- resize or release oversized glyph scratch canvases while retaining valid atlas
  entries/texture;
- keep Canvas fallback equivalent.

Do not clear the atlas or retained scene under the transient trim label. If the
atlas dominates memory, report it for its own budget policy rather than hiding
cache eviction here. Context loss during trim follows existing recovery.

**Verify**:

```bash
vp test packages/ghostty-react
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts
```

Expected: first post-trim frame is complete and visually/structurally equal;
GPU allocated bytes fall without blank/intermediate output.

### Step 5: Reclaim server actor and history staging

At actor/history-owner idle maintenance turns:

- replace oversized empty PTY write batching/scratch buffers;
- drop/recreate oversized compression/decompression scratch after jobs complete;
- trim index-build staging only after durable commit and no reader borrow;
- leave bounded channel capacity and durable segment/index data unchanged;
- preserve written/durable shutdown barriers.

Do not call allocator shrink operations on the PTY reader path. Record operation
latency and keep maintenance outside owner urgent/control turns.

**Verify**:

```bash
vp run test:server
vp run test:terminal:integration
```

Expected: flood-idle-resume, close during trim, history replay, crash recovery,
and durable shutdown tests pass.

### Step 6: Prove memory falls without resume regressions

Run Plan 027's six-terminal high-water scenario in release browser/Tauri and the
server 64-terminal scenario. Require:

- reclaimable allocated bytes fall toward measured steady target after idle;
- exact durable/terminal state remains unchanged;
- first resumed input/output/present p95 stays within existing budget;
- one regrow is allowed when workload returns; repeated oscillation is zero;
- no new render-slot, GPU, history, or actor queue overflow;
- idle CPU/timer wakeups remain negligible.

Process RSS/heap may not fall immediately because allocators/GC retain pages.
Gate owner-reported capacity and use process memory as corroborating evidence.

**Verify**:

```bash
vp run test:bench
vp run test:server
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts
vp run test:desktop
```

Expected: exact capacity gates and stable latency pass with recorded memory data.

### Step 7: Document owners and maintenance triggers

Document reclaimable versus durable/cache/parser memory, constants, timer owner,
full-render barrier, and diagnostics. Add maintenance guidance for new reusable
buffers: expose used/allocated bytes and either a safe trim hook or an explicit
nonreclaimable rationale.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:web
vp run test:server
vp run test:bench
vp run build:web
vp run build:desktop
vp run build:server
```

Expected: all pass without relaxing memory or latency budgets.

## Test plan

- Inventory accounting and transferred-buffer no-double-count.
- Pure policy eligibility/hysteresis/cooldown/fake-clock cases.
- Worker slot ownership, hidden busy, trim, resume, regrow.
- WebGL barrier/full upload/context loss and Canvas parity.
- Server staging, close/shutdown/durability during maintenance.
- Six/64 terminal flood-idle-resume memory and latency.

## Done criteria

- [x] Metrics distinguish used/allocated, transient/cache/durable, and current owner.
- [x] Trim policy has measured idle, headroom, hysteresis, and cooldown constants.
- [x] No leased, queued, durable, parser, or retained-scene data is trimmed.
- [x] Client worker/GPU and server staging high-water capacity falls after idle.
- [x] Resume preserves exact state and existing input/present budgets.
- [x] No grow/shrink oscillation or significant idle timer CPU appears.
- [x] Full browser/Tauri/server/benchmark gates pass.

## Completion record

Completion extends the existing three-slot worker trim with exact used/allocated,
trim/reclaim, and one-shot regrow counters. A single shared renderer maintenance
loop now compacts rebuildable row/scene typed arrays, releases bounded glyph
scratch, shrinks GPU buffers, and re-uploads the complete retained scene without
clearing rows or the atlas. The six-terminal gate reduced transient allocation
from 2,120,184 to 25,080 bytes, reclaimed 2,095,104 bytes, preserved exact scene
data, resumed correctly, and reported zero repeated reclaim.

The release-browser geometry gate grows current WebGL scene use above 1 MiB,
then requires the measured 2× target ratio and 1 MiB reclaim threshold after a
shrink. It passed five consecutive runs, with exact resumed terminal text,
non-background pixels, at most one regrow, and no second trim cycle. The complete
11-test benchmark passed; resumed typing-under-flood remained inside the existing
80 ms p95 budget at 79.5 ms. The 18-test multiplexer suite, client units,
typecheck, and web/Tauri builds pass.

History encoded/compressed staging now trims only on an empty owner mailbox turn
with no pending records, retaining two 64 KiB minimum buffers. Its test reclaims
at least 3 MiB from a synthetic high water, then proves exact four-record replay
and one regrow. All 91 server units, 13 server parity/integration tests, Clippy,
release server build, and diagnostics accounting pass. PTY actor write scratch
remains bounded at 256 KiB below the reclaim threshold; durable pending records,
queue capacities, and shutdown barriers are unchanged. Repository-wide Oxlint's
pre-existing findings remain covered by the operator waiver; scoped changed-file
lint passes.

## STOP conditions

- Reclamation needs dropping history, scrollback, parser state, rows, or queued bytes.
- A transferred/in-flight buffer can be replaced before ownership returns.
- Hidden output is mistaken for idle while parsing remains active.
- WebGL shrink can present before full retained-scene re-upload.
- Policy uses forced GC, private Ghostty APIs, or per-buffer recurring timers.
- Memory improves only by causing repeated allocations or resume-latency regression.
- Atlas/cache redesign expands this plan beyond transient high-water storage.

## Maintenance notes

Growth and shrink need the same owner. New reusable buffers should expose used
and allocated capacity plus a safe idle boundary. Keep hysteresis tests strict;
most memory regressions here will appear as slow retained growth or trim/regrow
cycles rather than correctness failures.
