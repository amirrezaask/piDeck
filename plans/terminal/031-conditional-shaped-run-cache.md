# Plan 031: Add a shaped-run cache only when profiling or conformance requires it

> **Executor instructions**: Complete Plans 009, 014, 022, and 027 first. This is
> a conditional experiment. Profile and run backend conformance before adding a
> cache. If shaping/raster work is below the threshold and no cross-cell shaping
> mismatch exists, keep the profiling fixtures, mark this plan `REJECTED (shaped
> run cache not justified)`, and stop. Preserve Canvas as the correctness oracle.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 8bbcd017..HEAD -- \
>   packages/ghostty-react/src/renderer.ts \
>   packages/ghostty-react/src/renderers \
>   packages/ghostty-react/src/fonts* packages/ghostty-react/src/fonts \
>   packages/yaade-app/src/test-bridge.ts tests/bench tests/web/e2e \
>   docs/terminal-renderers.md
> git diff --stat -- \
>   packages/ghostty-react/src/renderer.ts \
>   packages/ghostty-react/src/renderers \
>   packages/ghostty-react/src/fonts* packages/ghostty-react/src/fonts \
>   packages/yaade-app/src/test-bridge.ts tests/bench tests/web/e2e \
>   docs/terminal-renderers.md
> ```
>
> Reconcile Plan 014's live retained-scene implementation. Do not overwrite
> uncommitted row-range or batch changes.

## Status

- **Status**: TODO
- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 009, 014, 022, and 027
- **Category**: rendering / text / conditional performance
- **Planned at**: commit `8bbcd017`, 2026-08-30
- **Source finding**: SolPro conditional shaping-cache recommendation

## Why this matters

Canvas renders contiguous same-style cell text as one run, allowing browser text
shaping across cells. WebGL currently caches and rasterizes complete grapheme
clusters independently. Repeated Canvas shaping may cost CPU for dynamic TUIs,
while per-cluster WebGL rendering can lose ligatures or joining behavior that
requires neighboring text.

A run cache also carries costs: volatile row strings create misses, atlas entries
consume more area, invalidation grows, and terminal cells impose strict clipping
and cursor geometry. Profiling and conformance must choose whether to build it.

## Current state

`renderer.ts` groups adjacent same-style cells with `ghosttyTextRunEnd` and calls
Canvas `fillText` for the concatenated run. `WebGlGlyphAtlas` keys complete cell
graphemes by font/style/DPR/span/text and uploads one glyph/cluster image. It has
a bounded 1024 texture and resets under pressure. Plan 010 explicitly allowed a
bounded shaped-run fallback only for cases Plan 009 proves cannot render per
cluster.

No metric separates run construction, Canvas shaping/raster, WebGL cluster
raster, atlas hit/miss area, or text-related frame time. No deterministic fixture
currently proves cross-cell shaping with a legally distributable test font.

## Conditional outcomes

### Outcome A: implementation justified

Proceed when at least one approved condition holds:

- Plan 009 finds a structural cross-cell shaping mismatch in a supported script
  or enabled font feature; or
- repeated shaping/raster consumes an agreed material share (proposed gate: at
  least 10% of terminal frame CPU at p95) and a bounded prototype demonstrates
  useful hit rate and net frame improvement.

### Outcome B: implementation rejected

Keep fixtures/metrics, document results, and mark the plan `REJECTED` when neither
condition holds. Do not add dormant cache machinery.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Renderer unit | `vp test packages/ghostty-react` | run/cache/invalidation tests pass |
| Profile gate | `vp run test:bench` | implementation or measured rejection decision |
| Visual E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts` | Canvas/WebGL conformance passes |
| Desktop | `vp run test:desktop` | supported WebView output passes |
| Type/lint/build | `vp run typecheck && vp run lint && vp run build:web` | exit 0 |

## Scope

**In scope**

