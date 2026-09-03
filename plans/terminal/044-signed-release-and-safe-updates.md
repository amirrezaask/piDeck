# Plan 044: Ship signed, reproducible releases and updates that never surprise running terminals

> **Executor instructions**: Complete Plans 029, 032, 040, and 042 first. Plan
> 043 must have reached an evidence-backed desktop/iOS platform decision; build
> and advertise only the accepted platform set. Preserve all pre-existing
> working-tree changes. Release credentials must live only in the CI secret or
> signing service; never add key material to the repository, logs, fixtures, or support bundles. The host
> owns PTYs and all PTYs die on host restart, so an updater may download in the
> background but must not automatically restart an active host. Update this plan
> and `plans/README.md` to `DONE` only after staging-channel install/update/
> rollback evidence passes.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat a0bb3fc9..HEAD -- \
>   apps/server apps/desktop apps/web package.json pnpm-workspace.yaml \
>   .github/workflows docs tests/release plans/blocked/029-rust-release-profile-and-packaging.md
> git diff --stat -- \
>   apps/server apps/desktop apps/web package.json pnpm-workspace.yaml \
>   .github/workflows docs tests/release plans/blocked/029-rust-release-profile-and-packaging.md
> ```

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 029, 032, 040, 042, and 043 (decision)
- **Category**: release engineering / supply chain / updates
- **Planned at**: commit `a0bb3fc9`, 2026-08-30
- **Source finding**: Superlogical production distribution and lifecycle quality

## Why this matters

A high-quality native terminal product is not complete at `build:desktop`. Users
need verifiably signed host/desktop/mobile artifacts, provenance, upgrade
compatibility, rollback guidance, and a safe update UX. YAADE has a uniquely
important constraint: restarting the host ends every PTY. Silent auto-update can
therefore kill long-running agents. Distribution must separate download from
apply, show active work, preserve Plan 032 metadata/history, and require explicit
operator action before host restart.

## Current state

- Plan 029 owns Rust release profile, native Ghostty linkage, packaging checks,
  and artifacts. It does not define signing, channel metadata, updater behavior,
  rollout, or rollback.
- `apps/desktop` starts/uses the host as an OS user service independent of the
  desktop process. Updating the desktop WebView and updating/restarting the host
  are separate lifecycle operations.
- Host restart is process-destructive by architecture even after Plan 032 makes
  workspace catalog/history durable.
- CI builds and tests multiple targets but does not yet produce one attested
  release manifest covering server, web, desktop, iOS, schemas, quality report,
  SBOMs, checksums, and compatibility.
- Persisted compatibility is intentionally allowed to reset during development;
  a published release must never perform a silent reset.

## Release contract

- Every binary/bundle is checksummed, signed/notarized where applicable, tied to
  source commit/toolchain/lockfile, and listed in one signed channel manifest.
- Artifacts include SBOM and provenance/attestation without secret paths.
- Desktop update and host update are independently versioned and compatibility-
  checked. The client never runs an unsupported host mutation.
- Update download may be automatic according to preference; applying an update
  that restarts an active host is always explicit and informed.
- Preflight lists active/running terminals and warns that processes will end. It
  never includes commands/output. Apply is blocked while active PTYs exist unless
  the operator explicitly confirms destructive restart.
- State/archive format incompatibility is detected before mutation, with backup
  or explicit reset/rollback path. No silent partial upgrade.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Artifacts | `vp run release:build -- --channel=staging` | complete staging manifest/artifacts |
| Verify | `vp run release:verify -- --channel=staging` | signatures, SBOM, provenance, versions pass |
| Update E2E | `vp exec playwright test --project=platform-e2e tests/release/update.spec.ts` | download/apply/rollback cases pass |
| Platform | `vp run build:server && vp run build:desktop`; then `vp run build:ios` only for a Plan 043 iOS PASS | accepted release builds pass |
| Quality | `vp run test:compatibility && vp run release:quality` | compatibility/SLO report green |

## Scope

**In scope**

- Version/channel/release manifest and compatibility policy
- Server/desktop/mobile signing, notarization/store metadata hooks
- SBOM, checksums, provenance, reproducibility/secret scanning
- Safe desktop/host update UX, staging rollout, rollback and migration preflight
- CI/release tests, operator documentation, and root/package scripts needed for
  the named `release:*` commands

**Out of scope**

- Committing signing keys or building a custom public key infrastructure
- Silent host restart, zero-downtime PTY migration, or detached supervisor
- A hosted account/control plane
- Reimplementing App Store/OS update mechanisms
- Guaranteeing bit-for-bit binaries where platform signing timestamps prevent it;
  unsigned payload reproducibility is still required

## Steps

### Step 1: Define versions, channels, compatibility, and state policy

Create a machine-readable release manifest schema containing product/channel,
source commit, build timestamp, server protocol/runtime version, terminal codec
versions, state/archive schema versions, minimum/maximum compatible clients and
hosts, platform artifacts, checksums, signature/provenance/SBOM references, and
Plan 042 quality report digest.

Define stable/beta/nightly promotion without rebuilding promoted payloads. State
schema change must declare compatible, explicit migration, or reset-required.
For a published stable update, reset-required needs operator preflight, backup,
and confirmation; startup cannot silently discard state.

**Verify**:

```bash
vp run release:verify -- --manifest=tests/release/fixtures/valid.json
vp run test:compatibility
```

Expected: valid fixture passes; missing artifact, version mismatch, downgrade,
unknown schema, or unsigned quality report fails before installation.

### Step 2: Produce hermetic artifacts, SBOMs, and provenance

Pin Rust/Node/Bun/Vite+/Tauri/mobile toolchains and lockfile install. Build Plan
029 server libraries/binaries, web assets, desktop installers, and an iOS archive
only when Plan 043 records iOS PASS. Build each payload once per commit/channel. Generate platform/package SBOMs, dependency
licenses, checksums, and SLSA-compatible provenance identifying source/workflow.

Normalize timestamps/paths where possible and compare unsigned payloads from two
clean builders for reproducibility. Scan artifacts for repository paths, test
secrets, source maps not intended for release, and private key material.

**Verify**:

```bash
vp run release:build -- --channel=staging
vp run release:reproducibility -- --channel=staging
```

Expected: complete manifest, SBOM/provenance/checksums, no secret/path findings,
and approved reproducibility result.

### Step 3: Integrate platform signing and verification

Sign server archives/checksum manifests with an offline/CI-managed release key.
Sign and notarize macOS desktop, Authenticode-sign Windows, and sign Linux
packages/repositories as applicable. For a Plan 043 iOS PASS, use Apple mobile
signing/App Store/TestFlight for iOS/iPadOS. Apply hardened runtime/entitlement rules matching Plan 043's
minimal capabilities.

Verification runs on a clean target without access to signing secrets and checks
certificate identity, timestamp/notarization, entitlements, manifest chain, and
artifact hash. Rotate/revoke key procedures are documented and tested with public
fixtures only.

**Verify**:

```bash
vp run release:verify -- --channel=staging
```

Expected: all applicable platform signatures/entitlements/notarization pass;
tampered bytes, wrong identity, expired channel metadata, and missing signatures fail.

### Step 4: Add safe desktop and host update orchestration

Implement a shared update-status model with typed native adapter: available,
downloading, downloaded, preflight, blocked-active-terminals, ready, applying,
relaunch-required, failed, and rollback-required. Verify signed metadata and full
artifact before presenting ready.

Desktop-only UI update may apply on app relaunch if compatible. A host update
queries content-free active terminal counts/states and Plan 032 archive flush
readiness. With active PTYs, default action is **Later**; explicit **Stop terminals
and update** states that processes will end and requires confirmation. Never infer
safety from browser disconnection or quiet output.

Before host replacement stop accepting mutations, flush state/history to the
published durability fence, stop PTYs, stop service, atomically replace, start,
verify identity/version/readiness, and surface interrupted terminals. On failure,
restore the prior executable and compatible data snapshot when possible.

**Verify**:

```bash
vp exec playwright test --project=platform-e2e tests/release/update.spec.ts
```

Expected: active-terminal update does not restart without confirmation; confirmed
update preserves catalog/history, ends processes honestly, and reaches new ready version.

### Step 5: Add rollback, downgrade, and failed-migration behavior

Retain one verified previous executable/package and pre-update state metadata
backup with restrictive permissions and bounded retention. Test failed download,
signature, disk full, service stop timeout, binary replace, readiness, state
migration, and client/host compatibility. Automatic rollback may run only when
data format remains backward compatible; otherwise stop with exact recovery
instructions and preserve both copies.

A downgrade must pass manifest compatibility and explicit operator confirmation.
Never run an older binary against newer state optimistically. Mobile/store
rollback follows platform channel mechanics, not custom sideload behavior.

**Verify**:

```bash
vp exec playwright test --project=platform-e2e tests/release/update.spec.ts --grep rollback
```

Expected: every injected phase is atomic or recoverable; no partial executable or
silent state reset is considered success.

### Step 6: Gate promotion on security and quality reports

A release candidate is promotable only when Plan 040 conformance/compatibility,
Plan 041 required soak, Plan 042 SLO/diagnostics, platform tests, vulnerability
policy, SBOM/license review, and signature verification are green for the exact
artifact digest. Promotion changes signed channel metadata only; it does not
rebuild.

Add canary/staged rollout and pause/revoke metadata. Clients use bounded check
frequency/backoff and never accept rollback/freeze metadata without explicit
policy. Record public release notes with terminal lifecycle/state changes.

**Verify**:

```bash
vp run release:quality -- --channel=staging
vp run release:promote -- --from=staging --to=beta --dry-run
```

Expected: promotion dry-run names exact digests and fails if any required report
is missing/red or was produced for another commit/artifact.

### Step 7: Prove clean install, update, and operator recovery

On clean macOS/Windows/Linux targets and, only for a Plan 043 PASS, iOS
simulator/TestFlight staging, test install, first launch/pair, previous→current update, active terminal
warning, interrupted recovery, offline download resume, tamper, identity change,
failed startup, rollback, uninstall, and retained-data policy. Publish verified
install/update/recovery docs and key-compromise response.

**Verify**:

```bash
vp run release:build -- --channel=staging
vp run release:verify -- --channel=staging
vp run release:quality -- --channel=staging
vp exec playwright test --project=platform-e2e tests/release/update.spec.ts
```

Expected: one complete staging campaign passes with retained signed reports and
no signing secret in artifacts/logs.

## Test plan

- Manifest/version/schema/channel validation and promotion-by-digest.
- Clean hermetic build, SBOM/license/provenance, unsigned reproducibility.
- Platform signature/notarization/entitlement and tamper/wrong-identity cases.
- Active/idle/no-terminal update, archive flush, restart/interrupted display.
- Failure at every update phase, rollback compatibility, disk full, offline.
- Clean install/update/uninstall on supported platforms and staged iOS path.

## Done criteria

- [ ] Every release artifact is checksummed, signed, attested, SBOM-listed, and manifest-bound.
- [ ] Client/host/protocol/state/archive compatibility is checked before mutation.
- [ ] Updating an active host never restarts it without explicit destructive confirmation.
- [ ] Confirmed host update preserves catalog/history and reports interrupted processes truthfully.
- [ ] Failed updates are atomic/recoverable and never silently reset state.
- [ ] Promotion uses exact tested artifact digests and requires all quality reports green.
- [ ] One staging install/update/rollback campaign passes on every supported platform.

## STOP conditions

- Signing material would enter the repository, logs, support bundles, or test artifacts.
- Update application requires silent restart of active PTYs or claims process continuity.
- State incompatibility can only be handled by an unannounced reset.
- Promotion rebuilds artifacts or quality reports refer to different digests.
- Rollback would run old code against incompatible new state.
- Platform entitlements/capabilities exceed Plan 043 without security review.

## Maintenance notes

Release engineering is part of terminal correctness because host restart is
destructive to processes. Keep download and apply separate, and make every host
restart an explicit lifecycle event. Rotate signing keys and update compatibility
fixtures without weakening provenance or active-terminal safeguards.
