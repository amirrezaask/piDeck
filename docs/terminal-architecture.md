# Distributed terminal runtime

This document defines the terminal subsystem's required architecture. It supersedes the semantic snapshot-and-patch direction in Plan 033. A server-rendered cell stream may exist as an isolated compatibility adapter, but capable clients consume a terminal snapshot followed by ordered PTY bytes.

## Scope and workload

The runtime must support 1,000 durable, mostly idle PTYs, busy interactive terminals, multiple viewers per terminal, browser reconnects, and large retained histories. We have not measured the 1,000-session workload in this repository. Current tests cover 64 terminals at most, and the host rejects terminal 65.

Record measurements as `measured`; keep product targets as `specified`; label temporary sizing values as `assumed`. Do not turn an assumed queue size or idle timeout into a permanent interface contract.

The main transforms are:

```text
process output
  -> PTY readiness/read
  -> immutable byte chunk
  -> per-session output sequencer
       -> authoritative Ghostty state
       -> retained history
       -> attached client queues
  -> transport codec
  -> client Ghostty replica
  -> renderer

client or agent input
  -> protocol validation and authorization
  -> per-session input sequencer
  -> PTY master
```

Each edge must expose ownership, byte count, queue capacity, ordering, and overload behavior through content-free diagnostics.

## Non-negotiable invariants

1. Live PTY data travels as raw bytes.
2. Server VT parsing does not gate live socket delivery. The session owner gives the same immutable chunk to the terminal authority and fanout path in one ordered turn; it does not render cells back into ANSI for capable clients.
3. The server and capable clients maintain replicated terminal state machines.
4. Each attachment starts from a restorable terminal snapshot.
5. A snapshot at position `N` contains every PTY output byte through `N`; live delivery starts at `N + 1`.
6. A server `READY` frame marks the point at which the client may send input.
7. Scrollback transfer runs below live traffic and never delays `READY`, input, or PTY output.
8. A slow client cannot backpressure a PTY without a short, explicit system-wide safety bound.
9. Each client queue has byte and frame limits.
10. A sequence gap, queue overflow, reconnect, or decode failure discards the stale replica and starts snapshot resynchronization.
11. Pane layout, tabs, zoom, selection, search state, viewport position, and copy mode belong to clients. A pane references a session.
12. One session owner orders all PTY input from humans, agents, automation, and terminal query responses.
13. Idle terminal memory can be compacted or replaced by a validated memento.
14. Idle PTYs use shared OS readiness polling. Linux uses epoll; macOS and BSD use kqueue.
15. Resource use scales with active PTYs, attached clients, and traffic rather than the total durable-session count.

A change that violates an invariant needs an architecture decision in this file before merge.

## Authoritative data

Store these facts once:

```text
session_core
  session_id
  terminal_epoch
  process_binding
  lifecycle
  dimensions
  created_at
  last_activity
  exit_status

stream_position
  terminal_epoch: u64
  byte_offset: u64

terminal_authority
  Ghostty handle
  snapshot generation
  thermal state

client_attachment
  connection_id
  session_id
  connection phase
  acknowledged position
  queue bytes
  controller capability

history_index
  session_id
  terminal_epoch
  byte and row ranges
  block metadata
```

`terminal_authority` owns visible state, parser continuation, modes, alternate screen, cursor, styles, palette, title, dimensions, and bounded hot scrollback. History blocks and client render models are derived data. A snapshot is a versioned memento, not a second source of truth.

Use these lifecycle axes:

```rust
pub enum SessionPhase { Starting, Running, Exited, Terminated, Restoring }
pub enum ConnectionPhase { Synchronizing, Ready, Desynchronized, Closing }
pub enum ThermalState { Hot, Warm, Parked }
```

Do not infer connection readiness from session lifecycle.

## Stream position

Sequences count PTY output bytes. `byte_offset` is the inclusive offset of the final byte in a `PTY_DATA` payload. The first output byte in an epoch has offset 1. A payload ending at `N` and containing `L` bytes covers `(N - L + 1)..=N`. Empty data frames are invalid.

An epoch changes when the logical PTY byte stream is replaced. Positions from different epochs are never comparable. The terminal UUID remains application identity; the protocol carries compact numeric stream and epoch identifiers assigned during attach.

The server rejects duplicate or decreasing input positions. A client requests resynchronization when the next payload does not begin at its expected offset.

## Session ownership and scheduling

