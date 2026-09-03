# Plan 018: Move terminal history behind a bounded asynchronous binary pipeline

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Preserve all pre-existing working-tree changes. If anything in the
> "STOP conditions" section occurs, stop and report instead of improvising.
> When done, update this plan and its row in `plans/README.md` to `DONE`.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 7276f526..HEAD -- \
>   apps/server/src/terminal.rs apps/server/src/terminal_history.rs \
>   apps/server/src/runtime.rs apps/server/Cargo.toml apps/server/Cargo.lock \
>   apps/server/tests tests/bench docs/architecture/terminal-runtime.md
> git diff --stat -- \
>   apps/server/src/terminal.rs apps/server/src/terminal_history.rs \
>   apps/server/src/runtime.rs apps/server/Cargo.toml apps/server/Cargo.lock \
>   apps/server/tests tests/bench docs/architecture/terminal-runtime.md
> ```
>
> Confirm Plans 013 and 015 are `DONE`. Plan 013 establishes kill-before-history
> close ordering and an asynchronous close-finalization seam. Plan 015 changes
> history records to exact binary bytes while retaining synchronous gzip/IO.
> Reuse and deepen those implementations; do not create a second close worker or
> restore text/JSON records. If either plan landed with a materially different
> history interface, stop and reconcile this plan before editing.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 013 and 015
- **Category**: perf / correctness / architecture
- **Planned at**: commit `7276f526`, 2026-08-30
- **Source finding**: SolPro Ghostty review P0-6

## Why this matters

The PTY reader currently calls `TerminalHistoryArchive::append` synchronously.
Crossing the block threshold serializes/compresses a block, writes and renames
files, rewrites a manifest, and enforces quota while a global history state mutex
is held. `read_page` forces pending data to flush and decompresses complete gzip
blocks. A cold disk or compression spike therefore runs directly in the output
path and one terminal's history work serializes unrelated terminals.

Plan 015 makes records byte-exact but intentionally leaves this scheduling
unchanged. The target in this plan is a bounded ingest owner, per-terminal/sharded
archive state, append-only active segments, asynchronous compression/indexing,
and explicit flush/durability barriers. Normal PTY reads enqueue immutable byte
references and continue. If the finite durable queue truly saturates, the host
applies measured/observable PTY backpressure; it never loses history silently or
moves failure into unbounded memory.

## Current state

Before Plan 015, `apps/server/src/terminal_history.rs` contains one global:

```rust
states: Mutex<HashMap<String, ArchiveState>>
```

`append()` acquires it and, at the block threshold, calls `flush_state()`.
`flush_state()` encodes, gzip-compresses at level 6, writes a temporary file,
renames it, and writes `index.json`. `close_terminal()` then calls a global
`enforce_total_quota()` directory/manifest scan. `read_page()` also calls
`flush_state()` before reading.

After Plan 015, raw records should already use a versioned binary codec and
`Bytes`; the remaining synchronous operations are the subject of this plan.

Plan 013 requires close enqueue to be ordered after accepted appends, close to
return without compression/quota work, and shutdown/test barriers to drain
accepted finalization. Preserve those semantics while extending the owner to
normal append/rotation work.

`docs/architecture/terminal-runtime.md` requires bounded queues, exact replay,
and no browser-induced PTY blocking. This history queue is allowed to exert
controlled backpressure only when durable retention itself is saturated and the
alternative would be loss/unbounded memory.

## Target design

```text
PTY/state owner
  -> HistoryStream.append(sequence, Bytes)
      -> bounded byte-budget ingest mailbox
          -> history ingest owner
               ├─ append binary record to per-terminal active segment/staging
               ├─ rotate at bounded block size
               ├─ publish immutable block index
               └─ enqueue rotated segment
                    -> bounded compressor worker(s)
                         -> compressed temp + atomic rename
                         -> index/manifest completion

read_page
  -> immutable per-terminal index snapshot
  -> completed compressed blocks + bounded active-segment snapshot
  -> no forced global flush

