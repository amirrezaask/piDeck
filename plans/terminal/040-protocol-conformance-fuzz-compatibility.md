# Plan 040: Make protocol conformance, malformed-input fuzzing, and version compatibility release gates

> **Executor instructions**: Complete Plans 015, 017, 018, 022, 023, 033, 037,
> 038, and 039 first. Preserve all pre-existing working-tree changes. This plan
> strengthens tests and CI; it must not redesign protocols or silently normalize
> malformed input. Every failure artifact needs a stable seed
> and minimal replay command. Keep fuzz targets hermetic; never launch arbitrary
> corpus commands or connect to public hosts. Update this plan and
> `plans/README.md` to `DONE` after required and scheduled CI jobs are green.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat a0bb3fc9..HEAD -- \
>   apps/server/src crates/ghostty-vt packages/yaade-rpc/src \
>   packages/yaade-host-client/src packages/ghostty-core/src \
>   tests .github/workflows/ci.yml package.json apps/server/Cargo.toml
> git diff --stat -- \
>   apps/server/src crates/ghostty-vt packages/yaade-rpc/src \
>   packages/yaade-host-client/src packages/ghostty-core/src \
>   tests .github/workflows/ci.yml package.json apps/server/Cargo.toml
> ```

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 015, 017, 018, 022, 023, 033, 037, 038, and 039
- **Category**: tests / security / compatibility
- **Planned at**: commit `a0bb3fc9`, 2026-08-30
- **Source finding**: Superlogical terminal correctness and adversarial quality gates

## Why this matters

YAADE has strong targeted tests, renderer differential plans, and a multi-platform
CI matrix, but terminal/service protocol safety is not yet enforced as one
versioned conformance system. Binary WebSocket frames, semantic patches, archive
manifests, device-auth payloads, and terminal control all accept hostile input.
Deterministic vectors, model/property tests, fuzz targets, sanitizers, and an
explicit compatibility matrix turn regressions into reproducible release
failures instead of production corruption or reconnect loops.

## Current state

- `tests/web/e2e/terminal-compatibility.web.spec.ts` covers important real PTY
  behavior but is scenario-based, not a wire/version certification suite.
- Plan 009 owns complex TUI renderer conformance; Plan 022 owns native/WASM
  semantic differential corpus. Reuse their fixtures and public observation.
- `terminal-stream-v3-codec.ts` and server binary paths require strict malformed
  input coverage after Plan 033.
- Device auth already has a security suite, but cross-route Effect Schema
  decode limits and state-machine property tests are not a unified gate.
- `.github/workflows/ci.yml` tests web and server on multiple platforms; there is
  no dedicated fuzz/sanitizer corpus job or published compatibility report.

## Conformance matrix

At minimum certify:

1. **Terminal parser semantics**: native versus WASM, modes, alternate screen,
   OSC/DCS/CSI, UTF-8/wide/combining, synchronized output, resize/reflow.
2. **Wire protocols**: terminal control/raw/semantic frame versions, bounds,
   sequence/revision/epoch/hash, unknown feature/version behavior.
3. **Persistence**: raw/row archive blocks, manifests, crash tails, retention,
   restart reconciliation.
4. **Auth/authorization**: RPC Effect Schemas, pairing/challenges, scopes,
   grants/invitations when Plan 038 lands.
5. **Compatibility**: previous supported client ↔ current host and current client
   ↔ previous supported host, including capability negotiation and explicit
   unsupported results. No implicit best-effort downgrade.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Unit/protocol | `vp run test:terminal:unit && vp run test:terminal:protocol` | model/vector suites pass |
| Parity | `vp run test:ghostty:parity` | native/WASM corpus agrees |
| Fuzz smoke | `vp run test:fuzz:smoke` | every target completes with no finding |
| Sanitizers | `vp run test:server:sanitizers` | ASan/UBSan supported target passes |
| Compatibility | `vp run test:compatibility` | declared version matrix passes |
| Full | `vp run typecheck && vp run lint && vp run test:server && vp run test:web` | exit 0 |

## Scope

**In scope**

- Versioned corpus/vector format and manifest
- Rust fuzz targets and TypeScript model/property/mutation harnesses
- Cross-language codec vectors and protocol state-machine tests
- Previous/current compatibility fixtures and capability matrix
- CI required smoke, sanitizer, scheduled fuzz, artifact/triage workflow
- Root/server manifests needed for the named commands, including `package.json`
  and `apps/server/Cargo.toml`

**Out of scope**

- Random shell command execution or fuzzing public services
- Persisting private Ghostty memory
- Changing terminal semantics to make a differential pass
- Supporting every historical development snapshot
- Chaos/long-duration system tests; Plan 041

## Steps

### Step 1: Inventory every untrusted decoder and version boundary

Create `tests/conformance/manifest.json` (validated by a checked-in schema) that
names each decoder/state machine, owner language, maximum input, current version,
previous supported version, golden corpus, fuzz target, and compatibility rule.
Include HTTP/RPC bodies, WebSocket control/raw/semantic frames, archive formats,
OSC-derived control payloads, URLs/storage records, and device/collaboration auth.

Fail CI if a wire/persisted schema is exported without a manifest entry. Record
unsupported old formats explicitly rather than inventing compatibility.

**Verify**:

```bash
vp run test:terminal:protocol
```

Expected: manifest schema and coverage test pass; deleting a known decoder entry
fails with its path.

### Step 2: Consolidate deterministic conformance vectors

Define a compact vector envelope with ID, source, format/version, input bytes or
steps, expected decoded value/error class, public terminal observation/hash,
limits, and provenance/license. Move/copy Plan 009/022 fixtures by reference, not
by duplicating large blobs. Add cross-language vectors for every binary codec and
archive header.

For terminal sequences include split at every byte boundary for representative
fixtures, randomized chunk boundaries with fixed seeds, malformed UTF-8, C0/C1,
large numeric parameters, OSC/DCS termination, wide/combining, resize, and
alternate/synchronized output.

**Verify**:

```bash
vp run test:ghostty:parity
vp run test:terminal:protocol
```

Expected: one manifest drives native Rust, WASM/TypeScript, and codec golden tests
with exact IDs in failures.

### Step 3: Add model/property tests for protocol state machines

Write small reference models for attach/ACK/replay/resync, semantic
snapshot/patch, writer lease/mutation fence, device pairing/challenge/session,
and archive publish/recover. Generate valid and invalid operation sequences with
fixed seeds and shrinking. Invariants include monotonic cursors/revisions,
exactly one writer, no ACK beyond sent bytes, bounded queues, resync convergence,
one-use challenges, and no visibility after revoke.

Use deterministic in-process clocks/randomness. Do not use sleeps as assertions.
Store only minimized non-secret operation sequences as regression vectors.

**Verify**:

```bash
vp run test:terminal:unit
vp run test:server
```

Expected: at least 10,000 deterministic generated sequences per state machine in
scheduled mode and fast seeded samples in required CI.

### Step 4: Add bounded Rust and TypeScript fuzz targets

Create Rust `cargo-fuzz`/libFuzzer targets for native Ghostty input/chunking,
terminal frame decode, semantic codec, archive manifest/block recovery,
device-auth decode, and URL/origin normalization. Assert no panic/UB, bounded
allocation/time for bounded input, and valid-value round trip.

For TypeScript, add byte mutation and schema/state-machine property runners in a
worker/child with heap/time ceilings. Exercise codec decode, Effect Schema
routes, client stores, IndexedDB record decode, and raw/semantic reconnect. A
hang is a finding. Corpus payloads must be capped and scrubbed before artifact
upload.

**Verify**:

```bash
vp run test:fuzz:smoke
```

Expected: every target runs a fixed iteration/time smoke budget and reports its
seed/corpus count with no crash, hang, or memory-limit breach.

### Step 5: Add explicit previous/current compatibility fixtures

Build and retain protocol fixtures for the previous supported release artifact.
Test current client against previous host and previous client protocol driver
against current host. Assert identity/capabilities first, supported negotiated
path, and typed `unsupported-version` before mutation for incompatible paths.

A state/database format declared reset-only is tested as a clear startup error or
explicit operator reset, never a silent partial load. Record the support window and
removal process in architecture docs.

**Verify**:

```bash
vp run test:compatibility
```

Expected: the matrix emits a machine-readable report with every pair marked
pass or deliberately unsupported with reason.

### Step 6: Integrate sanitizer and fuzz tiers into CI

Add required PR smoke jobs for corpus, properties, compatibility, and short fuzz
runs. Add Linux ASan/UBSan (and Miri for small unsafe/public wrapper units where
practical), plus scheduled macOS/Windows parser/codec smoke. Add scheduled longer
fuzz shards with per-target time/heap caps and artifact retention.

Pin toolchains and seeds. Upload minimized input, stack, target, commit, and exact
local replay command, never secrets. A new crash/hang is red; flaky rerun-until-
green is forbidden.

**Verify**:

```bash
vp run test:fuzz:smoke
vp run test:server:sanitizers
vp run test:compatibility
```

Expected: local equivalents pass and workflow validation shows required versus
scheduled tiers with bounded runtime.

### Step 7: Run the full terminal and security gate

Run all vectors on release profile native libraries and production browser
bundles. Verify no test-only response owner, parser, or relaxed decoder differs
from production. Document corpus contribution, triage, disclosure, and version
sunset procedures.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:terminal:unit
vp run test:terminal:protocol
vp run test:ghostty:parity
vp run test:server
vp run test:web
vp run test:fuzz:smoke
vp run test:compatibility
```

