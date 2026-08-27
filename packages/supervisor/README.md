# @pideck/supervisor

Reusable local PI supervisor package extracted from `~/dev/NextFlow/apps/supervisor`.

## Library usage

```ts
import { buildSupervisorApp } from '@pideck/supervisor';

const { server } = buildSupervisorApp({
  databasePath: './data/pideck.sqlite',
  agentDefaultCwd: process.cwd(),
  allowUnauthenticatedLoopback: true,
});

await server.listen({ host: '127.0.0.1', port: 4101 });
```

Call `server.close()` during shutdown. The package owns its database and PI session lifecycle. `GET /v1/extensions` lists the extension files Pi resolves for the configured working directory, including package versions and update status; `POST /v1/extensions/update` updates all configured packages or a selected package source. Working-directory inputs accept absolute paths and `~/...` paths; they are normalized and validated before a Pi session starts. Saved project records can be created, renamed, moved to another validated working directory, or deleted independently; these operations never remove files from disk. Profile deletion is soft and preserves runs/events. Migrations 010 and 011 add cross-process active-run admission, profile archival, event/run validation triggers, and intervention receipt command types; full rollback removes these tables through the existing migration chain, while an isolated receipt-type rollback intentionally keeps the widened check to avoid destroying receipts.

## Standalone process

```sh
pnpm --filter @pideck/supervisor start
```

Loopback clients do not need a token. Set `NEXTFLOW_SUPERVISOR_TOKEN` before starting when remote clients need access.

The source keeps the existing NextFlow contracts and supporting packages as local workspace dependencies. This makes piDeck self-contained instead of relying on an absolute `file:` link to the NextFlow checkout.
