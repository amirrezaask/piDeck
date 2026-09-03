# Plan 024: Prove checkpoint restore feasibility before defining its wire format

> **Executor instructions**: This is a gated design/implementation plan. Complete
> Plans 018, 022, 023, and 027 first. Preserve working-tree changes. Run the
> public-API feasibility gate before editing production schemas. If the pinned
> API cannot restore state and raw replay misses its approved budget, set this
> plan and its README row to `BLOCKED (no public Ghostty restore API)` and stop.
> Never substitute private Ghostty memory for a public restore contract.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 8bbcd017..HEAD -- \
>   crates/ghostty-vt crates/ghostty-vt-sys \
>   apps/server/src/terminal.rs apps/server/src/terminal_history.rs \
>   apps/server/src/wire.rs packages/yaade-rpc/src \
>   packages/yaade-host-client/src packages/ghostty-react/src \
>   tests/bench tests/web/e2e docs/architecture docs/terminal-renderers.md
> git diff --stat -- \
>   crates/ghostty-vt crates/ghostty-vt-sys \
>   apps/server/src/terminal.rs apps/server/src/terminal_history.rs \
>   apps/server/src/wire.rs packages/yaade-rpc/src \
>   packages/yaade-host-client/src packages/ghostty-react/src \
>   tests/bench tests/web/e2e docs/architecture docs/terminal-renderers.md
> ```
>
> At plan creation, the pinned public C headers expose terminal writes and render
> traversal but no versioned parser-state import. Render rows alone do not
> qualify as restore capability.

## Status

- **Status**: BLOCKED (Plan 023)
- **Priority**: P2
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: Plans 018, 022, 023, and 027
- **Category**: feasibility / protocol / persistence
- **Planned at**: commit `8bbcd017`, 2026-08-30
- **Source finding**: SolPro P1-8 binary checkpoint recommendation

## Why this matters

A compact checkpoint could reduce reconnect work, but only if the browser can
initialize a fresh Ghostty parser with the same screen, scrollback, cursor,
modes, palette, charsets, saved state, and protocol state. A render snapshot
contains too little information. Sending later raw bytes to a blank parser after
painting rows would corrupt untouched state.

The repository currently uses synthetic ANSI bootstrap bytes. This plan either
replaces them through a public, versioned restore contract, removes them after a
measured raw-replay decision, or records an explicit blocker. It does not encode
private Ghostty pages.

## Current state

Plan 018 should own binary indexed history and replay fences. Plan 023 should
produce the transitional checkpoint from public Ghostty formatter/state data
while preserving the existing wire version. Plan 015 should already represent
binary payloads with exact bytes and schema-level base64 transforms on cold JSON
routes.

The browser's terminal authority remains its Ghostty core. PTY replay ACK occurs
after parsing. Any checkpoint path must preserve this authority and sequence
ordering.

## Feasible outcomes

### Outcome A: public versioned export and import exist

Implement the bounded checkpoint envelope and restore flow below. Both operations
must be documented public libghostty-vt APIs at the pinned revision.

### Outcome B: full raw replay meets the approved maximum-history budget

After product approval, remove synthetic checkpoints and replay exact indexed
history. Keep truncation/degraded quality explicit. Do not introduce a checkpoint
wire type with no restore consumer.

### Outcome C: neither condition holds

Produce the feasibility evidence and proposed envelope, then mark the plan
`BLOCKED`. Retain the transitional bootstrap. Open an upstream/API follow-up or
revisit terminal-state authority separately.

## Proposed checkpoint envelope (Outcome A only)

```text
magic/version
terminal epoch and terminal ID hash
checkpoint sequence (last included output byte sequence)
columns/rows and cell metrics generation
engine = ghostty-vt
engine revision and public state-format version
uncompressed length and strict maximum
compression codec/version
payload checksum
opaque public-export payload
```

The envelope belongs to YAADE; the payload remains an explicitly versioned public
Ghostty export. A matching import API must validate it without private layout
knowledge. Revision/format mismatch falls back to raw replay.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Capability probe | wrapper/sys `checkpoint_capability` tests from Step 1 | exact public API result |
| Replay measurement | `vp run test:bench` | maximum-history decision evidence |
| Protocol | `vp run test:terminal:protocol` | bounded envelope/fallback tests when Outcome A |
| Parity | `vp run test:ghostty:parity` | restore-and-continue equals uninterrupted |
| E2E | focused compatibility/multiplexer Playwright commands | restore/fallback or raw replay passes |

## Scope

**In scope**

- Public-header/build-info feasibility probe in `ghostty-vt-sys`/`ghostty-vt`
- Maximum-retained-history raw replay benchmark using Plan 027 infrastructure
- A written decision record with exact API symbols and measurements
- Outcome A only: typed RPC/wire schemas, server persistence, browser restore,
  sequence fences, fallback, compatibility/E2E tests
- Outcome B only: synthetic checkpoint removal and indexed raw replay fallback
- Security/size/checksum/version validation
- Documentation, this plan status, and `plans/README.md`

**Out of scope**

- Ghostty private page structs, allocator dumps, pointer relocation, or patches
  that expose internal memory as a stable format.
- Treating public render traversal/formatter output as parser restore.
- A server-semantic terminal protocol or native browser renderer.
- Long-lived backward migration machinery; repository policy permits state reset.
- Changing Ghostty revision solely to make this plan pass without a separate
  reviewed upgrade.

## Steps

### Step 1: Run the public restore capability probe

Inspect the exact pinned public headers and build info. Add compile-time/runtime
probe tests that answer:

1. Can public API export all terminal parser/state needed for continuation?
2. Can a fresh terminal import that output through a matching public function?
3. Does the API publish a state-format version and compatibility policy?
4. Can callers bound output size and reject malformed input safely?
5. Do export/import include scrollback, modes, palette, saved cursor/state,
   charset/keyboard/protocol state, and pending synchronized state?

A formatter, row iterator, grid ref, clone without serialization, or internal Zig
symbol fails the gate. Record exact symbol/header evidence and revision.

**Verify**:

```bash
cargo test --manifest-path crates/ghostty-vt-sys/Cargo.toml checkpoint_capability
cargo test --manifest-path crates/ghostty-vt/Cargo.toml checkpoint_capability
```

Expected at plan creation: tests/documentation report no qualifying import API.
Do not add production schemas before the gate passes.

### Step 2: Measure the exact raw-replay alternative

Use Plan 018's indexed binary history and Plan 027's deterministic harness. Test
a fresh browser Ghostty with 512 KiB, 16 MiB, 64 MiB, and the configured maximum
retained history across ASCII, Unicode, ANSI-heavy, and TUI corpora. Record:

- history fetch/decompression time;
- transfer time/bytes;
- worker parse p50/p95/p99;
- peak main/worker memory and event-loop delay;
- time to first trustworthy frame and final catch-up;
- behavior when retention truncated the beginning.

Keep raw bytes exact. Run on supported browser/Tauri hardware profiles. Product
owners must approve the maximum reconnect latency and degraded-history behavior
before Outcome B.

**Verify**:

```bash
vp run test:bench
```

Expected: a decision table names the tested history limits and pass/fail budget.

### Step 3: Record the outcome before implementation

Write a short architecture decision with:

- pinned revision and API evidence;
- replay measurements and hardware/runtime context;
- selected Outcome A, B, or C;
- data reset/backward compatibility policy;
- fallback and failure semantics.

For Outcome C, update status to `BLOCKED`, retain existing behavior, and stop.
For Outcome B, skip Steps 4–6 and implement exact raw replay/removal with the
same final gates. Outcome A continues below.

**Verify**: reviewers can reproduce the probe and benchmark from documented
commands without source edits.

### Step 4: Define bounded schemas and binary framing (Outcome A)

Add Effect Schema contracts for checkpoint metadata/base64 on JSON routes and a
binary WebSocket checkpoint frame for hot replay if needed. Validate magic,
versions, revision, dimensions, sequence, lengths, codec, checksum, and maximum
size before allocation/decompression/import.

Use a terminal epoch plus checkpoint sequence to reject stale checkpoints. The
checkpoint includes output through sequence N; replay starts at N+1. Duplicate
or older live frames are ignored through existing sequence logic.

Do not put checkpoint bytes in React state or generic `HostEvent.args`.

**Verify**:

```bash
vp run test:terminal:protocol
vp run typecheck
```

Expected: round-trip, malformed length/checksum/version/revision, oversized,
stale epoch, and fallback tests pass.

### Step 5: Persist/export and restore atomically (Outcome A)

Server history owner requests export at an accepted sequence fence without
blocking PTY reads. Persist envelope and payload atomically with Plan 018's
index. Keep the prior valid checkpoint until replacement commits.

Browser flow:

1. create a matching Ghostty instance;
2. validate/decompress/import checkpoint in the worker;
3. request/replay raw records from sequence N+1;
4. buffer ordered live bytes during restore;
5. ACK only after import plus replay bytes are parsed;
6. emit one full authoritative frame.

Import failure discards the new core and falls back to raw replay or a documented
degraded reset. It may not leave a partially restored parser visible.

**Verify**:

```bash
vp run test:server
vp test packages/ghostty-core packages/ghostty-react packages/yaade-host-client
```

Expected: crash-safe server replacement and atomic browser restore/fallback pass.

### Step 6: Prove continuation, not visual similarity (Outcome A)

For every Plan 022 fixture, compare:

- uninterrupted parser after all bytes;
- export at observation N, fresh import, then bytes N+1 onward.

Require exact public state and effect bytes after continuation. Include modes,
query responses, alternate screen, saved cursor, palette, scrollback, split
synchronized output, and resize. A same-looking checkpoint frame is insufficient.

Add revision/format mismatch and corrupted/truncated payload E2E cases.

**Verify**:

```bash
vp run test:ghostty:parity
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-compatibility.web.spec.ts \
  tests/web/e2e/terminal-multiplexer.web.spec.ts
