import type { Effect } from 'effect';

import type { SwitcherContext } from './switcher-context';
import type { SwitcherItem } from './switcher-item';

export interface SwitcherProviderError {
  readonly _tag: 'SwitcherProviderError';
  readonly providerId: string;
  readonly message: string;
}

export interface SwitcherProvider<Dependencies = never> {
  readonly id: string;
  readonly load: (
    context: SwitcherContext,
  ) => Effect.Effect<readonly SwitcherItem[], SwitcherProviderError, Dependencies>;
}
