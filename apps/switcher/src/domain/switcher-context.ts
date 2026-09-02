import type { TabSnapshot } from '/src/protocol/responses';

import type { ThemePreference } from './theme';

export interface SwitcherContext {
  readonly tabs: readonly TabSnapshot[];
  readonly currentTabId: number | undefined;
  readonly currentWindowId: number | undefined;
  readonly shortcut: string | undefined;
  readonly theme: ThemePreference;
}
