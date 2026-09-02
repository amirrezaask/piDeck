# Rust server architecture

YAADE's only host implementation is the Rust crate in `apps/server`. It owns HTTP, JSON RPC, WebSockets, SQLite, PTYs, terminal replay, device authentication, runtime manifests, and user-service lifecycle. Browser and desktop clients consume the contracts in `packages/yaade-rpc` and never own agent processes.

## Module seams

1. `config` resolves CLI and environment input into a validated `HostConfig`.
2. `database_owner` owns one SQLite connection on a dedicated bounded worker.
3. `store` owns Session, Window, layout, and terminal mutations.
4. `terminal` owns PTYs, checkpoints, compressed replay history, leases, and process cleanup.
5. `event_hub` sequences events, retains bounded non-PTY history, and indexes attached terminal subscribers.
6. `connection_outbound` owns each admitted connection's bounded reliable/raw/semantic mailbox.
7. `server` handles HTTP/WebSocket admission and gives the socket sink to one writer task.
8. `runtime` wires the modules and dispatches typed host routes.

The terminal interface hides Unix PTY and Windows ConPTY differences. Client disconnects preserve PTYs; explicit terminal close and host shutdown terminate them.

## Runtime stack

- Tokio for asynchronous execution.
- Axum and Hyper for HTTP and WebSocket transport.
- `portable-pty` for Unix PTYs and Windows ConPTY.
- `rusqlite` with bundled SQLite on the dedicated database worker.
- Serde for wire models mirrored from `packages/yaade-rpc`.
- `bytes` for binary terminal frames.
- Ghostty in browser and desktop renderers as the authoritative terminal model.

The host emits the negotiated raw binary terminal stream. It omits the terminal-level semantic `protocolVersion` and rejects explicit `semantic` or `both` attaches until a native Ghostty adapter exists. `vt100` is used only to produce conservative replay checkpoints; it does not replace Ghostty rendering.

## Implemented behavior

- CLI configuration, runtime manifests, static serving, service install/control, status, doctor, and pairing.
- Loopback defaults, bearer and device authentication, scopes, CORS, origin checks, and allowed-root confinement.
- SQLite identity, sessions, windows, layouts, terminal metadata, revision fences, WAL, integrity checks, and storage-failure records.
- Protocol 1 replay and protocol 2 hello, snapshot, in-band authentication, binary output, acknowledgement credit, and replay-required recovery.
- PTY create, attach, compressed persisted replay, paging, checkpoints, write, resize, cwd/process inspection, exit ordering, cleanup, and disposal.
- Writer leases, mutation fences, duplicate-command protection, bounded mailboxes, per-terminal flow control, and slow-client isolation.

## Verification

Rust unit and integration coverage lives in `apps/server/src` and `apps/server/tests/server_parity.rs`. Linux, macOS, and Windows build/test coverage is enforced by the `runtime-platform` CI matrix. Browser, security, and service lifecycle suites launch the Rust executable directly.

Useful commands:

```bash
vp run test:server
vp run lint:server:rust
vp run typecheck
vp exec playwright test --project=security-e2e
vp exec playwright test --project=platform-e2e
vp run test:web:e2e
```

## Historical release comparison

A same-machine HTTP RPC workload used 500 sequential latency samples followed by 3,200 requests at concurrency 32:

| server | p50 | p95 | p99 | throughput | idle RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| former TypeScript implementation | 1.67 ms | 1.86 ms | 2.30 ms | 7,267 req/s | 163 MiB |
| Rust release | 1.37 ms | 1.50 ms | 1.98 ms | 10,261 req/s | 9.5 MiB |
