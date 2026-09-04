# Terminal runtime

> This file describes the current implementation. The normative target and migration invariants live in [`../terminal-architecture.md`](../terminal-architecture.md). Where the files differ, the target document governs new terminal work.

YAADE uses one host process as the terminal multiplexer:

```text
browser  <->  host server  <->  TerminalHost  <->  portable-pty children
```

`TerminalHost` maps terminal IDs to fixed reactor shards. The shard count is
bounded by configuration and CPU count (currently at most eight); it does not
grow with terminal count. A shard thread constructs, mutates, and drops all of
its `ghostty_vt::Terminal` authorities and owns their PTY masters, writers,
children, replay, checkpoint state, thermal state, attachment phase, and writer
leases. Native Ghostty never enters an `Arc`, mutex, async task, history worker,
or socket path. Unix PTY masters are nonblocking and registered in each shard's
`polling` epoll/kqueue set with monotonically unique runtime keys, so descriptor
reuse cannot receive stale events. There is no reader thread or task per Unix
PTY; Windows retains a clearly separated fallback until a measured ConPTY
completion design exists.

Urgent and normal shard queues are independently bounded. A turn processes a
bounded command batch and at most 64 ready descriptors before returning to
urgent work. Adjacent writes coalesce into a bounded 256 KiB staging batch and
enter a per-terminal 2 MiB serialized input queue. Writable readiness drains at
most 64 KiB per turn, so a child that stops reading cannot block its shard.
Ghostty-generated PTY responses use the same sequencer. Consecutive resize
bursts are latest-wins within one shard turn; all receipts resolve and the final
dimensions update PTY, Ghostty, and checkpoint together. Terminal-map cleanup
also uses a bounded lane. Queue saturation returns a typed runtime error.

The history owner accepts records through a 1,024-message / 32 MiB ingest
mailbox. Live PTY owners use its nonblocking append operation: saturation is
reported as degraded history and never stalls PTY fanout. A separate bounded
1,024-message close lane reserves lifecycle progress;
a full or stopped lane returns a typed error rather than dropping finalization.
The owner writes a checksummed append-only active segment before adding each
record to its 512 KiB binary block batch. Startup keeps complete records and
truncates a torn tail. Block and manifest publication clears the active segment
only after the manifest rename. Compression uses reusable gzip level-6 staging;
no codec latency advantage is claimed by this completion. Compression and file
work never run on a PTY reader or hold the terminal map lock. There is no
detached supervisor or disk-backed process recovery.

## Lifetime

- Browser reloads and disconnects only remove viewers. PTYs continue running.
- Closing a terminal disposes its PTY.
- Host shutdown or crash ends all PTYs and their process groups.
- Host startup preserves Session, Window, layout, title, ordering, terminal, and
  archive identities. Every formerly live terminal becomes `disconnected` /
  `interrupted`, loses its writer/PTY identity, and keeps its last generation.
- An interrupted terminal can render validated retained output read-only. Its
  explicit restart creates a new shell and generation; it never resumes execution.
- Users must not restart the host while a long-running command matters.

Startup performs one atomic store reconciliation. Restart metadata records the
reason and previous/new server epochs outside terminal output. Before stale
process identity is cleared, the host compares the persisted PID start token,
boot identity where available, and executable path with the current process. It
terminates only an exact matching PTY process group (or Windows process tree),
first requesting graceful termination and then applying a bounded forced-kill
fallback. It never adopts the old PTY or signals a reused PID.

## Data path

