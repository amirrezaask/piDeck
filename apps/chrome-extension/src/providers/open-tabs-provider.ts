import { Effect } from 'effect';

import type { SwitcherContext } from '/src/domain/switcher-context';
import type { SwitcherProvider } from '/src/domain/switcher-provider';
import type { TabSwitcherItem } from '/src/domain/switcher-item';
import { normalizeSearchText, parseTabUrl } from '/src/search/normalize';

export const makeTabItem = (
  tab: SwitcherContext['tabs'][number],
  context: SwitcherContext,
): TabSwitcherItem => {
  const { hostname, path } = parseTabUrl(tab.url);
  const title = tab.title.trim() || hostname || 'Untitled tab';
  const subtitle = `${hostname}${path}`;
  const searchText = `${title} ${hostname} ${path} ${tab.url}`;
  return {
    id: `tab:${tab.id}`,
    kind: 'tab',
    title,
    subtitle,
    searchText,
    keywords: [hostname, path],
    normalizedTitle: normalizeSearchText(title),
    normalizedHostname: normalizeSearchText(hostname),
    normalizedSearchText: normalizeSearchText(searchText),
    tabId: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    url: tab.url,
    hostname,
    path,
    favIconUrl: tab.favIconUrl,
    active: tab.active,
    pinned: tab.pinned,
    audible: tab.audible,
    muted: tab.muted,
    lastAccessed: tab.lastAccessed,
    currentWindow: tab.windowId === context.currentWindowId,
  };
};

export const OpenTabsProvider: SwitcherProvider = {
  id: 'open-tabs',
  load: (context) => Effect.succeed(context.tabs.map((tab) => makeTabItem(tab, context))),
};