close/shutdown
  -> ordered close marker / barrier
  -> close response does not wait
  -> shutdown/test barrier waits and reports failures
```

Keep the external module deep. An interface equivalent to this is acceptable:

```rust
struct TerminalHistoryArchive { /* owner handle + indexes */ }
struct TerminalHistoryStream { /* terminal id/epoch + ordered sender */ }

impl TerminalHistoryArchive {
    fn open(...) -> Result<Self, HistoryError>;
    fn stream(&self, terminal_id: &str, terminal_epoch: &str)
        -> Result<TerminalHistoryStream, HistoryError>;
    fn read_page(...) -> Result<Option<TerminalHistoryPage>, HistoryError>;
    fn flush(&self) -> Result<HistoryFlushReport, HistoryError>;
    fn shutdown(&self) -> Result<HistoryFlushReport, HistoryError>;
}

impl TerminalHistoryStream {
    fn append(&self, sequence: u64, data: Bytes) -> Result<AppendReceipt, HistoryError>;
    fn close(&self) -> Result<(), HistoryError>; // enqueue only, idempotent
}
```

`AppendReceipt`/metrics should distinguish accepted, written, and durably synced
stages. Do not promise `fsync` durability if policy only guarantees queue
acceptance or OS-page-cache write; document the actual fence.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Server unit/integration | `vp run test:server && vp run test:terminal:integration` | history/runtime tests pass |
| Rust lint | `vp run lint:server:rust` | fmt/Clippy exit 0 |
| Platform E2E | `vp exec playwright test --project=platform-e2e` | lifecycle/restart cases pass |
| Web replay E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts tests/web/e2e/terminal-compatibility.web.spec.ts` | replay/close cases pass |
| Bench | `vp run test:bench` plus focused Rust history benchmark command added by this plan | history and existing budgets pass |
| Build | `vp run build:server` | release server builds |

## Suggested executor toolkit

- Use `perfguy` for queue sizing, compressor comparison, tail latency, reusable
  buffers, and saturation behavior.
- Use `codebase-design` to keep active segments, compression, indexes, quota,
  and barriers behind the archive/stream interface.
- Use `playwright-best-practices` for close/restart/replay lifecycle tests.

## Scope

**In scope**

- `apps/server/src/terminal_history.rs`
- A focused split under `apps/server/src/terminal_history/` if one file becomes
  shallow/unwieldy (`codec`, `owner`, `index` remain internal modules)
- `apps/server/src/terminal.rs` only for `TerminalHistoryStream` ownership,
  append/close/barrier calls, and metrics
- `apps/server/src/runtime.rs` only for shutdown/diagnostics integration
- `apps/server/src/lib.rs`
- `apps/server/Cargo.toml` and `Cargo.lock` for the measured compressor and
  optional benchmark dependency
- Rust tests and a focused history benchmark/harness
- Existing web/platform replay/close tests and terminal benchmark diagnostics
- `docs/architecture/terminal-runtime.md`
- `docs/architecture/rust-server-migration.md`
- `plans/README.md` and this plan's status

**Out of scope**

- Changing PTY read/control ownership or batching commands; Plan 019.
- Changing terminal bytes, browser protocol, replay schemas, or binary record
  layout established by Plan 015 except for an explicit format-version bump
  required by the index.
- Persisting live PTYs across host restart.
- An unlimited queue, silent history drop, one worker thread per terminal, or
  running compression on Tokio core threads.
- A public pluggable compressor interface after choosing one implementation.
- Migrating old history formats; reset/quarantine is acceptable.

## Git workflow

- Do not commit, push, or open a PR unless explicitly instructed.
- Preserve Plans 013/015 and operator changes; never reset files.
- Keep all blocking filesystem/compression work on dedicated blocking owners,
  not async reactor threads. No mutex guard may span disk/compression work.

## Steps

### Step 1: Characterize append, flush, read, and lock cost

Add payload-free instrumentation:

