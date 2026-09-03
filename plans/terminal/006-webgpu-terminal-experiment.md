# Plan 006: Add a gated experimental WebGPU terminal adapter

> **Executor instructions**: This is an experiment with a mandatory go/no-go
> decision. Preserve local work, do not remove WebGL/Canvas, run every gate, and
> update `plans/README.md` with DONE or REJECTED plus the measured reason.
>
> **Drift check (run first)**:
> `git diff --stat 717ed49f..HEAD -- apps/desktop packages/ghostty-react tests/bench tests/web/e2e`
> Confirm Plans 002, 003, and 005 are DONE.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plans 002, 003, and 005
- **Category**: direction / perf
- **Planned at**: commit `717ed49f`, 2026-08-30

## Why this matters

WebGPU offers modern resource binding, predictable buffer updates, and a path to
future renderer reuse, but YAADE runs in browsers and Tauri system WebViews.
Availability therefore varies by OS/WebView, especially with the current macOS
11 minimum. The correct next step is an optional adapter measured against the
mature WebGL path—not a platform-wide migration commitment.

## Current state

- `apps/desktop/src-tauri/tauri.conf.json` sets macOS minimum version 11.0.
- Tauri uses system WKWebView on macOS, WebKitGTK on Linux, and WebView2 on
  Windows, so capability is not controlled solely by YAADE's bundle.
- Plan 002 provides WebGL2 and Canvas adapters over a common packed update.
- Plan 003 provides fallback/recovery.
- Plan 005 provides scheduling and benchmarks.

Official references to read before implementation:

- Tauri WebView versions: `https://v2.tauri.app/reference/webview-versions/`
- GPUWeb implementation status:
  `https://github.com/gpuweb/gpuweb/wiki/Implementation-Status`
- MDN WebGPU: `https://developer.mozilla.org/docs/Web/API/WebGPU_API`

Record access dates and exact target OS/WebView versions; support claims drift.

## Target design

Add a `webgpu` adapter behind the existing `TerminalRenderer` interface and
renderer controller. It consumes exactly the same packed updates and atlas
semantics as WebGL. Selection policy remains:

```text
explicit webgpu experiment → WebGPU self-test → WebGL2 → Canvas 2D
normal auto mode           → WebGL2 → Canvas 2D
```

Do not make WebGPU the normal default in this plan.

## Commands

- `vp test packages/ghostty-react packages/yaade-ui` → pass
- `vp run typecheck && vp run lint` → exit 0
- `vp run build:web && vp run build:desktop` → exit 0
- focused Web E2E on capability-present and forced-unavailable paths → pass
- `vp run test:bench` for WebGL and WebGPU → pass; comparison recorded

## Scope

**In scope**

- `packages/ghostty-react/src/renderers/webgpu/**` (new)
- renderer factory/controller and tests
- debug/backend selection in shared client code
- benchmark and focused E2E files
- documentation of compatibility matrix and go/no-go result

**Out of scope**

- Changing minimum OS versions, replacing Tauri, native `wgpu`, GPUI, removing
  WebGL/Canvas, worker rendering via OffscreenCanvas, arbitrary compute shaders,
  visual effects, or production default rollout.

## Steps

### Step 1: Produce a tested compatibility matrix

Test—not merely infer—`navigator.gpu`, adapter/device acquisition, preferred
canvas format, canvas configuration, one buffer upload, one texture upload, and
one presented frame on supported project hardware/CI for:

- current Chrome/Edge browser;
- current Firefox if YAADE claims it;
- Safari/WKWebView across the oldest supported and current macOS available;
- WebView2 desktop;
- representative WebKitGTK distribution.

Record unavailable and degraded cases. Because macOS 11 is supported, assume
WebGPU is optional unless evidence proves otherwise.

**Verify**: matrix document includes OS, WebView/browser version, GPU, result,
and failure stage. If fewer than the primary target platforms can run the
self-test, STOP and mark this plan REJECTED without implementing the adapter.

### Step 2: Implement adapter initialization and typed failures

