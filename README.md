# piDeck

A local web GUI for running and supervising PI coding agents.

## Workspace

- `apps/web` — React 19, Vite, Tailwind CSS, and shadcn/ui.
- `apps/server` — the thin server process that consumes `@pideck/supervisor`.
- `packages/supervisor` — reusable PI process manager extracted from NextFlow.
- `packages/{agent-runtime,contracts,database,observability,test-agents}` — the supervisor's required NextFlow package graph.

The sidebar lists run sessions, while the Settings dialog manages reusable agent profiles, skills available to Pi, installed extensions, and Appearance preferences. Select a skill to browse every file in its directory and preview its Markdown contents. Use the sidebar theme button or Appearance settings to switch between light and dark mode; the choice is persisted in the browser. Installed extensions show whether they are up to date or have an available update. A profile is a focused instruction block appended to Pi’s maintained default system prompt. Each new session chooses its profile, model, thinking level, and project before starting. Projects are persisted in SQLite, appear in a searchable composer picker, and a new working directory is saved when its session starts. Working-directory paths are normalized server-side; absolute paths and `~/...` paths are supported, and invalid directories are rejected before Pi starts. The UI fetches initial event history over HTTP, then receives authenticated live events over WebSocket. Text deltas are coalesced into assistant messages; Markdown content and fenced code blocks are rendered inline, with code highlighted by Shiki. Consecutive lifecycle, tool, and failure events are grouped behind a collapsible activity row. Completed runs stay available for follow-up chat while their supervisor process remains alive. The conversation composer accepts image and file drops or picker selection, with removable shadcn Attachment previews shown above the composer.

## Setup

```sh
pnpm install
cp .env.example .env
pnpm db:migrate
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

Call `server.close()` during shutdown. The package owns SQLite migrations, PI sessions, run lifecycle, event persistence, HTTP event history, and WebSocket replay/live delivery.
