# Plan 020: Pin, build, and validate native libghostty-vt

> **Executor instructions**: Follow each step in order. Run the verification
> command before continuing. Preserve all working-tree changes. Stop at a listed
> STOP condition instead of inventing a private ABI. Update this file and
> `plans/README.md` to `DONE` after the required verification gate passes or an
> explicit completion-gate waiver is recorded.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 8bbcd017..HEAD -- \
>   packages/ghostty-core/src/vendor/VERSION \
>   packages/ghostty-react/scripts/build-ghostty-wasm.sh \
>   scripts package.json apps/server/package.json \
>   crates .github/workflows/ci.yml
> git diff --stat -- \
>   packages/ghostty-core/src/vendor/VERSION \
>   packages/ghostty-react/scripts/build-ghostty-wasm.sh \
>   scripts package.json apps/server/package.json \
>   crates .github/workflows/ci.yml
> ```
>
> Use the live content of `packages/ghostty-core/src/vendor/VERSION`. At plan
> creation it is `9f62873bf195e4d8a762d768a1405a5f2f7b1697`. Do not replace it with
> the revision quoted in the external review or a moving branch.
>
> **Completion note**: On 2026-08-31 the user explicitly waived waiting for the
> hosted CI run. Completion is based on passing local tests plus offline native
> artifact builds for the supported macOS, Linux, and Windows targets. The CI
> matrix remains configured as a follow-up verification.

## Status

- **Status**: DONE
- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: build / ffi / portability
- **Planned at**: commit `8bbcd017`, 2026-08-30
- **Source finding**: SolPro P1-7 prerequisite

## Why this matters

The browser builds libghostty-vt from one pinned Ghostty commit, but the Rust
server has no native Ghostty dependency. A server migration needs reproducible
native libraries and ABI checks before safe wrappers or parser behavior enter
the host. Ghostty labels this C API unstable, so an unverified header or symbol
change can compile into memory corruption.

This plan creates only the source/toolchain/build/ABI foundation. It does not
write a safe terminal wrapper or change server behavior.

## Current state

`scripts/prepare-ghostty-source.mjs` now validates the shared `VERSION`, prepares
a clean content-addressed checkout, pins Zig 0.15.2 with platform-specific
SHA-256 checksums, and supports explicit offline source and compiler paths.
The browser WASM build consumes this preparation result and reproduces the
checked-in bytes.

`crates/ghostty-vt-sys` builds the pinned public library without network access,
links it statically, checks generated bindings, and exercises C/Rust ABI and
terminal lifecycle tests. SIMD is disabled because the pinned revision's C++
SIMD dependencies fail against the macOS 27 SDK; Plan 028 owns re-enabling it.
Native release artifacts were built offline for macOS arm64, Linux x86_64, and
Windows x86_64. The hosted Rust matrix remains configured for follow-up coverage;
its run was explicitly waived as a completion gate.

## Target architecture

```text
packages/ghostty-core/src/vendor/VERSION       one revision authority
scripts/prepare-ghostty-source.*               explicit, cross-platform preparation
crates/ghostty-vt-sys/
  build.rs                                     native static build in OUT_DIR
  src/bindings.rs                              checked-in minimal public C surface
  tests/abi.c + tests/abi.rs                   C/Rust layout and symbol checks