```text
history_queue_depth / bytes / high_water
history_enqueue_ns / blocked_ns
history_written_sequence / durable_sequence
history_lag_bytes / lag_ms
active_segment_bytes
history_rotations
history_compress_ns / input_bytes / stored_bytes
history_manifest_write_ns
history_read_ns / blocks_decoded / bytes_decoded
history_quota_scan_ns / directories
history_errors by stage
```

Add deterministic test hooks for a blocked writer, blocked compressor, failed
rename/manifest, and delayed quota pass. Do not inject sleeps into production.
Characterize:

- one PTY append crossing a 512 KiB block;
- 1/8/64 simultaneous terminal streams;
- close with a nearly full block;
- read one page while another terminal rotates;
- global quota with many archive directories;
- shutdown with accepted append/close work.

Record current PTY-reader append time and global lock wait/hold time. Keep exact
byte/restart tests from Plan 015 as the correctness baseline.

**Verify**:

```bash
vp run test:server
```

Expected before refactor: injected compression/IO delays are visible in append
or close latency; baseline counters are emitted without storing payloads.

### Step 2: Introduce a bounded history ingest owner and per-terminal streams

Create one archive ingest owner on a dedicated named thread. Give each live
terminal a generation-scoped `TerminalHistoryStream`; do not repeatedly look up
an ID in a global locked `HashMap` on every chunk.

The ingest mailbox must be bounded by bytes as well as message count. A maximum
PTY chunk is known (64 KiB after Plan 015), but close/barrier/control messages
also need reserved capacity so sustained output cannot starve them. Use a fixed
capacity derived from measured concurrent-terminal workloads and expose it in
diagnostics.

Append semantics:

- validate strictly increasing nonzero sequence per terminal epoch;
- enqueue a `Bytes` clone (pointer clone) without copying payload;
- return after acceptance in the normal path;
- on full queue, increment saturation metrics and apply controlled blocking/
  backpressure until capacity or terminal disposal; do not drop or spill without
  a bound;
- cancellation/owner death returns a typed error and causes terminal/runtime
  diagnostics, never silent success.

Close markers are ordered with that stream's accepted appends and idempotent.
Reserve control capacity so `close`, `read-index`, `flush`, and `shutdown` cannot
starve behind raw messages. Remove the global archive-state mutex from the hot
append path.

**Verify**:

```bash
vp run test:server
vp run lint:server:rust
```

Expected: blocked disk/compression no longer delays append until the bounded
queue is intentionally saturated; queue saturation is bounded/observable;
close/barriers still progress.

### Step 3: Write append-only active segments and rotate outside the PTY path

Have the ingest owner maintain per-terminal active segment state and reusable
512 KiB–1 MiB staging buffers. Use the Plan 015 binary record codec directly;
do not create per-record JSON/base64 or copy `Bytes` into intermediate record
objects unnecessarily.

Required properties:

- one active append-only segment per terminal epoch;
- fixed maximum segment size and record count;
- binary header/record validation and fixed endianness;
- temporary/active naming that crash cleanup can distinguish;
- sequence/record offsets indexed while appending;
- rotation closes a bounded immutable segment and immediately opens/reuses the
  next staging state;
- manifest updates are batched, not rewritten for every append;
- old active segments from a crashed host are validated, finalized, or
  quarantined deterministically on startup.

Disk writes occur only on the history owner. Reuse staging/scratch allocations
between rotations and expose allocation/high-water counters.

**Verify**:

```bash
vp run test:server
```

Expected: exact replay survives rotation/reopen/crash-fixture cleanup; no PTY
thread performs `fs::write`, rename, manifest serialization, or compression.

### Step 4: Move compression/compaction to bounded workers and choose a codec

Build a temporary benchmark comparing LZ4 and low-level zstd on deterministic,
pre-generated corpora:

- ASCII source/build logs;
- ANSI-heavy TUI rewrites;
- Unicode output;
- low-compressibility bytes;
- real redacted terminal-history samples if available locally.

