# piDeck

A local web GUI for running and supervising PI coding agents.

## Workspace

- `apps/web` — React 19, Vite, Tailwind CSS, and shadcn/ui.
- `apps/server` — the thin server process that consumes `@pideck/supervisor`.
- `packages/supervisor` — reusable PI process manager extracted from NextFlow.
- `packages/{agent-runtime,contracts,database,observability,test-agents}` — the supervisor's required NextFlow package graph.

The sidebar lists run sessions; right-click a session to archive it locally. Session routes use `/sessions/<run-id>` and survive refreshes, while `/new` opens a fresh composer. The Settings dialog manages reusable agent profiles, skills available to Pi, installed extensions, projects, and Appearance preferences. Select a skill to browse every file in its directory and preview its Markdown contents. The Extensions page resolves Pi’s global and project extension locations, shows local and package-backed extensions with their versions and scope, checks configured npm/git packages for updates, and can update a package directly. Use the sidebar theme button or Appearance settings to switch between light and dark mode; the choice is persisted in the browser. A profile is a focused instruction block appended to Pi’s maintained default system prompt. Each new session chooses its profile, model, thinking level, and project before starting. Projects are persisted in SQLite, appear in a searchable composer picker, and can be managed from Settings → Projects: add, rename, change their working directory, or remove them without touching files on disk. Agent profile deletion is a soft delete: runs, events, and transcripts remain durable. A new working directory is saved when its session starts. Working-directory paths are normalized server-side; absolute paths and `~/...` paths are supported, and invalid directories are rejected before Pi starts. The UI fetches initial event history over bounded HTTP pages, then resumes authenticated live events over WebSocket with sequence deduplication and reconnect state. Text deltas are coalesced into assistant messages; Markdown content and fenced code blocks are rendered inline, with code highlighted by Shiki. Consecutive lifecycle, tool, and failure events are grouped behind a collapsible activity row. Completed runs stay available for follow-up chat while their supervisor process remains alive. The composer sends bounded PNG, JPEG, GIF, and WebP attachments through Pi’s image input; unsupported files are rejected before submission rather than represented as sent. Image attachments are stored with their run and reloaded into conversation history after browser or Supervisor restarts.

Run admission is protected by a SQLite partial unique index: each agent can have at most one queued or running run across supervisor processes. Create-run, steer, follow-up, and cancel accept an `Idempotency-Key` header (or request field) and persist command receipts. WebSocket URLs never contain the service bearer token. Browsers obtain a short-lived, single-use ticket over authenticated HTTP; standalone deployments require `NEXTFLOW_SUPERVISOR_TOKEN` and should remain loopback-only unless TLS terminates in front of the service. The legacy `/v1/executions` API is disabled by default and is only registered with the explicit `enableLegacyExecutions` option. Approval and pause/resume controls are not claimed by the current backend; they remain future requirements.

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

Call `server.close()` during shutdown. The package owns SQLite migrations, PI sessions, run lifecycle, event persistence, HTTP event history, and bounded WebSocket replay/live delivery. Event payloads default to 256 KiB, depth 16, and 10,000 items; configure stricter limits with the app options. Optional `eventRetentionDays` compacts older events, so enable it only with an explicit transcript-retention policy. Prompts, tool inputs, and output may contain sensitive information and should be protected accordingly.
