# Plan 028: Select Ghostty WASM optimization mode and verify SIMD/features

> **Executor instructions**: Complete Plans 020, 022, and 027 first. Build all
> candidates from the same prepared source and benchmark them with the same
> harness. Keep candidates outside tracked vendor paths until selection. Preserve
> current artifacts and stop on any revision/feature mismatch. Mark this plan
> and its README row `DONE` after reproducible artifact and browser gates pass.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 8bbcd017..HEAD -- \
>   packages/ghostty-core/src/vendor \
>   packages/ghostty-react/src/vendor \
>   packages/ghostty-react/scripts/build-ghostty-wasm.sh \
>   scripts package.json tests/bench .github/workflows/ci.yml \
>   docs/terminal-renderers.md
> git diff --stat -- \
>   packages/ghostty-core/src/vendor \
>   packages/ghostty-react/src/vendor \
>   packages/ghostty-react/scripts/build-ghostty-wasm.sh \
>   scripts package.json tests/bench .github/workflows/ci.yml \
>   docs/terminal-renderers.md
> ```
>
> Confirm Plan 020's preparation command reports the same revision as both vendor
> VERSION files and Plan 022 parity passes before building candidates.

## Status

- **Status**: TODO
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 020, 022, and 027
- **Category**: WASM / build / performance / compatibility
- **Planned at**: commit `8bbcd017`, 2026-08-30
- **Source finding**: SolPro ReleaseFast, SIMD, and subsystem-build recommendation

## Why this matters

The current build hardcodes `ReleaseSmall`. Ghostty's parser may run faster under
`ReleaseFast`, but the larger module can cost more download, compile, startup,
and memory. CI also does not prove that the shipped artifact contains intended
SIMD instructions or only expected imports/exports.

The repository needs a controlled candidate matrix and an artifact manifest so
the selected mode follows measured YAADE workloads rather than upstream claims.

## Current state

`build-ghostty-wasm.sh` invokes Ghostty with `-Demit-lib-vt`,
`-Dtarget=wasm32-freestanding`, `-Doptimize=ReleaseSmall`, and stripping. It copies
one result into both `ghostty-core` and compatibility vendor directories. The
small write-PTY helper also builds ReleaseSmall but has a different role.

No script builds alternate outputs without overwriting tracked files. CI does
not inspect Wasm instructions, features, imports, exports, custom build metadata,
or compressed size.

## Target artifact contract

```text
artifact-manifest.json
  Ghostty revision
  Zig version and source/build flags
  optimization mode
  feature switches
  raw/gzip/brotli bytes + SHA-256
  imports/exports and required SIMD instruction families
  benchmark run IDs and selected/rejected result
