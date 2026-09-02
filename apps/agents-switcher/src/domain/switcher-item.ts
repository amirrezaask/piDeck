import type { BrowserCommand } from './browser-command';

export interface BaseSwitcherItem {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly subtitle: string | undefined;
  readonly searchText: string;
  readonly keywords: readonly string[];
  readonly normalizedTitle: string;
  readonly normalizedHostname: string;
  readonly normalizedSearchText: string;
}

export interface TabSwitcherItem extends BaseSwitcherItem {
  readonly kind: 'tab';
  readonly tabId: number;
  readonly windowId: number;
  readonly index: number;
  readonly url: string;
  readonly hostname: string;
  readonly path: string;
  readonly favIconUrl: string | undefined;
  readonly active: boolean;
  readonly pinned: boolean;
  readonly audible: boolean;
  readonly muted: boolean;
  readonly lastAccessed: number | undefined;
  readonly currentWindow: boolean;
}

export interface BrowserCommandSwitcherItem extends BaseSwitcherItem {
  readonly kind: 'browser-command';
  readonly command: BrowserCommand;
  readonly danger: boolean;
  readonly priority: number;
}

export type SwitcherItem = TabSwitcherItem | BrowserCommandSwitcherItem;