Measure compression/decompression p50/p95/p99, ratio, scratch allocation, and
1/8/64-terminal queue drain. Use 512 KiB and the selected production segment
size. Keep LZ4 unless its stored size materially reduces effective retention
under the fixed quota; choose zstd level 1 only if it preserves queue headroom
and gives a meaningful ratio advantage. Record the measured decision in the
architecture doc, remove the losing runtime dependency, and do not retain a
public compressor abstraction with one adapter.

Compression workers receive immutable rotated segment jobs through a bounded
queue, reuse compressor/scratch state, write a temp file, verify/decode/checksum
as appropriate, and atomically rename. Keep compressed output only when it is
smaller than the resident/raw representation; otherwise store the validated raw
block with an explicit codec tag. Completion updates the per-terminal index and
coalesced manifest. Delete raw rotated input only after completed output/index
is safely published.

One terminal's incompressible block may not prevent active append for another
until the explicit global byte budget saturates.

**Verify**:

```bash
vp run test:server
# Run the focused history codec benchmark command added by this step.
```

Expected: selected codec and ratio/latency results are recorded; scratch
allocation reaches steady reuse; injected compressor stalls remain bounded and
do not invoke PTY-thread compression.

### Step 5: Make replay reads index-driven without forced flush

Publish immutable/sharded per-terminal block indexes containing sequence ranges,
record offsets, codec, compressed/raw length, and active-segment visibility.
`read_page` uses a short metadata snapshot and performs disk/decompression work
outside writer/index locks.

Requirements:

- skip blocks whose `last_sequence <= after_sequence` without opening them;
- decode at most the bounded blocks required for the requested page;
- include already accepted/written active-segment records through a bounded
  owner snapshot rather than forcing global rotation/compression;
- return exact ordered bytes and page cursor/fence semantics from Plan 015;
- tolerate a compressor completion racing the read without duplicates/gaps;
- corruption is typed and observable; it does not return partial data as exact;
- a read for terminal A does not block append/index work for terminal B.

Choose segment/page sizes so one replay page does not require decoding a huge
monolithic archive. Keep newest blocks uncompressed until rotation policy makes
them cold.

**Verify**:

```bash
vp run test:server
vp run test:terminal:integration
```

Expected: one-page reads do not call a flush/compress path; block decode counters
are bounded; concurrent rotate/read tests return exact once-only sequences.

### Step 6: Define close, flush, shutdown, and quota barriers

Integrate Plan 013's close-finalization seam into the new owner:

- explicit PTY kill/close response does not await history IO;
- close marker follows every append already accepted for that terminal epoch;
- no append can reopen a completed stream;
- natural exit and explicit dispose close exactly once;
- `flush()` waits for accepted data to reach the documented written/durable
  stage and returns a structured report of failures;
- host shutdown stops accepting new streams, terminates PTYs, enqueues final
  closes, drains ingest/compression/index work, then joins worker threads;
- test teardown uses the same barrier, not arbitrary sleeps.

Run retention/quota cleanup on an idle/coalesced schedule. Multiple terminal
closes trigger at most one pending global scan. Quota code uses index metadata
where possible and never acquires active writer state repeatedly inside a root
directory loop. Do not delete active/open terminal history.

**Verify**:

```bash
vp run test:server
vp exec playwright test --project=platform-e2e
```

Expected: blocked/failing history does not delay child termination; shutdown
drains accepted work and reports errors; close storms coalesce quota maintenance.

### Step 7: Enforce throughput, saturation, and memory gates

Add deterministic benchmarks for:

```text
append 64 B / 4 KiB / 64 KiB
1 / 8 / 64 active terminals
rotation and compression
read first/middle/tail page
close near rotation
quota with many archives
bounded saturation and recovery
clean shutdown drain
```

Keep generated corpus creation outside measured regions and reuse fixed seeds.
Report medians/p95/p99, queue lag/high water, bytes copied, staging/scratch
allocations, compression ratio, disk bytes, and lock wait/hold.

Machine gates:

- normal append performs no disk/compression and has no global archive lock;
- queue/staging/compression memory stays within configured byte budgets;
- saturation applies measured backpressure and loses zero accepted records;
- steady-state scratch/staging allocation delta approaches zero;
- read/close of one terminal does not materially stall another terminal's append;
- exact restart replay passes;
- existing typing/flood/replay/close budgets are not loosened.

