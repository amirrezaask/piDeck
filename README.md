# piDeck

A local web GUI for running and supervising PI coding agents.

## Workspace

- `apps/web` — React 19, Vite, Tailwind CSS, and shadcn/ui.
- `apps/server` — the thin server process that consumes `@pideck/supervisor`.
- `packages/supervisor` — reusable PI process manager extracted from NextFlow.
- `packages/{agent-runtime,contracts,database,observability,test-agents}` — the supervisor's required NextFlow package graph.

The sidebar lists run sessions, while the Settings dialog manages reusable agent profiles. A profile is a focused instruction block appended to Pi’s maintained default system prompt. Each new session chooses its profile, model, thinking level, and working directory before starting. The UI consumes the authenticated SSE event stream and maps PI events into shadcn `MessageScroller`, `Message`, `Bubble`, and `Marker` primitives. Text deltas are coalesced into assistant messages; lifecycle, tool, and failure events remain visible as markers.

## Setup

```sh
pnpm install
cp .env.example .env
```

Node 22.19 or newer is required.

## Development

Run the web UI and supervisor together:

```sh
pnpm dev
```

Or run them separately:

```sh
pnpm dev:supervisor
pnpm dev:web
```

- Web UI: `http://127.0.0.1:5173`
- Supervisor: `http://127.0.0.1:4101`
- Health: `GET /v1/health`

Vite proxies `/supervisor/*` to the local server and adds the service credential server-side, so the browser does not store the bearer token.

## Verification

```sh
pnpm build
pnpm typecheck
pnpm test             # 40+ unit/integration tests across the workspace
pnpm test:coverage    # enforced coverage thresholds for client/event mapping
pnpm test:e2e         # desktop and mobile Chromium flows
pnpm lint
pnpm format:check
```

The Playwright config uses the locally installed Google Chrome channel. In CI, install Chrome or change the project channel to a bundled Playwright browser.

## Supervisor package

```ts
import { buildSupervisorApp } from '@pideck/supervisor';

const { server } = buildSupervisorApp({
  databasePath: './data/pideck.sqlite',
  agentDefaultCwd: process.cwd(),
  serviceToken: process.env.NEXTFLOW_SUPERVISOR_TOKEN,
});

await server.listen({ host: '127.0.0.1', port: 4101 });
```

Call `server.close()` during shutdown. The package owns SQLite migrations, PI sessions, run lifecycle, event persistence, and SSE replay.