A fixed number of terminal reactor shards own all mutable session runtime state. Hash `session_id` to one shard. A shard constructs and drops each `ghostty_vt::Terminal`, satisfying its `!Send + !Sync` contract without a thread per session.

Each shard owns:

- a kqueue/epoll-compatible poller for PTY master descriptors;
- terminal authorities for its sessions;
- input and lifecycle command queues;
- output sequencing and snapshot cuts;
- hot, warm, and parked processing sets.

Callers send bounded commands containing immutable bytes and typed IDs. They cannot access shard internals. A shard drains urgent lifecycle and input work, processes a bounded readiness/output quantum, then handles snapshots and low-priority maintenance. It never waits for network IO, database IO, history compression, or a client renderer.

`portable-pty` exposes a raw Unix master descriptor, but the current blocking reader abstraction owns one thread per PTY. The parking migration must replace that reader path with nonblocking descriptor reads registered on the shard poller. Promotion and demotion change processing-set membership, not descriptor ownership, which avoids handoff races and FD reuse bugs.

Windows needs a separate ConPTY adapter and measured completion-port design. Do not emulate Unix readiness with one permanent reader thread per parked session and call it parking.

## Output hot path

```text
readv/read into pooled slab
  -> freeze one immutable Bytes value
  -> advance byte offset
  -> feed server Ghostty authority
  -> submit shared Bytes to history
  -> clone handles into attached client queues
```

Ghostty callback effects, including PTY query responses, return to the same session input sequencer. Parser errors terminate or quarantine the authority and force client resync; the server must not continue publishing bytes while claiming its snapshot authority is valid.

WebSocket framing may copy a header and payload into one library-owned message when the transport requires contiguity. Record that copy. No fanout code may clone the payload per client before the transport boundary.

## Binary protocol

The terminal protocol is transport-independent. WebSocket, QUIC, and TCP adapters consume the same codec.

Each frame carries:

```text
version | type | flags | header length
stream id
stream epoch
byte offset / control sequence
payload length
payload
```

Decoders validate version, type, flags, lengths, configured maximums, and trailing bytes before allocation. Required frame types are:

```text
HELLO              ATTACH             ATTACH_ACK
SNAPSHOT           READY              PTY_DATA
INPUT              RESIZE             SCROLLBACK_BEGIN
SCROLLBACK_CHUNK   SCROLLBACK_END     RESYNC_REQUEST
RESYNC_BEGIN       SESSION_EXIT       ERROR
PING               PONG
```

Control messages may use compact structured payloads inside binary frames. `PTY_DATA`, `INPUT`, snapshot bytes, and scrollback bytes remain opaque binary payloads. JSON and base64 are forbidden in this protocol.

## Atomic attach and resync

The session shard performs attach as one owner transaction:

1. Register a bounded synchronizing queue for the client.
2. Establish byte cut `N` after applying all output through `N` to the authority.
3. Export a restorable Ghostty snapshot at `N` without holding a global lock.
4. Enqueue `ATTACH_ACK`, `SNAPSHOT @ N`, and `READY @ N` in that order.
5. Keep output arriving after `N` in the synchronizing queue.
6. Release queued `PTY_DATA` only after `READY` is queued.

The socket writer may take time to transmit the snapshot. Only that client's bounded synchronizing queue absorbs concurrent data. Overflow changes the connection phase to `Desynchronized`, drops obsolete deltas, and starts a new cut. It never pauses the PTY.

The server rejects `INPUT` unless the attachment phase is `Ready` and the writer lease is valid. `RESYNC_REQUEST` is safe in every non-closing phase and runs the same attach transaction with a new cut.

## Snapshot contract

The accepted implementation decision and reproducible evidence are recorded in
[`architecture/terminal-checkpoint-restore.md`](architecture/terminal-checkpoint-restore.md).

A snapshot must let a fresh matching Ghostty instance continue parsing as though it processed all bytes through the cut. It includes parser continuation, both screens, cursor and saved cursor state, modes and saved modes, charsets, margins, tab stops, styles, palette, hyperlinks, keyboard protocol state, synchronized-output state, title, dimensions, and bounded hot scrollback.

A render-row projection or formatter-generated ANSI stream does not satisfy this contract. Visual equality before subsequent bytes is insufficient; restore correctness requires equality after arbitrary continuation bytes.

The envelope contains a protocol version, engine revision, engine snapshot-format version, stream ID, epoch, cut position, dimensions, uncompressed size, codec, and checksum. Decoders enforce a strict size bound before decompression or import. Import failure discards the new replica and requests resync.