Each PTY read creates one immutable `Bytes` chunk. In one shard turn the byte
position advances, the same allocation is submitted first to bounded live
fanout and nonblocking history ingest, and Ghostty then consumes those exact
bytes as the authority sidecar. In-band query responses return through the PTY
input sequencer. Neither Ghostty parsing nor archive work gates capable-client
fanout. `EventHub` encodes one shared protocol-v4
`PTY_DATA` message per chunk; attached clients clone handles, not payloads.
WebSocket libraries may perform the final contiguous-message copy. PTY and
input payloads remain opaque binary through server, WebSocket, browser
`Uint8Array`, and Ghostty worker. Only terminal IDs and completed textual
protocol metadata are UTF-8 decoded.
Ghostty's public snapshot encoder produces bounded, CRC-protected checkpoint-v2
payloads with exact parser continuation. The history owner atomically persists
the opaque binary snapshot through a nonblocking, bounded checkpoint lane;
private parser memory is never serialized and persistence saturation preserves
the prior committed snapshot. Durable history stores a versioned big-endian
binary record stream inside compressed blocks, so malformed or incomplete
UTF-8 replays exactly. Output is batched by byte count to reduce framing overhead, while small
interactive chunks flush immediately. Capable clients use the transport-neutral
36-byte protocol-v4 header and inclusive epoch/byte positions. Attach takes an
owner-side atomic cut `N`, then queues the small attach result, opaque binary
`SNAPSHOT @ N`, `READY @ N`, and only `PTY_DATA` after `N`. The client validates
the stream ID, epoch, and contiguous byte range and does not restore or send
input before the snapshot/READY barrier. Input and resize use binary frames with
independent monotonic positions. A per-client overflow emits binary
`RESYNC_BEGIN`, drops stale deltas, and starts the same attach transaction.
Protocol 1 remains a network-edge compatibility adapter only. Capable protocol-2
connections carry terminal `HELLO`, `ATTACH`, `ATTACH_ACK`, `READY`, `DETACH`,
`CONTROL_ACK`, `ERROR`, `PING`, and `PONG` in protocol-v4 binary frames. Bounded
JSON metadata may appear inside a control payload. Snapshot, PTY, input, and
history bytes never enter JSON or base64. Each admitted WebSocket has one writer
task as the sole sink owner. The reader
handles commands and ACKs without awaiting network output; every producer uses
a non-awaiting `ConnectionOutbound` backed by bounded reliable and ordered raw
lanes. Semantic snapshot/patch frames are not connected to the capable-client
runtime. `EventHub` indexes weak subscribers by terminal and
connection, so a raw terminal frame visits only attached clients while metadata
retains the shared sequence source. On raw/flow overflow the connection rejects
later live bytes for that terminal and enqueues one reliable binary resync fence
at the parser-acknowledged byte position; reliable overflow closes with 1013.
A successful attach/replay resets the fence. Consequently a slow viewer cannot
pause the PTY, another viewer, or its own inbound command task. The history
archive can rebuild terminal bytes after the live replay ring trims old chunks
and can serve validated pages without a live terminal entry. Capable clients
request history with binary `SCROLLBACK_BEGIN`; the server reads it on a blocking
worker and atomically enqueues binary `SCROLLBACK_BEGIN`, `SCROLLBACK_CHUNK`, and
`SCROLLBACK_END` frames in a separate 2 MiB low-priority lane. Live/control
always drain first. The JSON history route remains only as a compatibility
fallback for transports without the binary terminal plane. It does
not keep the PTY alive across host restarts. Mailbox acceptance is a bounded
in-memory fence, not an `fsync` promise. `flush_all` waits for accepted records,
active-segment writes, block publication, and manifest renames, but does not claim
power-loss durability beyond the operating system's page-cache guarantees. Crash
recovery retains complete checksummed active records and rejects missing or
corrupt archives instead of presenting partial output as exact.

Input, resize, paste, focus, mouse, and close operations use per-connection
writer leases. Input and resize are rejected until that connection has completed
its `READY` barrier. The terminal owner authorizes a mutation and applies it in
one command, so queue rejection cannot consume a command fence. Authenticated
connections with control scope may mutate the same terminal concurrently;
observe-only connections remain read-only.

## Thermal lifecycle

Every authority has an explicit `Hot`, `Warm`, or `Parked` state. Recent IO or
attachments promote it to hot. Idle owner turns run Ghostty incremental
compression for warm sessions and full compression plus transient replay
capacity trimming for parked sessions. PTY descriptors remain registered with
the shared poller, so readiness promotes a parked session without descriptor
handoff. Diagnostics expose session and parked counts, attached clients, shard/owner
thread counts, PTY bytes, snapshot bytes/count/duration, compression
count/duration, wake duration, thermal transitions, connection/desync/resync
counts, and current/peak client queue bytes. This is memory compaction, not
process persistence; host death still ends PTYs. Reproducible scale evidence and
its host PTY-limit caveat are recorded in
[`terminal-benchmarks.md`](terminal-benchmarks.md).

## Browser parser and presentation

Each Ghostty worker shares a bounded fair scheduler across its terminals while
preserving each terminal's command order. Focused and visible terminals receive
higher deficit weights. Each terminal may hold one in-flight command, which
prevents a flooded terminal from filling all worker capacity. Generation and
sequence keys stop a stale completion from releasing a replacement runtime's
command. Lifecycle diagnostics include aggregate scheduler bytes, command
count, and in-flight count.

Workers continue parsing while a terminal is hidden or DEC mode 2026 suppresses
presentation. They skip render-update construction and transfer until the
terminal becomes visible or synchronized output ends. A one-second safety timer
presents a catch-up frame for a producer that leaves synchronization enabled.
The worker reports parsed, suppression, catch-up, timeout, transfer, allocation,
and slot counters without terminal content.

Render updates use three generation-scoped transferable slots. The main thread
returns each slot after model application. The worker rejects stale returns and
waits when all slots are leased. Idle workers trim oversized returned buffers
after hysteresis and cooldown thresholds; active terminals keep their hot
buffers.

## Design rules

1. Keep PTY ownership in `TerminalHost` and lifecycle in the host Effect scope.
2. Never block PTY output on a browser or WebSocket.
3. Keep replay and queues bounded; a detected gap must trigger resynchronization.
4. Keep reliable control, ordered raw output, and asynchronous history in separate bounded lanes; semantic screen diffs are not the capable-client data plane.
5. Prefer direct calls over process boundaries, adapters, and recovery state.
6. Test a real interactive shell and a directly launched command through
   `portable-pty`.
7. Treat host restart as process-destructive and catalog/history-preserving.
   Breaking persisted-state upgrades may reset the database instead of adding
   compatibility code.
