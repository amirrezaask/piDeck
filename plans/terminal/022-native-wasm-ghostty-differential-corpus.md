# Plan 022: Run one terminal corpus through native and WASM Ghostty

> **Executor instructions**: Complete Plans 015, 020, and 021 first. Follow this
> plan in order, preserve working-tree changes, and run each verification. Keep
> fixture generation outside measured/test execution. Stop on a semantic mismatch
> until it is explained; never normalize a mismatch away. Update this plan and
> `plans/README.md` to `DONE` when parity passes on supported platforms.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 8bbcd017..HEAD -- \
>   crates/ghostty-vt packages/ghostty-core packages/ghostty-react \
>   tests/fixtures scripts package.json .github/workflows/ci.yml
> git diff --stat -- \
>   crates/ghostty-vt packages/ghostty-core packages/ghostty-react \
>   tests/fixtures scripts package.json .github/workflows/ci.yml
> ```
>
> Confirm native and WASM build-info both match the live Ghostty VERSION. This
> plan compares the same engine revision, not different upstream versions.

## Status

- **Status**: DONE
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 015, 020, and 021
- **Category**: correctness / compatibility / test infrastructure
- **Planned at**: commit `8bbcd017`, 2026-08-30
- **Source finding**: SolPro P1-7 semantic unification gate

## Why this matters

Using Ghostty on both sides does not guarantee equal behavior if builds, options,
callbacks, chunk boundaries, or wrapper conversions differ. The server migration
needs a differential gate that compares native and WASM terminal state and query
effects before `vt100` disappears.

The corpus also becomes the upgrade gate for future VERSION changes and the
fixed input source for Plans 027–029. It must preserve bytes and chunk schedules,
including malformed UTF-8 and split escape sequences.

## Current state

Browser tests cover `GhosttyTerminalCore`, render updates, and compatibility
cases. Rust server tests cover its current `vt100`/scanner behavior. No fixture
feeds the same byte stream and option state into native libghostty-vt and the
browser WASM loader, and no shared normalized state format compares their public
render results or write-PTY responses.

## Target design

```text
tests/fixtures/terminal-corpus/
  manifest.json                 fixture IDs, dimensions, options, chunk schedule
  *.bin                         exact immutable PTY bytes
  *.chunks.json                 offsets, resize/theme/control events
  assertions/*.json             selected hand-authored semantic assertions

native runner ─┐
               ├─ normalized public observation -> strict comparator
WASM runner ───┘
```

The normalized observation is test-only. It contains public rows/cells/styles,
cursor, modes, palette, title, pwd, scroll metadata, and exact effect bytes. It
is not a production protocol or checkpoint format.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Native runner | `cargo test --manifest-path crates/ghostty-vt/Cargo.toml corpus` | native assertions pass |
| WASM runner | `vp test packages/ghostty-core packages/ghostty-react` | WASM assertions pass |
| Differential | `vp run test:ghostty:parity` | exact observations match |
| Type/lint | `vp run typecheck && vp run lint` | exit 0 |
| Platform gate | parity in `runtime-platform` CI | all supported OS jobs pass |

## Scope

**In scope**

- `tests/fixtures/terminal-corpus/**` (new)
- Native test runner under `crates/ghostty-vt/tests/**`
- WASM/Node runner in `packages/ghostty-core` or `ghostty-react` tests
- A repository parity command under `scripts/` and `package.json`
- Effect Schema validation for test manifest/observation on the TypeScript side
- Typed serde structures and bounds on the Rust side
- Linux/macOS/Windows CI parity jobs
- Corpus/upgrade documentation and `plans/README.md`

**Out of scope**

- Production RPC or persistence schemas.
- Server integration/removing `vt100`: Plan 023.
- Checkpoint import/export: Plan 024.
- Performance budgets: Plan 027. This plan may report timing but cannot gate it.
- Screenshots or renderer pixel parity; compare Ghostty state before YAADE paint.
- Generated random corpora committed without a fixed seed and reviewable source.

## Steps

### Step 1: Define a bounded test-only corpus manifest

Define and validate fields for:

- fixture ID and purpose;
- initial columns, rows, cell dimensions, scrollback, theme, and device options;
- byte file SHA-256 and exact length;
- ordered write chunk offsets;
- interleaved resize, reset, theme, and host-response configuration events;
- observation points and expected hand-authored assertions;
- maximum bytes, rows, columns, effects, and output JSON size.

Reject path traversal, overlapping/out-of-range chunks, wrong hashes, unknown
events, duplicate IDs, and observations without complete prior input. Keep binary
payloads in `.bin`, not JSON numbers or text escapes.

Add an explicit normalizer version. Include native/WASM build revision in every
runner result and reject mismatches before comparing state.

**Verify**:

```bash
vp test packages/ghostty-core
cargo test --manifest-path crates/ghostty-vt/Cargo.toml corpus_manifest
```

Expected: valid fixtures load; malformed manifests fail with bounded errors.

### Step 2: Build a representative deterministic corpus

Add reviewed fixtures for:

- ASCII shell/build output and long printable runs;
- split and malformed UTF-8, NUL, C0/C1 controls;
- SGR, indexed/truecolor, palette/default-color queries;
- wide, combining, ZWJ, variation selector, and wrapped graphemes;
- primary/alternate screen, scroll regions, insert/delete, wrap/reflow;
- DEC synchronized output and mode toggles;
- mouse/focus/bracketed-paste/kitty keyboard modes;
- OSC title, OSC 7 cwd, hyperlinks, clipboard sequences with safe policy;
- DA, DSR, DECRQM, XTWINOPS, and device/size queries;
- resize/reset/theme events between split escape-sequence chunks;
- a complex TUI rewrite corpus derived from deterministic fixtures, not recorded
  secrets or machine-specific command output.

For critical fixtures, author assertions for exact cells, cursor/modes, title/cwd,
and response bytes. These assertions prevent both runners from sharing the same
regression and still comparing equal.

**Verify**:

```bash
# Run the corpus validation/list command introduced in Step 1.
```

Expected: hashes, bounds, IDs, chunk coverage, and assertion references pass.

### Step 3: Implement the native observation runner

Use only Plan 021's safe API. Apply manifest options/events and exact chunk
boundaries. At each observation point, copy a normalized, bounded view of:

```text
dimensions, viewport rows/cells/grapheme bytes, width/style/colors/decorations,
cursor, modes, palette/default colors, title, pwd, scroll metadata,
ordered write-PTY/effect bytes
```

Represent bytes as a canonical encoded field with length/hash, not lossy text.
Sort only maps whose order has no terminal meaning. Keep rows/effects ordered.
Never read private Ghostty memory.

Provide a CLI/test mode that writes canonical JSON to a caller-selected temporary
path so the cross-language comparator can invoke it.

**Verify**:

```bash
cargo test --manifest-path crates/ghostty-vt/Cargo.toml corpus
```

Expected: native runner satisfies every hand-authored assertion.

### Step 4: Implement the WASM observation runner

Use the shipped Node/WASM loader and the same core options/effect policy. Feed
`Uint8Array` slices directly according to manifest offsets. Capture write-PTY
responses and metadata effects without terminal strings or browser rendering.

Normalize through one typed function validated with Effect Schema. Do not import
the Rust result or expected output to construct the WASM observation. Ensure
WASM memory views are copied only at the observation boundary and cannot become
stale after memory growth.

**Verify**:

```bash
vp test packages/ghostty-core packages/ghostty-react
```

Expected: WASM runner independently satisfies hand-authored assertions.

### Step 5: Compare exact observations and classify permitted variance

Add `vp run test:ghostty:parity` (or the repository-equivalent command) that
runs both implementations in clean temporary directories and compares canonical
observations. Print the fixture, event/observation index, row/column or effect
offset, native value, and WASM value on failure.

Allow normalization only for fields proven host-dependent by the public API,
such as an explicitly injected host name. Record each allowance next to a test
that shows why it varies. Platform newline, locale, clock, pointer size, map
iteration, and JSON number quirks are test-harness bugs, not allowed variance.

Add deliberate mismatch tests to prove the comparator notices cell style, mode,
response-byte, and chunk-order differences.

**Verify**:

```bash
vp run test:ghostty:parity
```

Expected: all fixtures compare equal and mismatch self-tests fail as designed.

### Step 6: Gate Ghostty upgrades and supported platforms

Run parity in Linux, macOS, and Windows CI using Plan 020's prepared native
artifact and the checked WASM artifact. Add the command to the documented
VERSION upgrade checklist before server/browser integration tests.

Store fixture hashes and runner revisions in CI logs. Do not upload full terminal
payloads or user data. Keep test artifacts only on failure and only from the
repository corpus.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:ghostty:parity
```

Expected locally: all pass. Plan completion requires the three-platform matrix.

## Test plan

- Manifest/schema bounds, hashes, path safety, chunk schedules, unknown events.
- Native and WASM hand-authored semantic assertions.
- Exact differential rows/cells/styles/modes/cursor/palette/title/pwd/effects.
- Deliberate comparator failures with useful locations.
- Wrong native/WASM revision rejection.
- Three-platform deterministic output.

## Implementation result

The repository now has six deterministic binary fixtures, independent native and WASM runners, sparse hand-authored assertions, bounded Effect Schema and serde decoders, and a strict comparator. Native, WASM, and parity gates pass at revision `9f62873bf195e4d8a762d768a1405a5f2f7b1697`.

Plan 022 merged in PR #2 (`5a5d81e3`). The `test:ghostty:parity` step passed on macOS 14, Ubuntu 24.04, and Windows 2022 in hosted CI runs `33341881921` and `33342764168`. Those jobs later failed in unrelated bindgen/server-clippy steps, but the three-platform parity gate itself completed successfully. A final local parity run at `b2e03509` also passed all six fixtures with matching native/WASM revisions.

## Done criteria

- [x] One reviewed binary corpus drives native and WASM with identical options/events/chunks.
- [x] Both runners expose only bounded public Ghostty observations.
- [x] Critical semantics have hand-authored assertions in addition to equality.
- [x] Exact write-PTY responses and malformed byte behavior compare equal.
- [x] Comparator rejects revision mismatch and reports precise differences.
- [x] No production protocol/checkpoint depends on the test observation schema.
- [x] `test:ghostty:parity` passes on Linux, macOS, and Windows.

## STOP conditions

- Native and WASM revisions/options cannot be made identical.
- A comparison needs private Ghostty memory or pointer values.
- A mismatch is hidden through broad field deletion, Unicode replacement, row
  trimming, or platform normalization.
- The fixture includes secrets, nondeterministic live command output, or mutable
  network content.
- Both runners can pass by reading one shared generated golden as their result.
- The plan begins production server migration or benchmark threshold tuning.

## Maintenance notes

Every terminal semantic fix and VERSION upgrade should add or retain a minimal
fixture. Keep large performance corpora separate from small diagnostic cases,
but drive both from the same binary/chunk manifest contract. Review new
normalizations as compatibility exceptions, not routine test maintenance.