The pinned public libghostty-vt API at revision `07bccf7a311acdfa6afc77f2016160d49b1f1982` provides the required CRC-protected snapshot format, READY-delimited progressive restore, exact unfinished parser continuation, and scrollback compression. Native and WASM use this opaque format directly inside a bounded YAADE checkpoint-v2 envelope. The client validates epoch, revision, format, length, and SHA-256 before atomic worker restore; decoder failure falls back to exact raw replay. Formatter-generated synthetic checkpoints have been removed.

## Scrollback and history

The authority keeps enough hot scrollback for snapshot and current interaction. A separate history owner stores bounded chunks with byte and logical-row ranges, checksums, and codec metadata. It can spill old chunks to disk without walking the full history.

After `READY`, the client requests recent-to-old history ranges. The transport splits history into bounded `SCROLLBACK_CHUNK` frames. Live/control frames always drain before history. A connection has independent live and history byte budgets, so history cannot consume live queue capacity.

Server history never controls a client's viewport. Clients merge fetched immutable rows into a bounded local page cache and maintain independent scroll, search, and selection state.

## Backpressure

Every queue documents producer, owner, ordering scope, capacities, and overflow behavior.

| Queue                  | Overflow policy                                                                  |
| ---------------------- | -------------------------------------------------------------------------------- |
| PTY readiness to shard | No queue per byte; drain descriptor in bounded quanta                            |
| Input commands         | Reject with `HOST_BUSY`; do not consume mutation fence                           |
| Live client data       | Mark that client desynchronized, drop queued deltas, resnapshot                  |
| Reliable control       | Close connection if an error/resync signal cannot be queued                      |
| Snapshot               | Replace only before transmission begins; otherwise start a new resync generation |
| Scrollback             | Cancel or replace the range request                                              |
| History ingest         | Bounded short backpressure or durable spill; expose saturation                   |

The current connection mailbox allocates up to 32 MiB for raw data per client. Treat that value as an unvalidated baseline, not a target.

## Resize policy

A terminal has one explicit controller lease. Only that controller changes PTY dimensions. Observer viewport changes remain local. When control transfers, the new controller's next measured size becomes authoritative. Resize, Ghostty authority update, checkpoint generation, and in-band resize response occur in one session-owner turn.

## Thermal lifecycle and compaction

Activity and attachment transitions maintain explicit processing sets:

```text
Hot: recent IO or an attached controller
Warm: short idle period or observers only
Parked: long idle period with no attachments
```

Hot sessions receive low-latency readiness quanta. Warm sessions keep expanded authority but run incremental page compaction during idle shard turns. Parked sessions keep their PTY descriptor in the shared poller, compact all eligible Ghostty pages, trim transient buffers, and retain only bounded metadata plus the authority or a validated snapshot memento.

The pinned libghostty-vt API exposes owner-scheduled incremental and full terminal compression plus an activity token. The checked Rust wrapper maps these to bounded owner-loop operations. Deep parking may unload the authority only after exporting and validating a bounded snapshot memento. Readiness restores and promotes a parked session before processing its bytes.

## Persistence and process lifetime

Browser disconnect, tab close, pane removal, and client process exit only detach viewers. An explicit session termination kills the process. Process exit emits `SESSION_EXIT`; the terminal and final history remain available under a separate retention policy.

The current host process owns child PTYs, so host death kills sessions. This architecture calls sessions durable across client lifetimes, not host-process durable. Host-crash survival requires a detached PTY supervisor with authenticated re-adoption. Add it only through a separate process-lifetime decision; do not claim restart durability while the host remains the PTY parent.

Persistence stores metadata, validated snapshots, and compressed history in background owners. PTY output does not perform database writes or filesystem compression.

## Metrics

Expose counters, gauges, and histograms for session phases, thermal sets, attachment phases, PTY bytes and syscalls, input bytes, queue depth/bytes/age, snapshots, resyncs, slow-client recovery, history bytes, protocol bytes, compression cost/savings, parking transitions, wake latency, task/thread count, and memory by session/client class. Labels must not contain terminal content, commands, paths, titles, or secrets.

Required memory reports include base RSS and deltas for an empty, hot, warm, and parked session; 1k and 100k history lines; an attached client; and a stalled client.

## Correctness gates

Tests compare an uninterrupted authority with `snapshot @ N + ordered bytes after N`. Cuts include partial UTF-8 and partial CSI, OSC, DCS, and APC input. The suite covers alternate screen, saved cursor, terminal modes, resize during output, dropped data, slow clients, thousands of reconnects, and randomized byte/resize streams.