- Text-run/shaping/raster/atlas profiling counters through Plan 027
- Deterministic conformance fixtures for ligatures and joining/complex scripts
- A licensed pinned test font only after repository/license approval
- Prototype and, for Outcome A, bounded shaped-run cache
- WebGL retained-scene run instances and Canvas comparison where needed
- Font/DPR/style/direction/feature invalidation and atlas pressure
- Same-machine visual structural tests and Playwright verification
- Documentation and `plans/README.md`

**Out of scope**

- Inventing terminal bidi semantics not supplied by Ghostty/YAADE policy.
- Replacing browser Canvas shaping with a new HarfBuzz/WASM stack.
- Caching whole volatile rows or unbounded user strings.
- Changing PTY/parser cell widths, cursor positions, or selection semantics.
- Network-installed or unlicensed fonts in tests.
- General atlas/context-budget redesign.
- Logging terminal text as cache diagnostics.

## Steps

### Step 1: Define text-run semantics and deterministic fixtures

Extend Plan 009's backend-neutral contract with:

- run boundaries at style, empty cell, wide spacer, selected/background-only
  changes, wrap, cursor, and row edge;
- cell-span clipping and exact grid advance;
- common programming ligatures when font features enable them;
- Arabic joining and representative Indic/complex-script sequences;
- combining/ZWJ/variation selector and fallback font boundaries;
- mixed bold/italic/color and selection over a shaped run.

Use an existing checked font only if it contains required glyph/features. If no
legal deterministic font exists, propose one with license/size review and STOP
before adding a binary. Keep semantic text/cell assertions before pixel checks.

**Verify**:

```bash
vp test packages/ghostty-react
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts
```

Expected: fixtures establish Canvas oracle behavior and reveal whether WebGL
cluster rendering has a structural gap on the designated environment.

### Step 2: Instrument shaping and raster work without text payloads

Add counters/timings for:

```text
text runs and cells per run
run construction time sampled at row granularity
Canvas fillText calls/time
WebGL cluster raster calls/time
atlas hits/misses/upload pixels/pressure resets
candidate run-key hits/misses estimated without retaining text in diagnostics
text stage share of frame CPU
```

Use hashes/length buckets only for diagnostics; cache implementation may hold
text keys internally under strict bounds. Do not add a clock per cell. Extend
Plan 027 with static editor, dynamic dashboard, source-code ligature, Arabic,
Indic, emoji/ZWJ, and mixed-fallback cases.

**Verify**:

```bash
vp run test:bench
```

Expected: release results identify text-stage cost, repetition, estimated hit
rate, and atlas area pressure.

### Step 3: Make and record the implementation decision

Set thresholds before prototype comparison:

- correctness mismatch always qualifies if a run cache can fix it without grid
  semantic changes;
- performance path requires material text-stage share, estimated bounded hit
  rate, and projected atlas memory below existing budget;
- reject when browser/font shaping is negligible, runs are too volatile, or the
  cache would increase resets/total frame time.

For Outcome B, retain regression fixtures/metrics, update docs/README status,
and stop. For Outcome A, identify whether the cache is a WebGL shaped-run
fallback, a Canvas raster cache, or both. Default to the smallest path that fixes
the demonstrated issue.

**Verify**: decision record includes profiles, artifact/font/browser/hardware,
thresholds, and accepted scope.

### Step 4: Prototype a bounded run key and raster entry (Outcome A)

Define a key containing every rendering input:

```text
font family/loaded-face generation, size, weight, style
DPR and cell metrics generation
text bytes, cell span, direction/script policy, feature settings
color-glyph versus alpha-mask path
```

Segment runs at a measured maximum cell count and renderer semantic barriers.
Raster into exact cell-span bounds. Alpha-mask entries may reuse foreground
color; color glyph entries retain color semantics. Store no row/terminal ID in
the key unless ownership requires it.

Use a byte/area-bounded LRU integrated with existing atlas generation. Pressure
must evict/rebuild affected run entries without classifying cache pressure as
renderer failure. Prototype behind a test/build flag and collect hit/miss,
raster, memory, and reset data.

**Verify**:

