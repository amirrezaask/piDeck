# Plan 042: Establish content-safe telemetry, support diagnostics, and enforced product SLOs

> **Executor instructions**: Complete Plans 027, 032, 033, 034, 040, and 041.
> Preserve all pre-existing working-tree changes. This plan observes existing owners; it must not add a control plane, capture
> terminal content, or make vendor telemetry mandatory. Start by freezing metric
> definitions and redaction tests. Do not tune release thresholds after seeing
> final results. Update this plan and `plans/README.md` to `DONE` after diagnostic
> leakage tests and release SLO gates pass.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat a0bb3fc9..HEAD -- \
>   apps/server/src/{diagnostics,runtime,server,terminal,terminal_control,terminal_history}.rs \
>   packages/yaade-rpc/src packages/yaade-host-client/src packages/yaade-app/src \
>   tests/bench tests/diagnostics tests/runtime .github/workflows/ci.yml \
>   docs package.json
> git diff --stat -- \
>   apps/server/src/{diagnostics,runtime,server,terminal,terminal_control,terminal_history}.rs \
>   packages/yaade-rpc/src packages/yaade-host-client/src packages/yaade-app/src \
>   tests/bench tests/diagnostics tests/runtime .github/workflows/ci.yml \
>   docs package.json
> ```

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plans 027, 032, 033, 034, 040, and 041
- **Category**: operations / performance / supportability
- **Planned at**: commit `a0bb3fc9`, 2026-08-30
- **Source finding**: Superlogical diagnostics, performance, and production-quality gates

## Why this matters

The current diagnostics module recursively redacts keys, but there is no complete
support bundle, bounded operational metric surface, distributed request/terminal
correlation, or release SLO report. Existing benchmark budgets cover a handful of
broad end-to-end paths such as typing, flood, and session switch, but not exact first
screen, reconnect convergence, million-line history, resource slopes, or error
budgets. Content-safe observability lets operators answer what is slow/broken
without collecting the code, commands, paths, or credentials displayed in a
terminal.

## Current state

- `apps/server/src/diagnostics.rs` provides recursive secret-key redaction. It is
  not a diagnostic manifest, bundle builder, metric registry, or tracing policy.
- `tests/bench/budgets.json` currently includes, among other limits, typing p95
  24 ms, stream-throughput p95 2 s, flood p95 1.5 s, typing-under-flood p95
  80 ms, and session-switch p95 150 ms.
- Plan 027 adds terminal benchmark rigor; Plan 041 adds chaos/soak resource
  artifacts. This plan turns approved metrics into one release decision.
- Terminal output, command input, CWD, environment, titles, pairing/invitation
  values, tokens, keys, and URLs with secrets are prohibited telemetry content.

## Proposed release objectives

Freeze these before implementation on a named reference hardware/browser profile;
if the supplied Superlogical reference is stricter, the stricter ceiling wins:

| Signal | Release ceiling/objective |
|---|---|
| local input received → frame presented | p95 ≤16 ms, p99 ≤33 ms |
| input under six-pane flood | p95 ≤50 ms, p99 ≤100 ms |
| warm Session/terminal switch → trustworthy frame | p95 ≤100 ms |
| semantic current-screen reattach | p95 ≤100 ms; input-safe handoff p95 ≤500 ms |
| active render frame time | p95 ≤16.7 ms, p99 ≤33.4 ms |
| control message starvation under flood | none beyond 100 ms |
| 1M-line literal search first result | p95 ≤250 ms warm index, ≤1 s cold |
| 1M-line jump/reveal | p95 ≤250 ms after page response |
| raw/semantic correctness | zero missing/duplicate bytes; zero final hash mismatch |
| bounded queue/history/auth violations | zero |
| steady-state leak after warm-up | no statistically significant positive slope above approved noise floor |
| crash/reconnect scenarios | ≥99.9% inside scenario recovery bound in release campaign; zero correctness violations |

These are local processing objectives, not WAN RTT promises. Record network time
separately. Initial baseline may be red; do not weaken a ceiling to make it green.
A reviewer may ratify hardware-specific absolute/relative replacements before
optimization begins.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Diagnostics | `vp run test:diagnostics` | schema, bounds, redaction/leak tests pass |
| Server | `vp run test:server` | metric/tracing/health tests pass |
| Bench | `vp run test:bench` | approved SLO report is green |
| Soak | `vp run test:soak -- --duration=10m` | resource summary imports cleanly |
| Full | `vp run typecheck && vp run lint && vp run build:server && vp run build:web` | exit 0 |

## Scope

**In scope**

- Typed content-safe tracing/metric vocabulary and bounded local exporter
- Liveness/readiness/status distinction
- Explicitly generated server/client support bundle with manifest and limits
- Central SLO registry, benchmark semantic fences, release report, CI enforcement
- Operator runbooks, privacy/redaction tests, and root/package scripts needed for
  `test:diagnostics` and `diagnostics:bundle`

**Out of scope**

- Mandatory cloud telemetry, hosted control plane, or user tracking
- Terminal transcript, keylogging, command/CWD/title capture, or crash memory dumps
- Auto-uploading support bundles
- Pretending browser paint metrics are server-only latency
- Optimization work not identified by a failing profile

## Steps

### Step 1: Define an allowlisted diagnostic data taxonomy

Create a schema/registry where every trace field, metric label, bundle file, and
diagnostic event has owner, type, cardinality bound, sensitivity class,
retention, and test. Use an allowlist, not only recursive key-name redaction.
Approved examples: version, OS/arch, opaque server/terminal suffix, counts, byte
sizes, sequence distance, queue high water, durations, typed error code, feature
flags. Prohibit payload snippets and unrestricted strings/maps.

Hashing a command/path/title is still identifying and is prohibited by default.
Apply cardinality limits so terminal/session/device IDs are not metric labels;
keep them only in local bounded traces with randomized bundle aliases.

**Verify**:

```bash
vp run test:diagnostics
```

Expected: schema accepts every emitted field, rejects unknown/unbounded/sensitive
fields, and adversarial nested secrets never appear in serialized output.

### Step 2: Add structured correlation at service boundaries

Instrument RPC request, authenticated device session, terminal actor message,
raw sequence/ACK, semantic revision/resync, archive operation, store commit,
renderer attach/switch, and reconnect with generated correlation IDs. Pass IDs
through typed context; never embed them in PTY bytes or public command arguments.

Record queue wait separately from work time and network/paint separately from
server processing. Sample high-frequency terminal observations by deterministic
count/rate while always recording bounded typed errors and state transitions.

**Verify**:

```bash
vp run test:server
vp test packages/yaade-host-client packages/yaade-app
```

Expected: a synthetic request can be correlated host-to-client using aliases and
phase durations without any content field.

### Step 3: Add a bounded local metrics/status endpoint

Expose authenticated/loopback operational metrics in a vendor-neutral text or
JSON format: RPC latency/error by route class, active PTYs/viewers/writers,
actor/WS queue and dropped/coalesced counts, raw replay gap, semantic resync/hash
mismatch, history bytes/write/fsync/recovery, reconnect outcomes, auth denial/
rate limit, task/FD/handle counts, and process memory where supported.

Separate liveness (process event loop responds), readiness (store/history/actor
can serve), and detailed authenticated status. High-cardinality IDs and content
are absent. Slow/failing exporter collection may not block PTY actors.

**Verify**:

```bash
vp run test:server
vp run test:diagnostics
```

Expected: bounds/labels/status transition tests pass; unauthorized remote detail
is denied and flood does not delay terminal control.

### Step 4: Build an explicit support-bundle generator

Add a root/package script named `diagnostics:bundle` plus a server CLI command
and shared settings action that first show an inventory and estimated maximum
size, then generate locally after confirmation. Include manifest,
versions/build IDs, redacted config shape, capabilities, state counts, recent
bounded typed logs/traces, metric snapshot, archive/index health **metadata**,
client feature/renderer status, and latest benchmark/chaos report if present.

Exclude databases, terminal archives/rows/bytes, browser storage, keys/tokens,
environment, full paths/usernames, URLs with query/userinfo, device/invite values,
and screenshots. Replace resource IDs with bundle-local aliases. Cap files,
records, age, and total bytes; use restrictive permissions and atomic output.
Never upload automatically.

**Verify**:

```bash
vp run test:diagnostics
vp run diagnostics:bundle -- --dry-run
```

Expected: dry-run lists only schema-approved files; adversarial fixture bundle is
bounded and contains no known canary secret/path/terminal text.

### Step 5: Centralize semantic SLO definitions and benchmark fences

Move release objectives and current `budgets.json` values into one validated SLO
registry with metric name, unit, percentile, hardware/browser profile, corpus,
start/end semantic fence, warm-up, iterations, ceiling, and owner. Tests must
reject missing units, unknown metrics, duplicate budgets, and elapsed-sleep
completion.

Instrument input received, worker accepted, model committed, frame submitted,
and frame presented. Instrument attach requested, current snapshot hash painted,
raw parser hash matched, and input enabled. Import Plan 041 resource/recovery
results without converting unavailable metrics to zero.

**Verify**:

```bash
vp run test:bench
```

Expected: report shows every table objective, phase breakdown, sample count,
hardware metadata, confidence/variance, and pass/fail.

### Step 6: Enforce SLO and regression policy in CI/release

Keep functional correctness zero-tolerance. For timing metrics use fixed reference
runners or an approved relative baseline plus absolute ceiling; do not compare
random shared runners as if stable. Require two-stage confirmation for noisy
regressions using the same commit/environment, while retaining the first result.
A red gate opens a profile/finding, not an automatic threshold edit.

Publish one signed/hashed machine-readable release quality report combining
conformance, compatibility, chaos/soak, performance, and unsupported metrics.
Document who may approve platform-unavailable or threshold changes and require a
reason/history in the registry.

**Verify**:

```bash
vp run test:bench
vp run test:chaos
vp run test:diagnostics
```

Expected: deliberate threshold/correctness regressions fail the release summary;
a clean run reports all required dimensions green.

### Step 7: Write operator runbooks and execute the full gate

Document: host unreachable, readiness red, reconnect loop, replay gap, semantic
resync storm, history disk pressure/corruption, auth denial/revoke, high memory,
slow typing, failed update/restart, and support-bundle review/deletion. Each
runbook maps only typed signals to safe action; never asks users to paste terminal
content by default.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:diagnostics
vp run test:bench
vp run test:soak -- --duration=10m
vp run build:server
vp run build:web
```