WASM build ─┐
Native build├─ same source path, revision, Zig version, and cache identity
CI/release ─┘
```

Normal Cargo compilation must never choose a different source revision. An
unprepared build may fail with one actionable preparation command; it must not
silently fetch mutable network content.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Source preparation | `vp run prepare:ghostty && vp run check:ghostty-source` | exact revision/Zig/cache checks pass |
| Sys tests | `cargo test --manifest-path crates/ghostty-vt-sys/Cargo.toml` | ABI/symbol/smoke tests pass |
| Sys lint | `cargo clippy --manifest-path crates/ghostty-vt-sys/Cargo.toml --all-targets -- -D warnings` | exit 0 |
| Existing builds | `vp run build:server && vp run build:web` | no regression |
| Platform gate | existing `runtime-platform` CI matrix | Linux/macOS/Windows pass |

## Scope

**In scope**

- `crates/ghostty-vt-sys/**` (new standalone Cargo package)
- A cross-platform preparation/check script under `scripts/`
- Root/server scripts needed to run preparation before builds
- `packages/ghostty-react/scripts/build-ghostty-wasm.sh` only to consume the
  shared preparation result
- Minimal checked-in generated bindings and a regeneration/check command
- Native static linking for supported Linux, macOS, and Windows targets
- ABI, layout, discriminant, symbol, revision, and lifecycle smoke tests
- `.github/workflows/ci.yml`
- Build documentation and `plans/README.md`

**Out of scope**

- Safe Rust ownership, callbacks, or render iterators: Plan 021.
- Native/WASM semantic fixtures: Plan 022.
- `apps/server` parser migration: Plan 023.
- Ghostty state persistence or private Zig headers.
- A Ghostty revision upgrade unrelated to a proven build blocker.
- Dynamic system-library discovery.

## Steps

### Step 1: Specify the source and toolchain contract

Create one preparation command that:

- validates `VERSION` as one 40-character lowercase hexadecimal revision;
- uses an explicit content-addressed cache directory;
- checks `git rev-parse HEAD` and rejects a dirty cached checkout;
- pins Zig version and verifies downloaded archive checksums per OS/architecture;
- supports Linux, macOS, and Windows runners;
- accepts explicit offline `GHOSTTY_SOURCE_DIR` and `GHOSTTY_ZIG` paths;
- prints revision, source path, Zig path/version, and cache key;
- offers `prepare` and network-free `check` modes.

Keep download work outside `build.rs`. Add a root/package script used by
`build:server`, release packaging, and CI. Direct Cargo builds without prepared
source fail with that script name and required environment variables.

**Verify**:

```bash
# Use the command name introduced by this step.
vp run prepare:ghostty
vp run check:ghostty-source
vp run check:ghostty-source
```

Expected: both checks report the same revision and paths; the second invocation
performs no download or checkout mutation.

### Step 2: Make the WASM build consume the shared preparation result

Remove source/Zig download logic from `build-ghostty-wasm.sh`. Have it call the
shared helper and use its resolved paths. Build the current ReleaseSmall module
without changing checked-in bytes intentionally.

Add a fixture that fails when WASM `VERSION`, source `HEAD`, or prepared cache
identity disagree. Do not make this step choose ReleaseFast; Plan 028 owns that
experiment.

**Verify**:

```bash
vp run --filter @yaade/ghostty-react build:ghostty-wasm
git diff -- packages/ghostty-core/src/vendor/VERSION \
  packages/ghostty-react/src/vendor/VERSION
```

Expected: revision files agree and preparation has one implementation.

### Step 3: Add `ghostty-vt-sys` and native static linking

Create `crates/ghostty-vt-sys`. Its `build.rs`:

- reads the repository `VERSION` through a stable relative/environment contract;
- validates the prepared source and Zig version without network access;
- maps Cargo target triples to inspected Ghostty/Zig targets;
- builds `-Demit-lib-vt` into a revision/target/profile keyed `OUT_DIR` cache;
- links the produced static library and required platform libraries;
- emits narrow `rerun-if-changed` directives for VERSION, headers, and build code;
- checks required symbols and `ghostty_build_info` before success.

Inspect the pinned build output. Do not guess archive names, calling conventions,
or platform libraries. Use optimized native code for release. Debug mode may use
a faster compile profile only after layout/semantic equivalence tests pass.

**Verify**:

```bash
cargo build --manifest-path crates/ghostty-vt-sys/Cargo.toml
cargo build --release --manifest-path crates/ghostty-vt-sys/Cargo.toml
```

Expected: both link from the exact prepared source without a runtime Ghostty
library lookup.

### Step 4: Generate a minimal checked-in binding surface

Generate bindings from the pinned public headers for only the opaque handles,
sized structs, callbacks, enums, options, data keys, and functions required by
Plans 021–024. Check generated Rust into the sys crate so normal builds do not
require libclang. Add a maintainer regeneration command with check mode.

The sys crate may expose unsafe declarations but no terminal policy. Deny
warnings where generated code permits. Add safety comments around helper unsafe
blocks; do not bind private page/grid implementation structs.

**Verify**:

```bash
# Run the regeneration command in check mode.
cargo test --manifest-path crates/ghostty-vt-sys/Cargo.toml
```

Expected: regeneration produces no diff and all declared symbols link.

### Step 5: Validate the ABI from C and Rust

Compile a small C verifier against the same headers. Compare C and Rust values
for:

- size, alignment, and offsets of every non-opaque cross-FFI struct;
- enum/option/data-key discriminants;
- callback calling conventions and pointer-width types;
- required exported symbol set;
- sized-struct initialization and zero/default rules;
- build-info revision and enabled lib-vt feature.

Add terminal create/write/resize/reset/free smoke calls with malformed and empty
input. Run sanitizer jobs where supported. Tests must fail on a stale header,
stale generated binding, wrong revision, or wrong target archive.

**Verify**:

```bash
cargo test --manifest-path crates/ghostty-vt-sys/Cargo.toml
cargo clippy --manifest-path crates/ghostty-vt-sys/Cargo.toml --all-targets -- -D warnings
```

Expected: layout, symbols, revision, and smoke lifecycle pass.

### Step 6: Add the three-platform CI gate

Prepare/cache exact Ghostty and Zig in the existing `runtime-platform` matrix.
Run regeneration-check, ABI tests, debug/release link, and a no-runtime-library
lookup assertion on Ubuntu, macOS, and Windows. Cache keys include OS, target,
revision, Zig, and build profile.

Keep the existing server build green even though the server does not use the sys
crate yet. Document the source preparation command and ABI upgrade checklist.

**Verify**:

```bash
vp run build:server
vp run build:web
```

Expected locally: builds pass. The hosted three-platform jobs remain configured;
their execution was explicitly waived as a completion gate.

## Test plan

- Source: invalid/empty revision, dirty/wrong checkout, offline mode, checksum,
  cold and warm cache.
- Build: debug/release, three OS targets, cache identity, missing preparation.
- ABI: C/Rust size/alignment/offset/discriminants, symbols, build-info revision.
- Smoke: allocate/write/resize/reset/free, malformed bytes, repeated lifecycle.
- CI: checked-in binding drift and no dynamic Ghostty dependency.

## Done criteria

- [x] One VERSION file identifies browser and native source.
- [x] Source/Zig preparation is explicit, checksum-verified, cached, and cross-platform.
- [x] Native libghostty-vt artifacts build for Linux, macOS, and Windows targets.
- [x] Checked-in public bindings regenerate without diff.
- [x] C/Rust ABI, symbols, and build revision are tested.
- [x] Normal Cargo builds do not silently fetch network source.
- [x] No safe wrapper or server parser behavior leaked into this plan.
- [x] All local checks and offline cross-target builds pass; hosted CI remains configured.

## STOP conditions

- A supported target cannot build the pinned public lib-vt artifact.
- Native and WASM preparation cannot prove the same revision.
- Correct linking requires private Ghostty implementation headers or raw page
  layout declarations.
- Normal builds require moving source, unverified downloads, or system Ghostty.
- Bindings require libclang during every user build.
- The implementation begins safe-wrapper or server-migration work from later plans.

## Maintenance notes

Treat each VERSION change as an ABI migration. Regenerate bindings, rerun C/Rust
layout checks, rebuild every target, and run Plan 022's semantic corpus before
merging an upgrade. The sys crate should stay small enough for reviewers to
inspect every public declaration and unsafe helper.