```

The manifest is generated and checked from source/build output. Runtime loaders
validate a lightweight version/hash contract without parsing the whole manifest
on each terminal creation.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Candidate build | dual-build command introduced in Step 1 | isolated Small/Fast artifacts |
| Artifact inspection | checker introduced in Step 3 | revision/SIMD/import/export checks pass |
| Semantic parity | `vp run test:ghostty:parity` | every candidate considered is exact |
| Performance | `vp run test:bench` | reproducible selection table |
| Release builds | `vp run build:web && vp run build:desktop` | selected artifact packages |

## Scope

**In scope**

- Parameterized Ghostty WASM build with isolated output paths
- ReleaseSmall and ReleaseFast candidate artifacts
- Inspection of supported lib-vt build feature switches
- Pinned WASM inspection tooling and artifact manifest/check command
- Actual SIMD instruction/import/export validation
- Plan 022 parity and Plan 027 startup/throughput/replay/memory comparison
- Checked vendor artifact replacement after selection
- Supported browser/WebView feature tests and CI
- Documentation and `plans/README.md`

**Out of scope**

- Rust release profiles/static packaging: Plan 029.
- Ghostty revision upgrade.
- Rewriting SIMD/parser code or using JS preprocessing.
- Disabling terminal protocol features for size without compatibility proof.
- Shipping multiple artifacts unless a supported runtime requires a tested fallback.
- Shaping cache or GPU renderer changes.

## Steps

### Step 1: Parameterize reproducible candidate builds

Extend the build command with validated inputs:

```text
optimization = ReleaseSmall | ReleaseFast
output directory (must not be tracked vendor path for comparison)
strip/debug policy
explicit inspected lib-vt feature set
```

Build candidate files in ignored temporary/artifact directories. Embed or emit
revision, Zig, flags, and source identity. Make deterministic rebuilds compare
byte hashes; if upstream build timestamps prevent byte identity, identify and
remove that input or document a canonical content check.

Keep `ghostty-write-pty.wasm` separate. Benchmark or rebuild it only when its
measured contribution warrants a mode change.

**Verify**:

```bash
# Run the dual-candidate build command added by this step.
vp run check:ghostty-source
```

Expected: Small/Fast differ only by optimization metadata/code; both report the
same revision, target, strip policy, and features.

### Step 2: Inspect available build features before removing anything

Read the pinned Ghostty build definitions and public build info. List each
feature included in `emit-lib-vt`, its artifact/runtime cost where measurable,
and the YAADE compatibility fixture that needs it. Do not invent unsupported
flags from newer Ghostty versions.

A removable feature needs:

- a public build switch at the pinned revision;
- no use in Plan 022 and terminal compatibility E2E;
- a measured size/startup benefit;
- no loss of query, Unicode, OSC, keyboard, mouse, synchronized-output, formatter,
  or public render behavior needed by Plans 021–025.

Default to the existing feature set when evidence is incomplete.

**Verify**: a checked decision table maps build flags to tests and measurements.

### Step 3: Add pinned Wasm instruction and interface inspection

Choose one pinned tool available in CI, such as a fixed `wasm-tools` release.
Generate/check:

- module validity and required feature declarations;
- expected imports only;
- required libghostty-vt exports and helper exports;
- memory/table limits and unexpected mutable globals;
- actual SIMD opcodes/instruction families in parser code;
- raw/gzip/brotli size and SHA-256;
- build-info/revision when exported.

Checking browser SIMD support alone does not prove the module uses SIMD. Checking
one `v128.const` inserted by unrelated code is also insufficient; tie expected
instruction families to inspected Ghostty build output and compare scalar control
candidate only when necessary.

Add deliberate wrong-revision, missing-export, unexpected-import, scalar, and
oversize fixtures for the checker.

**Verify**:

```bash
# Run the artifact inspection command added by this step for both candidates.
```

Expected: valid manifests are emitted; mutated fixtures fail specific checks.

### Step 4: Run semantic parity for every candidate

Run Plan 022's entire corpus against ReleaseSmall and ReleaseFast plus any
feature-reduced candidate. Require exact rows/state/effects and build revision.
Also run browser compatibility tests in Chromium and supported Tauri WebViews.

Reject a candidate on semantic mismatch, unsupported WASM feature, worker load
failure, CSP/import change, or helper mismatch before performance comparison.

**Verify**:

```bash
vp run test:ghostty:parity
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts
vp run test:desktop
```

Expected: each candidate considered for selection passes exact compatibility.

### Step 5: Compare startup, throughput, replay, and memory

Use Plan 027 with identical corpora/environment and serial runs. For each
candidate record:

- raw, gzip, and brotli bytes;
- fetch/cache, compile, instantiate, and core-init p50/p95/p99;
- first terminal ready and six-terminal reused-worker startup;
- ASCII, Unicode, ANSI, and TUI parse throughput;
- packed update and 512 KiB/16 MiB replay time;
- steady/peak worker memory and WASM memory growth;
- browser and Tauri results.

Warm and cold startup are separate scenarios. Rebuild once outside measurement.
Choose ReleaseFast only when throughput/replay gains exceed measured
startup/download/memory cost for normal YAADE reuse. Keep ReleaseSmall when gains
are noise or regress user-visible startup. Record thresholds before reading final
numbers.

**Verify**:

```bash
vp run test:bench
```

Expected: a reproducible decision table selects one artifact and rejects others.

### Step 6: Replace vendor artifacts atomically

Copy the selected `ghostty-vt.wasm` and helper artifact from one verified output
into both vendor directories. Update generated manifest/hash metadata. Assert the
copies are byte-identical and VERSION remains unchanged.

Loader tests verify selected hash/revision/features before core creation. Do not
leave candidate files in source or silently support mixed old/new copies.

**Verify**:

```bash
sha256sum packages/ghostty-core/src/vendor/*.wasm \
  packages/ghostty-react/src/vendor/*.wasm
vp test packages/ghostty-core packages/ghostty-react
```

Use the platform hash equivalent on Windows CI. Expected: corresponding vendor
hashes match and loader tests pass.

### Step 7: Make artifact checks release/CI gates

Run source check, deterministic selected build, manifest verification, parity,
compressed-size budget, required SIMD/import/export checks, browser build, and
Tauri compatibility in CI. Release packaging must fail on stale vendor bytes or
manifest.

Document the selected mode and measurements without claiming Ghostty's upstream
numbers as YAADE results.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:ghostty:parity
vp run test:bench
vp run build:web
vp run build:desktop
```

Expected: all pass; CI catches scalar/wrong-revision/stale/oversize artifacts.

## Test plan

- Candidate build inputs, output isolation, revision/features, reproducibility.
- Manifest parser bounds and mutated artifact failures.
- Real SIMD instruction, import/export, memory, and build-info checks.
- Full native/WASM corpus per candidate.
- Cold/warm startup, parse, replay, update, memory across browser/Tauri.
- Vendor-copy identity and release stale-artifact failures.

## Done criteria

- [ ] Small/Fast candidates come from identical pinned source/toolchain/features.
- [ ] Feature decisions map to compatibility tests and measured benefit.
- [ ] CI inspects actual SIMD instructions plus imports/exports/revision/hash.
- [ ] Every candidate considered passes Plan 022 parity and supported runtime tests.
- [ ] Selection includes compressed size, startup, throughput, replay, and memory.
- [ ] Both vendor locations contain one selected byte-identical artifact.
- [ ] Release builds fail on stale or mismatched artifact metadata.
- [ ] Documentation records evidence and avoids unsupported speed claims.

## STOP conditions

- Candidate source revision, Zig, target, strip, or features differ unintentionally.
- SIMD validation checks capability/flags without module instructions.
- A feature is removed without corpus and E2E coverage.
- Candidate output overwrites tracked vendor artifacts before selection.
- Benchmark comparison includes build time or changes runtime/corpus/hardware.
- Multiple artifacts are shipped without a proven compatibility need, bounded
  loader policy, and memory/download tests.
- Work expands into Rust profiles, server migration, or renderer caches.

## Maintenance notes

Re-run candidate, parity, and artifact checks for every Ghostty or Zig change.
Artifact size alone cannot choose parser optimization. Keep the manifest/tool
pinned so CI failures identify source, feature, interface, or instruction drift.