Request an adapter/device, configure the canvas, compile WGSL pipelines, and
create all stable resources during initialization. Capture `device.lost` and
uncaptured errors and route them through Plan 003's controller. Do not expose
WebGPU objects through the shared renderer interface.

**Verify**: tests cover unavailable GPU, null adapter, device request failure,
shader validation error, device loss, and successful self-test fallback.

### Step 3: Port the proven WebGL batches

Use the same packed model, glyph atlas keys, bitmap rasterization, clipping,
instance semantics, and bounded memory policy. Reuse CPU-side backend-neutral
batch construction where it is genuinely shared; do not create a conditional
mega-renderer full of WebGL/WebGPU branches.

Use queue writes/buffer mapping according to measured size. Avoid per-frame
pipeline, bind-group-layout, sampler, or texture creation. Keep draw and upload
counters comparable with WebGL.

**Verify**: batch semantic tests are shared; WebGPU browser test renders the
same deterministic corpus.

### Step 4: Integrate loss recovery and fallback

On `device.lost` or validation/OOM failure, stop submissions, dispose/release
references, and let the renderer controller attempt a fresh WebGPU device once,
then WebGL2, then Canvas. Parser/model/PTY continue independently. A fallback
full-repaints retained state.

**Verify**: injected device loss during numbered PTY output ends on WebGL or
Canvas with stable PTY ID and complete final output.

### Step 5: Run differential visual and semantic tests

Compare WebGPU against Canvas and WebGL for the full Plan 002 corpus at multiple
DPRs. Use semantic assertions plus pixel tolerances; do not demand exact
cross-platform antialiasing.

**Verify**: dimensions, text, cursor, selection, links, wide cells, styles, and
backend data attributes agree; visual suite passes on designated CI hardware.

### Step 6: Benchmark and decide

Run three matched sets for WebGL and WebGPU. Record startup/device acquisition,
first frame, idle memory, atlas memory, CPU frame time, upload bytes, draw calls,
received→presented p50/p95/p99, stream/flood throughput, and six-pane behavior.

Recommend promotion only if all are true:

- capability matrix covers the intended rollout population;
- no correctness/recovery regression;
- p95/p99 or CPU usage improves by at least 15% in a relevant workload;
- startup and idle memory regressions are acceptable and documented;
- maintenance does not require duplicating batch/atlas semantics.

Otherwise retain it as an opt-in diagnostic experiment only if maintenance cost
is low; otherwise delete the adapter and mark the plan REJECTED with results.
Do not loosen budgets or minimum platform support to claim success.

### Step 7: Document the decision

Add a concise renderer decision record in the existing docs location if one
exists; otherwise add `docs/terminal-renderers.md`. Include the compatibility
matrix, benchmark setup/results, fallback policy, rollout status, and conditions
for reevaluation. Do not claim WebGPU support beyond tested WebViews.

## Test plan

Use fake GPU objects for failure/state tests and real browser hardware for
visual/benchmark validation. Cover capability absence, device loss, stale async
initialization, six terminals, font/DPR invalidation, hidden panes, and fallback
continuity.

## Done criteria

- [ ] Compatibility is measured on target WebViews before implementation.
- [ ] WebGPU is optional and uses the existing renderer/update interfaces.
- [ ] WebGL2 and Canvas remain complete fallbacks.
- [ ] Device loss is tested and does not affect PTY lifetime.
- [ ] Visual/semantic parity and benchmark comparison are recorded.
- [ ] Plan status records a clear promote/experimental/reject decision.
- [ ] Shared browser/Tauri implementation remains intact.

## STOP conditions

- Compatibility self-test fails across primary target WebViews.
- Supporting WebGPU requires raising OS minimums in this plan.
- The adapter requires native Tauri/GPUI code or an app-specific fork.
- Device loss cannot recover through Plan 003's controller.
- Measured benefit fails the promotion threshold and adapter maintenance is not
  negligible.

## Maintenance notes

WebGPU specifications, browser implementations, and system WebViews change.
Revalidate support claims before promotion. Reviewers should scrutinize device
loss, resource lifetime, validation errors, duplicate backend logic, and any
attempt to bypass the existing fallback ladder.
