# Plan 033: Complete an authoritative semantic terminal snapshot and resync stream

> **Executor instructions**: Complete Plans 017, 019, 022, and 023 first. Preserve
> all pre-existing working-tree changes and all raw PTY streaming/replay behavior
> while adding the semantic lane; raw
> control remains the interactive compatibility path. Do not call the current
> JSON payload with a six-byte header a binary cell codec. If the native Ghostty
> wrapper cannot expose a required public observation, stop and report. Update
> this plan and `plans/README.md` to `DONE` after every gate passes.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat a0bb3fc9..HEAD -- \
>   crates/ghostty-vt apps/server/src/{runtime,server,terminal,wire}.rs \
>   packages/yaade-rpc/src/terminal-stream-v3* \
>   packages/yaade-host-client/src/{create-yaade-api,terminal-v3-store,web-transport}.ts \
>   packages/yaade-ui/src/panels/SemanticTerminalView.tsx \
>   tests/{runtime,bench,web/e2e}
> git diff --stat -- \
>   crates/ghostty-vt apps/server/src/{runtime,server,terminal,wire}.rs \
>   packages/yaade-rpc/src/terminal-stream-v3* \
>   packages/yaade-host-client/src/{create-yaade-api,terminal-v3-store,web-transport}.ts \
>   packages/yaade-ui/src/panels/SemanticTerminalView.tsx \
>   tests/{runtime,bench,web/e2e}
> ```

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 017, 019, 022, and 023
- **Category**: terminal correctness / protocol / reconnect
- **Planned at**: commit `a0bb3fc9`, 2026-08-30
- **Source finding**: Superlogical exact reattach and multi-client observation parity

## Why this matters

The repository contains a thoughtful semantic terminal v3 schema, client store,
and renderer, but the host rejects every `semantic` or `both` attachment. Its
"binary" codec currently embeds UTF-8 JSON, has no state hash, and has no server
publisher. Completing the lane gives observers an exact current screen,
replaceable patches, bounded recovery after gaps, and a foundation for fast
reattach and collaboration without replacing the raw PTY control path.

## Current state

- `apps/server/src/runtime.rs:811-818` returns
  `"semantic terminal mode is not available on this host"` for `semantic` and
  `both`.
- `packages/yaade-rpc/src/terminal-stream-v3.ts` defines snapshot, patch,
  terminal epoch, revisions, rows, cursor, modes, palette, hyperlinks, and a
  resync message.
- `terminal-stream-v3-codec.ts` currently does:

  ```ts
  const payload = new TextEncoder().encode(JSON.stringify(message))
  ```

  after a version/kind/length header. That is bounded framing, not a compact
  binary cell protocol.
- `TerminalV3Store` rejects epoch/revision gaps and requests resync, and
  `create-yaade-api.ts` already listens for `terminal.snapshot`,
  `terminal.patch`, and `terminal.resync-required`.
- `SemanticTerminalView.tsx` paints only plain row text. It drops styles, cursor,
  selection, hyperlinks, scrollback, and most input-mode semantics.
- Plan 023 makes native Ghostty the server terminal-state authority; Plan 022
  proves native/WASM public-state parity. Build this plan on those owners rather
  than parsing PTY bytes a third time.

## Target contract

- One native Ghostty owner publishes immutable semantic observations after an
  accepted output/resize/theme transaction.
- Full snapshot and patch frames carry server, terminal, owner, geometry, and
  revision epochs plus a canonical 128-bit-or-stronger state hash.
- The codec is bounded binary data with explicit tables/runs, not JSON inside a
  binary envelope. Unknown versions/features are rejected before allocation.
- Reliable control, ordered raw output, and replaceable semantic state use the
  separate outbound lanes established by Plan 017.
- Semantic overflow is latest-complete-snapshot recovery; raw output overflow
  remains ordered replay recovery.
- A semantic view is observer/read-only unless it also holds an explicit writer
  lease. It never answers PTY queries.

Any new `@yaade/app` unit test file must also be listed in
`packages/yaade-app/package.json`, per repository convention.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Native/WASM authority | `vp run test:ghostty:parity` | public observations match |
| Protocol | `vp run test:terminal:unit && vp run test:terminal:protocol` | codec/store tests pass |
| Server integration | `vp run test:server && vp run test:terminal:integration` | publisher/attach tests pass |
| Browser | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts` | raw and semantic surfaces agree |
| Bench | `vp run test:bench` | snapshot/patch budgets and existing gates pass |

## Scope

**In scope**

- Public observation additions in `crates/ghostty-vt`
- Server publisher and outbound semantic lane integration
- Effect Schema and binary codec under `packages/yaade-rpc`
- Host-client semantic store/resync and shared semantic terminal surface
- Differential, malformed-frame, reconnect, and benchmark tests
- Capability negotiation and architecture documentation

- Test manifests/scripts required by this plan, including
  `packages/yaade-app/package.json`

**Out of scope**

- Replacing raw PTY input/output for interactive owner clients
- Persisting private Ghostty memory or treating render rows as parser restore
- Cold million-line history; Plan 034
- Invitation, role, or presence UX; Plan 038
- A second terminal parser, xterm.js, or desktop-only renderer

## Steps

### Step 1: Freeze canonical semantic observation and hash rules

Extend Plan 022's test-only observation into a bounded production projection
using only public native Ghostty APIs. Define canonical order for rows, cells,
palette, modes, cursor, hyperlinks, title, dimensions, and active screen. Add a
hash over semantic fields and the exact terminal/geometry epoch; do not hash
pointer values, map iteration order, clocks, or raw PTY bytes.

