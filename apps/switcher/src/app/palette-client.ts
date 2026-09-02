import { Effect, type ManagedRuntime } from 'effect';

import type { SwitcherContext } from '/src/domain/switcher-context';
import type { SwitcherItem } from '/src/domain/switcher-item';
import { loadProviders } from '/src/providers/provider-registry';
import type { RuntimeRequest } from '/src/protocol/messages';
import type { BootstrapSnapshot, RuntimeResponse } from '/src/protocol/responses';
import { RuntimeClient } from '/src/services/runtime-client-service';

export interface PaletteClient {
  readonly bootstrap: () => Promise<BootstrapSnapshot>;
  readonly refresh: () => Promise<BootstrapSnapshot>;
  readonly send: (request: RuntimeRequest) => Promise<RuntimeResponse>;
  readonly loadItems: (snapshot: BootstrapSnapshot) => Promise<readonly SwitcherItem[]>;
}

const snapshotFrom = (response: RuntimeResponse): BootstrapSnapshot => {
  if (response.ok && response.type === 'snapshot') return response.data;
  if (!response.ok) throw new Error(response.message);
  throw new Error('Switcher received an unexpected response.');
};

export const createPaletteClient = (
  runtime: ManagedRuntime.ManagedRuntime<RuntimeClient, never>,
): PaletteClient => {
  const request = (message: RuntimeRequest): Promise<RuntimeResponse> =>
    runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RuntimeClient;
        return yield* client.send(message);
      }),
    );
  return {
    bootstrap: () => request({ type: 'palette/bootstrap' }).then(snapshotFrom),
    refresh: () => request({ type: 'palette/refresh' }).then(snapshotFrom),
    send: request,
    loadItems: (snapshot) => {
      const context: SwitcherContext = {
        tabs: snapshot.tabs,
        currentTabId: snapshot.currentTabId,
        currentWindowId: snapshot.currentWindowId,
        shortcut: snapshot.shortcut,
        theme: snapshot.theme,
      };
      return runtime.runPromise(loadProviders(context));
    },
  };
};
