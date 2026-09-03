Packages are deep modules — see [packages/README.md](./packages/README.md) before adding or importing one.

## Terminal runtime rules

Read [docs/terminal-architecture.md](./docs/terminal-architecture.md) and
[docs/architecture/terminal-runtime.md](./docs/architecture/terminal-runtime.md)
before changing PTY, terminal protocol, replay, history, or renderer code.

- Ghostty is the server authority; capable clients restore its opaque snapshot and apply ordered raw PTY bytes.
- PTY data and input stay binary. Never route them through JSON, base64, UTF-8 strings, semantic cell diffs, or React state.
- Sequence values are inclusive PTY byte offsets scoped to an epoch. Attach order is snapshot cut `N`, `SNAPSHOT @ N`, `READY @ N`, then bytes starting at `N + 1`.
- Reject input and resize before `READY`. Any epoch mismatch, byte gap, decode error, or bounded-queue overflow starts resynchronization.
- A slow client, history compression, database IO, or rendering must never block PTY readiness or another client. Keep every queue bounded and make overload explicit.
- Fanout shares one immutable byte allocation and one encoded capable-client frame. A transport-library copy is allowed only at its contiguous-message boundary.
- Layout, viewport, selection, search, tabs, and pane geometry are client/application state, not terminal-runtime state.
- Unix PTYs use shared epoll/kqueue readiness with generation-fenced registrations. Do not add a permanent reader thread or async task per idle PTY.
- Ghostty authority is thread-confined. The remaining one-owner-thread-per-session implementation is a documented migration seam, not a pattern to extend; new ownership work must move toward fixed reactor shards.
- Hot/warm/parked transitions and Ghostty compression run only in the authority owner. Host death remains process-destructive.
- Semantic terminal v3 code is compatibility-only. Do not reconnect it to the production capable-client path.
