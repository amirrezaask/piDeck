# Terminal performance budgets

`tests/bench/slos.json` v2 defines the targets. `test:diagnostics` validates the registry and tests the refresh-rate calculations. This revision replaces invalid per-character averages, mislabeled presentation fences, and latency gates under an unlimited producer. It does not establish a client speedup.

## Reference environment

Use a production SPA and release Rust host on an Apple M4 with 10 logical cores and 24 GiB RAM, with no competing benchmark jobs. Use the pinned Playwright Chromium at 1440×900 CSS pixels, DPR 1, WebGL2, and the worker runtime. Reports record machine details, browser version, and artifact hashes. Results from another machine need a separately calibrated profile before comparison.

The default browser-clock profile is 60 Hz. Select 120 Hz with `YAADE_BENCH_DISPLAY_HZ=120`. Before loading the terminal, the harness measures rAF cadence and rejects a mismatch greater than 10%. It does not increase a budget when rendering slows under load. Headless rAF timing, simulated DPR, and a selected 120 Hz profile do not prove physical display performance.

## Per-key next-rAF proxy

The start fence is the browser's captured keydown. The end fence is the rAF observation after submission of a model containing that key's unique echo. The measurement includes client input dispatch, loopback transport, the fixture's echo, parsing, rendering, and the observation callback. Stage timings appear in `[bench-key]` records.

This is **not physical presentation latency**. At 60 Hz, rAF-only submission followed by another rAF costs up to about 33.3 ms before processing. The old 16 ms p95 target could not describe that pipeline.

| Workload | 60 Hz p95 / p99 | 120 Hz p95 / p99 |
| --- | --- | --- |
| Idle, one pane | 42 / 66 ms | 25 / 41 ms |
| Paced ANSI, one pane | 66 / 116 ms | 41 / 74 ms |
| Paced ANSI, six panes | 66 / 116 ms | 41 / 74 ms |

Calculate each ceiling as `ceil(processingAllowanceMs + frameAllowance × 1000 / selectedHz)`. The registry's `ceiling` field records the default 60 Hz result:

- Idle p95 allows two frame intervals plus 8 ms of processing; p99 allows three intervals plus 16 ms.
- Loaded p95 allows three intervals plus 16 ms; p99 allows five intervals plus 32 ms.

These are engineering targets with explicit frame and processing allowances, not thresholds fitted to a passing run. A viable target can still expose an implementation failure. Keep physical key-to-photon and native-terminal parity claims separate until hardware measurements exist.

Each run focuses once, warms up with five keys, then measures 100 keys individually. Both idle and loaded fixtures use a Python process that immediately echoes a short sequence-numbered key marker. Background output cannot erase that reserved row. This changes the old shell-echo workload, so do not compare its numbers as an optimization result. The p99 from 100 samples is a coarse tail check; use at least three independent runs and retain each run's result rather than pooling away failures.

## Defined output load

Each loaded pane offers 512 KiB/s of ASCII/ANSI cursor and color updates, in blocks no larger than 16 KiB. Six panes offer 3 MiB/s in aggregate. The producer uses a monotonic clock, never catches up with a burst after a delayed write, and services input independently of output pacing.

The benchmark records per-pane parsed bytes and elapsed time. It rejects delivery below 80% of the offered rate or above 110%, with two blocks of boundary tolerance. A stopped producer or stalled parser cannot make a latency run pass. This is a moderate sustained-load target, not maximum terminal throughput or a substitute for CJK/emoji atlas-pressure coverage. The fixture stops after 60 seconds if the harness fails to close it.

The existing finite stream/flood throughput thresholds remain unchanged. Their marker/model-plus-rAF fences are browser observations, not physical display fences. Their five samples provide regression smoke coverage, not a reliable population p99 estimate.

## Overload and recovery

Run unpaced load separately:

```sh
YAADE_BENCH_OVERLOAD=1 pnpm exec playwright test --project=bench tests/bench/terminal-throughput.bench.ts --grep terminal-overload
```

The experimental one- and six-pane tests produce unpaced 64 KiB blocks for five seconds. They require the final marker on every pane within a further five-second recovery allowance and then check that terminal input works. The completion deadline starts after dispatching the fixture commands; it includes process startup. A timeout or unexpected host/browser error fails the test. These tests have no typing percentile SLO above capacity.

Keep byte integrity, explicit degradation, and queue bounds as zero-tolerance requirements. Existing parser, bounded-burst, protocol, and chaos tests cover those requirements; observing the final marker alone does not prove byte integrity or bounded memory. Host history-mailbox overflow remains a defect even if the paced latency suite passes. Do not call overload recovery supported until its separate tests pass.

## Running and reporting

```sh
pnpm test:bench:policy
node scripts/test-diagnostics.mjs
pnpm exec playwright test --project=bench tests/bench/terminal-throughput.bench.ts --grep terminal-key-next-raf --repeat-each=3
```

Set `YAADE_BENCH_REPORT` to retain JSONL observations, including the selected refresh rate and effective ceiling. Missing objectives and insufficient samples fail assertions. One- and six-pane tests have distinct metric and workload IDs; neither aliases the other.

Validation of this revision on the 60 Hz browser clock: three independent loaded runs passed for both pane counts (one-pane p95 47.3–47.4 ms; six-pane p95 45.0–45.2 ms). Idle p95 remained 46.5–47.1 ms against 42 ms. Both overload recovery tests failed, with timeouts and history-mailbox overflow. The final full benchmark suite passed 11 tests and failed the idle test. Nine policy/fixture tests passed. No 120 Hz or physical-display validation took place.

`enforced` means a benchmark asserts the objective, not that it passes. `specified` means the production scenario or semantic measurement remains missing. Session switching, reattach, archived search/reveal, and runtime control-starvation targets remain specified and uncalibrated; this revision does not invent new numbers for them. The release report lists these unsupported metrics and cannot claim complete performance coverage while they remain.
