# Terminal runtime

YAADE uses one host process as the terminal multiplexer:

```text
browser  <->  host server  <->  TerminalHost  <->  node-pty children
```

`TerminalHost` maps terminal IDs to handles. One owner thread per terminal owns
the PTY master, writer, child, replay, checkpoint parser, and writer leases. A
small 256 KiB-stack reader thread only reads the blocking PTY and sends at most
64 immutable 64 KiB chunks over a bounded channel. The 1 MiB-stack owner
services 64-entry urgent and normal command lanes between 1 MiB output quanta.
It drains up to 64 immediately available adjacent writes into one bounded 256
KiB scratch batch and flushes once; a lone keystroke is never timer-delayed.
Consecutive resize bursts are latest-wins within the same owner turn, all
receipts resolve, and the final dimensions update the PTY, recorder, and
checkpoint together. Terminal-map cleanup also uses a bounded 256-entry lane.
Queue saturation returns a typed runtime error.

The history owner accepts records through a 1,024-message / 32 MiB ingest
mailbox. A separate bounded 1,024-message close lane reserves lifecycle progress;
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

PTY output remains opaque ordered bytes from each host read through immutable
`Bytes` replay/history/live frames, binary WebSocket payloads, browser
`Uint8Array` replay coordination, and the Ghostty worker. Only terminal IDs and
completed textual protocol metadata are UTF-8 decoded. Durable history stores a
versioned big-endian binary record stream inside compressed blocks, so malformed
or incomplete UTF-8 replays exactly. Output is batched by byte count to reduce
framing overhead, while small interactive chunks flush immediately. A
fresh browser renderer attaches behind a replay barrier: history pages are
parsed in order, concurrent live bytes remain bounded, and only bytes newer
than the replay cursor are released afterward. Each admitted WebSocket has one writer task as the sole sink owner. The reader
handles commands and ACKs without awaiting network output; every producer uses
a non-awaiting `ConnectionOutbound` backed by bounded reliable, ordered raw, and
replaceable semantic lanes. `EventHub` indexes weak subscribers by terminal and
connection, so a raw terminal frame visits only attached clients while metadata
retains the shared sequence source. On raw/flow overflow the connection rejects
later live bytes for that terminal and enqueues one reliable replay-required
fence at the parser-acknowledged sequence; reliable overflow closes with 1013.
A successful attach/replay resets the fence. Consequently a slow viewer cannot
pause the PTY, another viewer, or its own inbound command task. Semantic
snapshots use a replaceable binary lane rather than the reliable control
mailbox. The history archive can rebuild terminal bytes after the live replay ring trims
old chunks and can serve validated pages without a live terminal entry. It does
not keep the PTY alive across host restarts. Mailbox acceptance is a bounded
in-memory fence, not an `fsync` promise. `flush_all` waits for accepted records,
active-segment writes, block publication, and manifest renames, but does not claim
power-loss durability beyond the operating system's page-cache guarantees. Crash
recovery retains complete checksummed active records and rejects missing or
corrupt archives instead of presenting partial output as exact.

Input, resize, paste, focus, mouse, and close operations use per-connection
writer leases. The terminal owner authorizes a mutation and applies it in one
command, so queue rejection cannot consume a command fence. Authenticated
connections with control scope may mutate the same terminal concurrently;
observe-only connections remain read-only.

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
4. Keep reliable control, ordered raw output, and replaceable semantic state in separate lanes.
5. Prefer direct calls over process boundaries, adapters, and recovery state.
6. Test a real interactive shell and a directly launched command through
   `portable-pty`.
7. Treat host restart as process-destructive and catalog/history-preserving.
   Breaking persisted-state upgrades may reset the database instead of adding
   compatibility code.
