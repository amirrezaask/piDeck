# piDeck

A monorepo for terminal sessions, coding agents, and task tracking. One Rust process owns all server-side state in one SQLite database.

## Server routes

| Product | HTTP | WebSocket |
| --- | --- | --- |
| Terminal | `/terminal/health`, `/terminal/api/v1/*` | `/terminal/ws` |
| Tasks | `/tasks/health`, `/tasks/api/*` | none |
| Agents | `/agents/v1/*` | `/agents/v1/agents/:id/stream`, `/agents/v1/runs/:id/stream` |

The host token protects all non-health APIs when you configure one. Terminal device pairing and scoped credentials remain available under `/terminal/api/v1/security/*`.

The database defaults to `<data-dir>/yaade.sqlite3`. Terminal tables keep their existing names. Task tables use the `task_` prefix; agent tables use the `agent_` prefix.

## Applications

```text
apps/server           Rust host: SQLite, PTY, terminal, tasks, and Pi RPC
apps/web              terminal web client
apps/desktop          Tauri terminal desktop client
apps/agents-web       piDeck agent client
apps/agents-desktop   Electron shell for the agent client
apps/agents-switcher  piDeck browser extension
apps/tasks-web        Dispatch task client
```

`packages/ghostty-core` and `packages/ghostty-react` provide the Ghostty VT terminal stack. The repository does not include the GPUI desktop experiment.

## Requirements

- Node.js 24 or newer
- pnpm 9.15
- Rust stable
- TypeScript 7
- Pi on `PATH` for agent runs

Install dependencies:

```sh
pnpm install
```

## Development

Start the Rust server and the three browser clients:

```sh
pnpm dev
```

Or run them separately:

```sh
pnpm dev:server    # Rust server on http://127.0.0.1:7774
pnpm dev:terminal  # terminal client on http://127.0.0.1:5174
pnpm dev:agents    # agent client on http://127.0.0.1:5173
pnpm dev:tasks     # task client on http://127.0.0.1:5175
```

The clients proxy their namespaced routes to the Rust server. Set `YAADE_PORT`, `VITE_SUPERVISOR_URL`, or `VITE_API_URL` when the server uses another origin.

The server accepts the Mergence host options:

```sh
cargo run --manifest-path apps/server/Cargo.toml -- \
  serve --host 127.0.0.1 --port 7774 --data-dir ./data
```

Set `PI_EXECUTABLE` to use a Pi binary outside `PATH`. Agent runs launch Pi in JSONL RPC mode and persist the run, event, attachment, and inbox records in SQLite.

## Checks

```sh
pnpm typecheck
pnpm test
pnpm build:clients
pnpm lint:server
```

Useful focused commands:

```sh
pnpm test:server
pnpm test:web
pnpm test:agents
pnpm test:tasks
pnpm test:web:e2e
pnpm test:agents:e2e
pnpm test:tasks:e2e
```

`pnpm test:web` includes Ghostty core, Ghostty React, host-client, RPC, workspace, and terminal UI tests. `pnpm test:server` runs terminal parity tests plus the Rust task and agent API suites.

## Desktop clients

Build the Tauri terminal desktop client:

```sh
pnpm build:desktop
```

Run the Electron agent client against the Rust server:

```sh
pnpm dev:server
pnpm dev:agents-desktop
```

The Electron shell uses `http://127.0.0.1:7774` by default. Set `PIDECK_SERVER_URL` to select another unified server. It stores remote credentials through Electron `safeStorage` and only forwards `/agents/v1/*` requests.

## Release build

```sh
pnpm build:release
```

The release script compiles the Rust host and embeds the terminal web assets. Agent and task clients build with `pnpm build:agents` and `pnpm build:tasks`; package their desktop or web distributions according to the target deployment.

Treat the SQLite database and Pi session directory as sensitive data. They may contain terminal output, prompts, model responses, tool input, attachments, and source paths. See [docs/backup-and-recovery.md](docs/backup-and-recovery.md) before copying or restoring a live database.