```

Expected: restored continuation equals uninterrupted parsing; fallback remains
correct.

### Step 7: Remove synthetic bootstrap only after the selected replacement passes

Outcome A removes formatter-generated synthetic checkpoints after import/fallback
E2E pass. Outcome B removes them after approved raw replay gates pass. Search for
old fields/functions and reset persisted development state rather than carrying
unused compatibility code.

**Verify**:

```bash
rg -n 'synthetic.*checkpoint|checkpoint.*ansi|format_replay_bootstrap' \
  apps/server packages
vp run test:server
vp run test:terminal:protocol
vp run test:bench
```

Expected for A/B: no production synthetic bootstrap remains. Outcome C keeps it
and the plan stays `BLOCKED` with evidence.

## Test plan

- Public API capability probe and exact revision evidence.
- Raw replay sizes/corpora, memory, latency, truncation, Tauri/browser.
- Outcome A: schema/frame fuzzing, checksum/length/revision/epoch/sequence bounds.
- Atomic export persistence and browser core replacement/fallback.
- Uninterrupted versus restore-and-continue parity over Plan 022 corpus.
- Outcome B: exact raw replay and explicit degraded quality.

## Done criteria

- [ ] Public restore capability and raw-replay alternative have reproducible evidence.
- [ ] An architecture decision selects Outcome A, B, or C.
- [ ] No private Ghostty representation becomes persisted or transmitted.
- [ ] Outcome A uses a bounded versioned envelope and proves continuation parity.
- [ ] Outcome B has explicit product approval and exact replay/fallback tests.
- [ ] Outcome C leaves production behavior unchanged and status `BLOCKED`.
- [ ] Synthetic bootstrap is removed only after a correct replacement ships.

## STOP conditions

- The only restore path uses render rows, formatter ANSI, or private memory.
- Export exists without matching public import and version policy.
- Raw replay misses budget or loses required state without product approval.
- Restore needs PTY/output blocking or stores payload in React state.
- Import failure can expose a partially initialized parser.
- An engine revision upgrade is introduced inside this plan to avoid the gate.

## Maintenance notes

A checkpoint is valid only when a fresh parser can continue as if it never
stopped. Keep the YAADE envelope independent from engine internals and reject
unknown revisions/formats. Re-run continuation parity and maximum-history replay
for every Ghostty upgrade.
