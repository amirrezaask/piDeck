# Terminal runtime and renderer policy

## Defaults

YAADE starts the Ghostty parser in a bounded worker pool. Worker startup failure falls back to the main thread. A worker crash creates a new runtime generation and asks the host for authoritative replay before ACK resumes. Operators can force `main` with `yaade:terminal-runtime=main` or `?runtime=main`.

The terminal frame scheduler records four stages: received, posted, parsed, and presented. Host cumulative ACK runs only at parsed. Fixed-size metric rings retain byte counts and timestamps without PTY payloads. Hidden panes keep parsing and ACKing while suppressing rendering.

Renderer selection follows this ladder:

```text
auto or explicit webgl2: WebGL2 -> Canvas 2D
explicit canvas2d:       Canvas 2D
```

WebGPU is not shipped. A capability-gated adapter produced a blank terminal in a real WKWebView run, so the experiment was removed. Reintroducing it requires passing browser and Tauri presentation, loss-recovery, and terminal corpus tests.

## Measurements

Test host: Apple M4, macOS 27, 2026-08-29. Browser: project Chromium 149.0.7827.55.

| Runtime | Stream median | Flood median | Idle typing median | Typing under flood p95 |
| --- | ---: | ---: | ---: | ---: |
| Main, WebGL2, earlier three-run range | 266.5–283.0 ms | 76.4–77.6 ms | 11.7 ms | 14.8–14.9 ms |
| Worker before update coalescing | 428.5 ms | 124.2 ms | 12.0 ms | 15.1 ms |
| Worker after update coalescing, first run | 264.1 ms | 92.8 ms | 11.6 ms | 15.0 ms |
| Worker plus frame scheduler, default validation run | 341.6 ms | 160.7 ms | 11.4 ms | 15.0 ms |

The local results vary enough that they do not justify a performance claim. Project policy enables the worker and scheduler by operator direction so lower-spec and busier systems can keep parsing away from browser input and layout. Existing benchmark budgets remain unchanged.

## Benchmark contract

The serial Playwright benchmark project runs against the release web artifact.
Its versioned, payload-free stage dictionary is `host-frame-received` →
`scheduler-posted` → `worker-command-received` → `parsed` → `render-build` →
`transferred` → `model-applied` → `scene-submitted` → `presented` →
`slot-reclaimed`. Timing samples are capped at 256 entries. Exact counters,
final-state fences, corpus hashes, and slot/upload bounds are correctness gates;
median/p95/p99/CV timings use `budgets.json` only after repeatability supports a
ceiling.

`terminal-corpora.ts` materializes fixed ASCII, Unicode/wide, ANSI, synchronized
TUI, 16 MiB replay, and six-terminal contention inputs before measured regions
and validates their committed SHA-256 identities. Every measured browser result
logs commit, pinned Ghostty revision, release worker/WASM artifact hash, browser,
renderer, runtime, OS, CPU/core/memory context, DPR, and grid. CI runs the stable
schema/corpus/semantic-fence and cursor-submission subset serially and uploads a
content-free JSON report.

The deterministic same-worker contention gate places a focused key at service
turn five under FIFO against a target of at most one; the bounded weighted
scheduler serves it at turn zero while every hidden lane is served by turn five.
This justifies the Plan 026 scheduler rather than the measured-rejection outcome.

## Incremental WebGL scene submission

WebGL retains one compact CPU/GPU scene while continuing to clear and redraw the complete default framebuffer on every present. Submission is planned independently for backgrounds, decorations, and glyphs:

- cursor/focus-only frames perform no retained-scene copy or upload;
- dirty rows with stable primitive counts patch exact merged byte ranges;
- a row count change compacts only the affected primitive;
- dimensions, model generation, full repaint, font, DPR, viewport origin, hover geometry, atlas reset, and renderer recovery are full barriers.

Row batches retain typed-array capacity across warm same-shape updates. Cumulative lifecycle diagnostics report actual scene copy/upload bytes and calls, full/partial submissions, compactions, row allocations, overlay uploads, atlas activity, GL capacity, and a bounded 256-sample renderer CPU distribution.