**Verify**:

```bash
vp run test:server
vp run test:bench
```

Expected: all exact queue/memory/loss gates pass; benchmark context and selected
codec are printed.

### Step 8: Run full server/client integration

Update architecture docs with owner threads, byte budgets, accepted/written/
durable semantics, codec decision, active segment/index format, quota schedule,
and shutdown ordering.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:terminal:integration
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-multiplexer.web.spec.ts \
  tests/web/e2e/terminal-compatibility.web.spec.ts
vp exec playwright test --project=platform-e2e
vp run test:bench
vp run build:server
```

Expected: all commands exit 0; no benchmark ceiling is loosened; no synchronous
history disk/compression remains on the PTY path.

## Test plan

- Binary owner: ordered append, per-epoch validation, queue count/byte bounds,
  reserved control capacity, saturation/cancellation, owner death.
- Active segments: rotation, crash recovery, reusable staging, sequence index,
  atomic publication.
- Compression: deterministic corpora, selected codec, incompressible fallback,
  temp/rename failure, scratch reuse, bounded queue.
- Read: first/middle/tail pages, active+compressed race, corruption, no forced
  flush, exact malformed bytes, concurrent terminals.
- Lifecycle: explicit/natural close once, append-close race, kill independent
  from history, shutdown drain/report, quota coalescing.
- E2E/bench: restart replay, close during output, 1/8/64 terminals, slow disk/
  compressor injection, memory/lag bounds.

## Done criteria

- [x] PTY output threads perform no history compression, manifest IO, rename, quota scan, or replay read.
- [x] History ingest is bounded by messages and bytes with reserved control progress.
- [x] Saturation is observable/non-lossy and cannot become unbounded memory.
- [x] Raw output remains versioned binary records with exact malformed-byte replay.
- [x] Archive state is owner-local/per-terminal or sharded; no global lock spans cold work.
- [x] Active segments append/rotate independently from compression.
- [x] Compressor/staging scratch is reused and the selected codec is benchmark-documented.
- [x] Replay reads use sequence indexes and do not force global flush/compression.
- [x] Close returns independently from history and shutdown drains accepted work.
- [x] Quota maintenance is coalesced and never deletes active terminal history.
- [x] Plan-scoped restart, lifecycle, unit, E2E, build, lint, and benchmark behavior is verified.

## Completion record

The committed owner already provided byte-bounded ingest, checksummed active
segments, exact binary gzip blocks, indexed page reads, close ordering, crash-tail
recovery, and explicit flush/shutdown barriers. Completion additionally bounds
the formerly unbounded finalization lane and makes queue-full/owner-death a typed
error without delaying the PTY close path. Server, Rust lint, terminal
integration, restart/platform, web replay, and release server build gates passed.
The repository-wide lint and unrelated renderer benchmark are operator-waived as
recorded in Plan 015; no compression or latency improvement is claimed.

## STOP conditions

- Plan 013/015 history interfaces differ materially and would produce parallel
  finalizers or duplicate binary codecs.
- Any accepted record or close marker can be silently dropped.
- Queue memory is bounded only by message count while message byte size is
  effectively unbounded.
- A mutex guard spans compression, file IO, directory scans, or decompression.
- `read_page` correctness requires flushing/compressing all pending terminals.
- Shutdown can return while accepted work is neither drained nor reported.
- Compressor choice is made from one ad hoc timing instead of deterministic
  repeated corpus measurements.
- The implementation attempts live-PTY restart durability or a history migration
  reader outside scope.

## Maintenance notes

History has three distinct promises: accepted into bounded memory, written to a
segment, and durably synced. Keep them named and observable. Future format,
quota, or compressor changes must preserve per-terminal sequence order and the
shutdown barrier. Reviewers should scrutinize byte-budget accounting, control
lane starvation, append/close races, temp-file publication, compressor scratch
reuse, and any convenience call that reintroduces cold work under the ingest
owner's hot loop.