Expected: all commands pass and the release quality report has no missing required signal.

## Test plan

- Allowlist schema/cardinality/unknown-field and canary secret leakage tests.
- Correlation and phase timing without content.
- Liveness/readiness/status auth and non-blocking metrics collection.
- Bundle permission/atomicity/size/alias/redaction/dry-run.
- SLO registry semantic fences, units, profiles, variance, threshold failure.
- Integration of conformance, compatibility, chaos/soak, and performance reports.

## Done criteria

- [ ] Telemetry fields and labels are allowlisted, bounded, and content-free.
- [ ] Operators can distinguish liveness, readiness, and detailed authenticated status.
- [ ] Support bundles are explicit, local, bounded, reviewable, and contain no terminal/auth/path content.
- [ ] SLOs have semantic completion fences, named environments, and immutable review history.
- [ ] Release reports enforce terminal correctness, latency, history, resource, and recovery objectives.
- [ ] Diagnostics cannot block PTY ownership or become a control plane.
- [ ] Diagnostics, server, bench, soak-smoke, type, lint, and build gates pass.

## STOP conditions

- Useful telemetry is claimed to require terminal input/output, titles, CWD, environment, or secrets.
- A vendor/cloud endpoint becomes mandatory or bundles auto-upload.
- Metrics introduce unbounded labels or collection blocks a terminal actor.
- A benchmark succeeds based on sleep/end-of-command rather than semantic paint/state.
- Thresholds are weakened after final measurements without review history.
- A support bundle includes databases, archives, browser credential storage, or screenshots.

## Maintenance notes

Observability must remain content-safe by construction, not by best-effort key
redaction. Every new metric/bundle field needs taxonomy review. Keep release
objectives tied to stable corpora and environments; profiles guide optimization,
while zero-tolerance correctness gates never get averaged away.