Parking stress tests cycle hundreds and then 1,000 PTYs through hot, warm, and parked sets while processes emit output and exit. Assertions cover missing or duplicate bytes, stale descriptor generations, FD reuse, shutdown races, and bounded thread/task counts.

Benchmarks record RSS, heap, allocations, syscalls, context switches, CPU, throughput, and p50/p95/p99 latency for the matrix in the migration mission. Store hardware, OS, compiler, Ghostty revision, fixture hashes, and queue limits with each result.

## Current-to-target migration map

| Current module                                                               | Target module                                                | Required migration                                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `terminal.rs::TerminalHost` map plus one owner and one reader thread per PTY | fixed terminal reactor shards                                | Move Ghostty, PTY descriptors, process state, sequencing, and commands into shard-owned rows and readiness sets.              |
| `portable_pty` blocking reader thread                                        | Unix nonblocking PTY adapter plus shared epoll/kqueue poller | Register raw master FDs once; remove per-session reader threads; protect reused FDs with generation IDs.                      |
| chunk-count `EntryState.sequence` and UUID string epoch                      | byte-offset `StreamPosition`                                 | Advance by payload length and carry compact epoch/stream IDs in every terminal frame.                                         |
| Ghostty authority with `scrollback: 0`                                       | authority with bounded hot scrollback                        | Retain render-critical scrollback and expose compaction. Durable history remains separate.                                    |
| removed synthetic ANSI `TerminalCheckpoint`                                  | versioned restorable Ghostty snapshot                        | Checkpoint v2 carries bounded opaque Ghostty bytes, revision/format metadata, SHA-256, and exact continuation tests.          |
| JSON attach RPC plus binary raw data frame                                   | transport-independent binary protocol                        | Implement one Rust codec and matching client codec for all terminal frame categories.                                         |
| subscribe-before-RPC replay barrier                                          | shard-owned atomic snapshot cut                              | Enqueue snapshot, server `READY`, and exact post-cut data under one attachment generation.                                    |
| client `terminal:ready` query-response marker                                | server `READY` interaction barrier                           | Track connection phase on both sides and reject input before server readiness.                                                |
| 2 MiB replay bridge and 32 MiB raw connection lane                           | bounded resync queue                                         | Drop obsolete deltas on overflow and take a new snapshot instead of replaying an arbitrary ring.                              |
| JSON/base64 history RPC pages                                                | low-priority binary scrollback ranges                        | Stream bounded recent-to-old chunks independently from live data.                                                             |
| dormant semantic v3 snapshot/patch store                                     | compatibility observation adapter or removal                 | Do not make screen diffs the capable-client data plane. Delete the JSON-in-binary codec after raw-replica cutover.            |
| server-persisted tab `layout_json`                                           | optional workspace-sync feature outside terminal substrate   | Keep pane-to-session mapping in the application/client tier; terminal runtime receives no viewport state.                     |
| history gzip owner                                                           | chunked indexed history owner                                | Add range metadata, lower-priority transport, measured codec choice, and optional spill policy.                               |
| no terminal thermal state                                                    | explicit hot/warm/parked sets                                | Add activity transitions, page compaction, buffer trim, metrics, and wake tests.                                              |
| no PTY parking                                                               | shard poller ownership                                       | Keep idle descriptors registered without dedicated session threads or tasks.                                                  |
| 64-terminal hard cap                                                         | measured 1,000-session budget                                | Raise the cap only after parked-session RSS, FD limits, poller behavior, and shutdown pass gates.                             |
| sparse history-capacity diagnostics                                          | terminal runtime metrics registry                            | Add the complete content-free metric set and structured phase traces.                                                         |

## Cutover rules

Keep one authoritative terminal output path during migration. A temporary protocol-version adapter may translate at the network edge, but old JSON/base64 attach and dormant semantic diff code must leave production after capable clients use snapshot plus raw bytes. Do not keep two session owners, two terminal parsers, or two queue policies.

The Ghostty snapshot and compaction gate is satisfied at revision `07bccf7a311acdfa6afc77f2016160d49b1f1982`; continuation parity must remain a release gate while attach semantics are replaced. The next hard gate is the shared Unix reactor under PTY output/exit stress. Protocol and client cutover follow it. A release may not claim this architecture before both reactor and replicated-state correctness gates pass.