Prove native and WASM produce the same hash at shared corpus observation points.
Hash mismatch is a resync signal, never silently normalized.

**Verify**:

```bash
vp run test:ghostty:parity
```

Expected: exact semantic/hash equality for every corpus fixture and deliberate
single-cell/mode mismatch tests fail.

### Step 2: Replace JSON payloads with a bounded binary codec

Version the frame independently from WebSocket protocol version. Encode shared
colors/styles/hyperlinks in bounded tables and row/cell runs; encode text as
length-prefixed UTF-8. Validate count × element-size overflow, dimensions,
indices, string lengths, duplicate row IDs, revision monotonicity, and a strict
maximum before allocation. Keep Effect Schema as the decoded domain boundary,
not as a reason to JSON stringify hot frames.

Add cross-language golden vectors generated from fixed corpus snapshots. Include
truncated headers, oversized lengths, unknown flags, invalid UTF-8, table index
overflow, zip-bomb-equivalent counts, and trailing bytes.

**Verify**:

```bash
vp run test:terminal:protocol
cargo test --manifest-path apps/server/Cargo.toml terminal_stream_v3
```

Expected: Rust/TypeScript vectors round-trip byte-for-byte and malformed frames
are rejected without large allocation.

### Step 3: Publish snapshots and bounded patches from the terminal owner

After Plan 023 parses each output once, compute dirty semantic rows and metadata.
Publish a patch only when base revision/epoch/hash are known; otherwise publish a
full snapshot. Coalesce replaceable patches per subscriber without blocking the
terminal actor. A patch chain must have bounded count/bytes/age; exceed any bound
and replace it with one full snapshot.

Resize, reset, alternate-screen transition, palette-table reset, epoch change,
and hash uncertainty force a full snapshot. Do not publish half of a DEC 2026
synchronized update.

**Verify**:

```bash
vp run test:server
vp run test:terminal:integration
```

Expected: exact revisions/hashes, bounded mailboxes, and full-reset barriers pass
under output flood and resize.

### Step 4: Enable negotiated `semantic` and `both` attachment

Advertise an explicit `semanticTerminalV3` capability with codec versions and
limits. Accept semantic attach only after capability negotiation. Send the small
attach control result on the reliable lane and the replaceable full snapshot on
the semantic lane. An observer attach must not acquire a writer lease or receive
raw history unless requested/authorized.

On base/hash gap, client sends one bounded resync request. Server replies with the
newest full snapshot and discards stale queued patches. Add retry/backoff and
terminal/server epoch reset handling; avoid resync loops.

**Verify**:

```bash
vp run test:terminal:unit
vp run test:terminal:integration
```

Expected: attach, gap, duplicate, out-of-order, new epoch, and incompatible codec
cases converge to one exact state.

### Step 5: Render semantic state with shared terminal semantics

Replace the plain text `<div>` implementation with an adapter over the existing
renderer-neutral packed model and Canvas/WebGL semantics. Preserve styles,
wide/combining cells, cursor, selection, links, palette, and dimensions. Keep
DOM accessibility support compatible with Plan 039. Do not introduce a separate
desktop renderer.

Input is disabled for observers. A writer semantic surface may forward input
only through the existing terminal API and active lease; it still does not answer
terminal queries locally.

**Verify**:

```bash
vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts
```

Expected: raw and semantic captures share exact model geometry and approved
pixel tolerances across Canvas/WebGL.

### Step 6: Prove backpressure, resync, and data minimization

Benchmark 80×24, 240×80, six panes, 30 Hz TUI, hidden observers, and slow
consumers. Report full/patch bytes, encode/decode time, coalescing, resync count,
mailbox high water, and received-to-presented latency. Metrics may include sizes
and counts, never text/cell content.

**Verify**:

```bash
vp run test:bench
vp run typecheck
vp run lint
vp run build:server
vp run build:web
```

Expected: all existing budgets remain green and new exact queue/size gates pass.

## Test plan

- Cross-language binary golden vectors and malformed-frame bounds.
- Native/WASM canonical state hashes over Plan 022 corpus.
- Publisher full/dirty metadata/resize/synchronized-output transitions.
- Attach/resync across gaps, epochs, incompatible versions, and slow consumers.
- Raw versus semantic semantic/pixel parity and observer write denial.
- No-payload diagnostics and bounded memory under six-terminal flood.

## Done criteria

- [ ] The host no longer rejects negotiated semantic attachment.
- [ ] v3 payloads are a real bounded binary codec, not JSON text in a frame.
- [ ] Snapshot/patch revisions, epochs, and canonical state hashes are enforced.
- [ ] Native Ghostty is the sole server semantic publisher.
- [ ] Semantic overflow recovers with one latest full snapshot; raw order is unchanged.
- [ ] Observer surfaces cannot write or answer terminal queries.
- [ ] Raw and semantic render parity, fuzz, integration, build, and benchmark gates pass.

## STOP conditions

- A required field needs private Ghostty memory or a second parser.
- Hash equality requires deleting meaningful semantic fields.
- Semantic publication can block PTY parsing/history/raw fan-out.
- A replaceable semantic queue is reused for ordered raw output.
- The implementation tries to use a render snapshot as browser parser restore.
- Input bypasses the writer lease/mutation fence.

## Maintenance notes

Every semantic schema change increments a codec version and adds cross-language
goldens. Re-run Plan 022 parity and this plan's hash corpus on every Ghostty
upgrade. Keep the semantic lane replaceable and the raw lane ordered; their
failure policies are intentionally different.
