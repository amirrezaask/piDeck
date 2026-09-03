# Plan 029: Measure Rust release profiles and package native Ghostty portably

> **Executor instructions**: Complete Plans 020, 023, and 027 first. Compare
> profile candidates without editing the committed profile between runs. Preserve
> existing release/Tauri scripts and build all supported targets. Apply only a
> candidate that improves a recorded user or distribution metric without
> breaking diagnostics. Mark this plan and its README row `DONE` after packaging
> gates pass on Linux, macOS, and Windows.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 8bbcd017..HEAD -- \
>   apps/server/Cargo.toml apps/server/Cargo.lock apps/server/package.json \
>   scripts/build-release.mjs scripts/prepare-desktop-server.mjs \
>   apps/desktop/src-tauri/tauri.conf.json \
>   .github/workflows/ci.yml package.json docs/architecture
> git diff --stat -- \
>   apps/server/Cargo.toml apps/server/Cargo.lock apps/server/package.json \
>   scripts/build-release.mjs scripts/prepare-desktop-server.mjs \
>   apps/desktop/src-tauri/tauri.conf.json \
>   .github/workflows/ci.yml package.json docs/architecture
> ```
>
> Confirm the release server already links Plan 020's exact native Ghostty
> artifact and Plan 023 compatibility tests pass.

## Status

- **Status**: BLOCKED (Plan 023)
- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 020, 023, and 027
- **Category**: Rust / build / packaging / performance
- **Planned at**: commit `8bbcd017`, 2026-08-30
- **Source finding**: SolPro Rust release-build and platform recommendation

## Why this matters

The server manifest has no measured release profile. LTO, codegen unit count,
strip policy, and panic strategy can change binary size, startup, terminal
throughput, build time, and crash diagnostics. Native Ghostty also adds a static
archive that must reach standalone and Tauri-sidecar releases on every supported
OS without runtime library lookup.

The repository needs one portable measured profile and packaging checks. A local
`target-cpu=native` result is not a distributable optimization.

## Current state

`apps/server/Cargo.toml` is a standalone manifest with no `[profile.release]`.
`apps/server/package.json` runs `cargo build --release --locked`.
`scripts/build-release.mjs` builds embedded web and copies the host binary to
`dist/`. `prepare-desktop-server.mjs` builds for Tauri's target triple and copies
it under `apps/desktop/src-tauri/binaries/`. CI compiles release binaries on
Ubuntu, macOS, and Windows but does not inspect linked libraries or package-run
the sidecar on every target.

## Candidate matrix

Start with the actual default profile, then isolate:

```text
baseline Cargo release
a) lto = "thin"
b) lto = true (fat)
c) codegen-units = 1
d) selected LTO + codegen-units = 1
e) strip policy candidate
f) panic = "abort" only if unwind behavior/diagnostics permit
```

Keep `opt-level=3` unless measurement justifies another portable setting. Never
set `target-cpu=native` or depend on the build runner's instruction set.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Candidate matrix | focused builder/benchmark commands from Steps 1–3 | reproducible profile table |
| Server gates | `vp run test:server && vp run test:terminal:integration` | correctness passes |
| Standalone | `vp run build:release` | static packaged binary smoke passes |
| Desktop | `vp run build:desktop && vp run test:desktop` | native sidecar passes |
| Platform | existing `runtime-platform` CI plus platform E2E | Linux/macOS/Windows pass |

## Scope

**In scope**

- Reproducible profile-candidate build/measurement command
- `apps/server/Cargo.toml` selected `[profile.release]` settings
- Clean/incremental build time, binary/compressed size, startup, RSS, and server
  workload comparison
- Static Ghostty/link dependency inspection
- Standalone embedded-web and Tauri sidecar preparation/launch tests
- Linux x64, macOS arm64, and Windows x64 existing support matrix
- Release metadata/checksums and diagnostics/strip policy
- CI/release scripts and architecture docs
- `plans/README.md`

**Out of scope**

- WASM optimization: Plan 028.
- Source-level Rust/terminal optimization.
- New supported targets, universal macOS binaries, installers, signing, or updates
  unless existing release flow already owns them.
- `target-cpu=native`, profile-guided optimization, or nightly-only flags.
- Changing Ghostty revision or dynamic library policy.

## Steps

### Step 1: Add a controlled profile-candidate builder

Create a script that uses separate target directories and Cargo profile
environment overrides or generated temporary config. It must not rewrite
`Cargo.toml` for each sample. Capture:

- candidate settings and rustc/Cargo/target versions;
- Ghostty revision/Zig/native archive hash;
- clean and warm incremental wall/CPU time;
- output binary hash/bytes and gzip/brotli or platform package size;
- linked dynamic libraries/import table;
- symbols/debug information retained.

Build candidates serially with the same lockfile, web artifact, target, and
machine. Keep outputs outside tracked `dist`/desktop sidecar paths.

**Verify**:

```bash
# Run the candidate builder's list/smoke command.
```

Expected: baseline and one candidate build into distinct paths with complete
metadata and unchanged manifests.

### Step 2: Define release correctness and diagnostics gates

Before performance comparison, run each viable candidate through:

- server unit/integration/platform tests;
- embedded-web startup and health/RPC/WS smoke;
- PTY spawn/input/output/resize/close/reconnect;
- native Ghostty query/title/cwd behavior;
- history/replay shutdown;
- controlled panic/startup error diagnostics.

Reject `panic=abort` if the server relies on unwinding for cleanup/tests or if it
makes service diagnostics unacceptable. Define whether production strips all,
debug, or symbol-table data and where crash symbols live. Do not reduce security
checks or error context for size.

**Verify**:

```bash
vp run test:server
vp run test:terminal:integration
vp exec playwright test --project=platform-e2e
```

Expected: every candidate considered for selection passes the same gates.

### Step 3: Measure runtime and distribution trade-offs

Use fixed release binaries and serial repeated runs. Measure:

```text
cold process-to-listening startup
first PTY create and first output
1/8/64 terminal throughput and tail latency
native Ghostty corpus/replay
history compression/replay
idle and flood RSS/CPU
shutdown/close completion
binary and compressed package size
clean and incremental build duration
```

Use Plan 027 end-to-end browser scenarios only where server profile can affect
them; keep server-local measurements for attribution. Record medians/p95/p99,
hardware/OS, and peak RSS. Decide thresholds before reading final results.

Full LTO may be rejected for CI/release build cost even when binary runtime is
slightly faster. Keep baseline if improvements fall within noise.

**Verify**:

```bash
# Run the focused Rust release benchmark command added by this plan.
vp run test:bench
```

Expected: one decision table compares all candidates on runtime, size, memory,
and build cost.

### Step 4: Commit only the selected portable profile

Add the selected `[profile.release]` values to the standalone server manifest.
Document each nondefault value with the measurement artifact/date, without
embedding machine-specific paths. If baseline wins, commit no profile tweak and
record the measured rejection.

Run a clean locked release build and compare its metadata to the selected
candidate. Profile settings must apply consistently to the server and static
Ghostty dependency.

**Verify**:

```bash
# Use a new dedicated CARGO_TARGET_DIR chosen by the candidate script.
cargo build --release --locked --manifest-path apps/server/Cargo.toml
```

Expected: clean output in that dedicated directory matches selected settings and
passes smoke tests. Do not remove an operator's existing target caches.

### Step 5: Harden standalone release packaging

Update `build-release.mjs` to run Plan 020 source preparation/checks and verify:

- embedded web build identity;
- exact Ghostty revision/static link;
- expected executable path/permissions;
- no runtime `ghostty-vt` dynamic dependency;
- checksum and release metadata;
- launch/health/PTY smoke from the copied `dist` binary.

Use `ldd`/`readelf`, `otool`, and Windows PE/import tooling through a
cross-platform abstraction. Reject only unexpected Ghostty linkage, not required
OS libraries.

**Verify**:

```bash
vp run build:release
# Run packaged server smoke command added by this step.
```

Expected: copied standalone artifact starts and owns a PTY with no external
Ghostty library.

### Step 6: Harden Tauri sidecar target handling

Update `prepare-desktop-server.mjs` to invoke source preparation, build the exact
Tauri target with selected profile, copy the correct extension/name, verify
checksum/static linkage, and launch-test the sidecar's install/status boundary
where CI permits.

Cross-target builds may not execute on the host; native CI jobs must execute
their own sidecar. Ensure dev/release paths do not share stale artifacts and the
Web/Tauri clients still share packages.

**Verify**:

```bash
vp run build:desktop
vp run test:desktop
```

Expected: sidecar path matches Tauri config and native launch test passes.

### Step 7: Gate all supported platforms

Extend runtime-platform CI with candidate-selected release metadata, linked
library inspection, standalone smoke, desktop sidecar preparation, and native
Ghostty revision assertion. Cache source/native archive using Plan 020 keys, not
final binaries across commits.

Update docs with selected/rejected profile data and packaging commands.

**Verify**:

```bash
vp run lint:server:rust
vp run test:server
vp run test:terminal:integration
vp run build:release
vp run build:desktop
vp exec playwright test --project=platform-e2e
```

Expected locally: all applicable commands pass. Completion requires green
Ubuntu, macOS, and Windows jobs.

## Test plan

- Candidate isolation/metadata and unchanged manifests.
- Correctness/diagnostics per viable profile.
- Startup, 1/8/64 terminals, replay/history, RSS, shutdown, size/build time.
- Static-link/import inspection on three OS targets.
- Copied standalone executable launch/PTY smoke.
- Tauri sidecar naming, permissions, checksum, and native launch.

## Done criteria

- [ ] Baseline and profile candidates use identical source/artifacts/workloads.
- [ ] Selection accounts for runtime, memory, size, diagnostics, and build cost.
- [ ] No `target-cpu=native` or runner-specific CPU instruction requirement ships.
- [ ] Committed profile exactly matches the selected candidate, or baseline rejection is recorded.
- [ ] Standalone and Tauri packages contain statically linked exact-revision Ghostty.
- [ ] Packaged artifacts launch and run PTY smoke tests on supported OS jobs.
- [ ] Release metadata/checksums and linked-library checks pass.

## STOP conditions

- Candidate builds use different source, web assets, Ghostty revision, or workload.
- A setting loses required diagnostics/cleanup/security behavior.
- Packaging needs a runtime system Ghostty library.
- Cross-target artifact is treated as executed without a native runner.
- `target-cpu=native`, nightly-only, or local linker assumptions enter release.
- Tiny runtime noise is used to justify large CI/build-time cost without thresholds.
- Work expands into source optimization or installer/signing features.

## Maintenance notes

Re-measure release profiles after major Rust, linker, Ghostty, or dependency
changes. Keep build metadata sufficient to reproduce a distributed binary.
Every packaging path should prove the exact native Ghostty revision and run a
real PTY smoke test, not stop at file existence.