```bash
vp test packages/ghostty-react
vp run test:bench
```

Expected: prototype has deterministic bounds and fixes the qualifying case.

### Step 5: Integrate with retained rows and invalidation (Outcome A)

Extend retained row scene data to reference shaped-run atlas entries and one quad
or bounded set per run. Dirty rows rebuild only affected runs. Invalidate on:

- font load/fallback face generation;
- font family/size/style/features;
- DPR/cell metrics and renderer generation;
- atlas eviction/reset/context recovery;
- text/style/run-boundary changes.

Theme/foreground changes should reuse alpha masks when safe. Cursor/selection/
decorations remain grid-aligned overlays and must not force unrelated run
reraster. Canvas remains the oracle and fallback.

**Verify**:

```bash
vp test packages/ghostty-react
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts
```

Expected: full/partial retained updates, cursor, selection, resize, DPR, font,
context loss, and fallback preserve exact structure.

### Step 6: Prove benefit and reject the prototype if it misses

Run identical flag-off/flag-on release builds. Require:

- qualifying conformance mismatch fixed within Plan 009 tolerances;
- no ASCII/box/wide/combining/cursor/selection regression;
- text-stage and total frame p95 improve by the predeclared amount for the
  performance path;
- atlas allocated bytes/resets and texture uploads remain within budget;
- dynamic low-hit workloads do not regress total frame p95 by more than 5%;
- six-pane memory remains bounded.

Remove the prototype and mark `REJECTED` if it fails. Do not ship disabled dead
cache code as future preparation.

**Verify**:

```bash
vp run test:bench
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-compatibility.web.spec.ts \
  tests/web/e2e/terminal-multiplexer.web.spec.ts
vp run test:desktop
```

Expected: implementation meets all predeclared gates or is removed cleanly.

### Step 7: Document the selected outcome and run full checks

Document supported shaping policy, font fixture/license, key/bounds/invalidation,
Canvas oracle behavior, measurements, and rejected alternatives. Visible output
changes require Playwright screenshots/structural assertions on designated
platforms and compatibility assertions elsewhere.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:web
vp run test:bench
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts
vp run test:desktop
vp run build:web
vp run build:desktop
```

Expected: all pass in either clean rejection or justified implementation outcome.

## Test plan

- Run-boundary, cell-span, style, wide/combining/fallback semantic tests.
- Licensed-font ligature/joining/complex-script Canvas oracle fixtures.
- Payload-free profiling and estimated/prototype cache hit/miss/area/reset.
- Bounded LRU, key completeness, invalidation, retained partial updates.
- Same-machine Canvas/WebGL structural/pixel comparisons.
- Flag-off/on static/dynamic/six-pane benchmarks and Tauri compatibility.

## Done criteria

Implementation outcome:

- [ ] Profiling or conformance crosses a predeclared qualification threshold.
- [ ] Cache key, byte/area bound, LRU, and invalidation are complete.
- [ ] Qualifying output is correct and Canvas remains the oracle/fallback.
- [ ] Performance/memory/pressure gates pass without unrelated regressions.

Measured-rejection outcome:

- [ ] Fixtures and payload-free profiling remain as regression coverage.
- [ ] Prototype code is removed.
- [ ] README status records why the cache was not justified.

Both outcomes require browser/Tauri tests and documented evidence.

## STOP conditions

- No deterministic legally usable font can exercise the claimed shaping behavior.
- Proposed cache changes terminal grid width, cursor, selection, or parser policy.
- Keys omit font generation, DPR, style, features, direction, text, or span.
- Cache stores whole unbounded rows or emits terminal text in diagnostics.
- Atlas pressure becomes renderer recovery or causes frequent full resets.
- Profiling misses thresholds but cache implementation remains.
- Work introduces a new shaping engine or bidi policy.

## Maintenance notes

Keep this optimization evidence-driven. New font settings or renderer run
semantics must update key and invalidation tests. Re-run profile and conformance
fixtures after browser font-engine, font asset, atlas, or retained-scene changes.
