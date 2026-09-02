import { Effect } from 'effect';

import type { SwitcherContext } from '/src/domain/switcher-context';
import type { SwitcherProvider } from '/src/domain/switcher-provider';
import type { SwitcherItem } from '/src/domain/switcher-item';

import { BrowserCommandsProvider } from './browser-commands-provider';
import { OpenTabsProvider } from './open-tabs-provider';

export const providers: readonly SwitcherProvider[] = [OpenTabsProvider, BrowserCommandsProvider];

export const loadProviders = (
  context: SwitcherContext,
): Effect.Effect<readonly SwitcherItem[], never> =>
  Effect.all(
    providers.map((provider) =>
      provider
        .load(context)
        .pipe(Effect.catchAll(() => Effect.succeed<readonly SwitcherItem[]>([]))),
    ),
    { concurrency: 'unbounded' },
  ).pipe(Effect.map((groups) => groups.flat()));
