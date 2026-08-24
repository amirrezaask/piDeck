# @pideck/supervisor

Reusable local PI supervisor package extracted from `~/dev/NextFlow/apps/supervisor`.

## Library usage

```ts
import { buildSupervisorApp } from '@pideck/supervisor';

const { server } = buildSupervisorApp({
  databasePath: './data/pideck.sqlite',
  agentDefaultCwd: process.cwd(),
});

await server.listen({ host: '127.0.0.1', port: 4101 });
```

Call `server.close()` during shutdown. The package owns its database and PI session lifecycle. Working-directory inputs accept absolute paths and `~/...` paths; they are normalized and validated before a Pi session starts.

## Standalone process

```sh
NEXTFLOW_SUPERVISOR_TOKEN=local-token pnpm --filter @pideck/supervisor dev
```

The source keeps the existing NextFlow contracts and supporting packages as local workspace dependencies. This makes piDeck self-contained instead of relying on an absolute `file:` link to the NextFlow checkout.