The pre-change Apple M4 / Chromium 149 probe used a 180×44 viewport. A static focused terminal moved 326,384 bytes in 1.25 seconds, and five coalesced presents for ten fixed-width one-row updates moved 855,140 retained-scene bytes. These numbers characterize the removed full-upload path; no latency claim is made until three matched release benchmark runs establish a repeatable CPU distribution.

## Worker render-update ownership ring

Each worker terminal owns exactly three packed render-update slots. Building an
update leases one slot and transfers its eight typed-array buffers to the main
thread. `releaseRenderUpdate` transfers the same generation-scoped slot and
lease token back to the worker, where buffer lengths and alignment are validated
before the slot becomes reusable. Duplicate, stale, detached, or malformed
returns do not free a slot.

When all three slots are in flight, parsing and parsed ACKs continue. Dirty state
is not extracted or consumed; one pending newest update retains any full-frame
requirement and is emitted after a valid slot return. Queue discard, failed
model apply, surface disposal, and worker recovery explicitly release or abandon
the old generation's ownership. Capacity growth is bounded to the three slots,
and warm same-size circulation allocates no replacement backing buffers.

## Idle high-water reclamation

Transient capacity is accounted separately from durable history, Ghostty parser
and scrollback state, retained WebGL rows, and the glyph-atlas cache. A single
10-second worker maintenance loop and a single shared 10-second renderer loop
evaluate owners; there is no timer per slot, row, or GPU buffer.

Worker render slots use a 30-second idle interval, 60-second grow/trim cooldown,
4× allocated-to-target hysteresis, 1 MiB minimum reclaim, and two power-of-two
buckets of headroom over the latest used rows/cells/graphemes. All transferred
leases must return and no presentation command may be pending. Hidden parsing
updates owner activity, so hidden output cannot be treated as idle. Diagnostics
report used/allocated bytes, trims, reclaimed bytes, and first regrows without
recording payloads.

WebGL applies the same idle/cooldown/minimum but a measured 2× hysteresis because
its target already includes two buckets of CPU and GPU headroom. At the
renderer-owned barrier it compacts row and retained-scene typed arrays, resizes
GPU buffers, immediately re-uploads the complete retained scene, and releases
bounded glyph scratch canvases. It does not clear retained rows or the 4 MiB
atlas texture/cache. Canvas 2D has no equivalent growing terminal-owned scene
buffers. Lifecycle diagnostics distinguish current scene use, CPU allocation,
GPU allocation, target transient capacity, glyph scratch, and atlas cache.

The history owner checks staging every 10 seconds after an empty mailbox turn.
Empty encoded/compressed vectors trim after 30 seconds idle and 60 seconds since
growth/trim when they exceed 4× the two 64 KiB minimum buffers and can reclaim
at least 256 KiB. Pending records and active-file durability are untouched.
`/api/v1/diagnostics` reports history staging owner/class, used/allocated and
durable-pending bytes, trims, reclaimed bytes, and regrows. PTY actor write
scratch is capped at 256 KiB and is intentionally retained below the history
reclaim threshold; channel capacities never change.

Resume permits one bounded regrow. Cooldown and hysteresis prevent a second
trim/grow cycle under the resumed small workload. The release browser gate grows
a WebGL scene above 1 MiB, shrinks geometry, advances the policy clock, asserts
capacity falls, then verifies terminal text and non-background pixels on the
first resumed frame. The six-terminal benchmark and server history unit gate
also assert exact state and zero repeated reclaim.

## WebGPU decision

Official references checked on 2026-08-29:

- [Tauri WebView versions](https://v2.tauri.app/reference/webview-versions/)
- [GPUWeb implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)
- [MDN WebGPU API](https://developer.mozilla.org/docs/Web/API/WebGPU_API)

Project Chromium exposed `navigator.gpu` but returned no adapter. A newer WKWebView exposed enough API for initialization but rendered an empty black terminal. Capability checks alone therefore do not establish terminal support. YAADE uses WebGL2 on both browser and desktop targets, with Canvas 2D fallback.