Expected: all commands pass and each conformance dimension produces a bounded
machine-readable artifact.

## Test plan

- Byte/chunk/vector differential corpus and cross-language goldens.
- State-machine properties for streaming, semantic resync, leases, auth, archive.
- Fuzz crash/hang/allocation/time limits for every manifest decoder.
- Current/previous capability and unsupported-version matrix.
- Sanitizer release-profile smoke and deterministic artifact replay.

## Done criteria

- [ ] Every untrusted decoder/version boundary is in the conformance manifest.
- [ ] Native/WASM and Rust/TypeScript binary vectors run from one versioned corpus.
- [ ] Streaming, lease, auth, and archive state machines have deterministic property tests.
- [ ] Required fuzz smoke and sanitizer jobs are green; scheduled fuzzing retains reproducers.
- [ ] Previous/current compatibility is explicit and machine-readable.
- [ ] No malformed input causes panic, hang, unbounded allocation, or silent downgrade.
- [ ] Full terminal/server/web/type/lint gates pass.

## STOP conditions

- A differential passes only by deleting meaningful terminal state or weakening bounds.
- A fuzz target can execute corpus text as a shell command or reach public hosts.
- Compatibility requires accepting unvalidated/ambiguous old input.
- Findings contain secrets/terminal content and cannot be scrubbed safely.
- CI can only pass by rerunning flaky seeds.
- A wire owner changed materially and is not represented in the manifest.

## Maintenance notes

Every new decoder, persisted format, protocol version, or Ghostty upgrade must
update the manifest, corpus, compatibility matrix, and at least one malformed
case. Preserve minimized security findings privately until disclosure review;
non-sensitive regressions should become permanent checked-in vectors.
