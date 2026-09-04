import type { SwitcherItem, TabSwitcherItem } from '/src/domain/switcher-item';

import { tokenTextScore } from './fuzzy-score';
import { normalizeSearchText } from './normalize';

export interface RankedItem {
  readonly item: SwitcherItem;
  readonly score: number;
}

const recencyScore = (lastAccessed: number | undefined, now: number): number => {
  if (lastAccessed === undefined) return 0;
  const ageHours = Math.max(0, now - lastAccessed) / 3_600_000;
  return Math.max(0, 76 - Math.log2(ageHours + 1) * 13);
};

const tabUtilityScore = (tab: TabSwitcherItem, now: number): number =>
  recencyScore(tab.lastAccessed, now) +
  (tab.currentWindow ? 34 : 0) +
  (tab.pinned ? 14 : 0) -
  (tab.active ? 20 : 0);

const textualScore = (item: SwitcherItem, tokens: readonly string[]): number | undefined => {
  let total = 0;
  for (const token of tokens) {
    const title = tokenTextScore(token, item.normalizedTitle);
    const host = tokenTextScore(token, item.normalizedHostname);
    const broad = tokenTextScore(token, item.normalizedSearchText);
    const best = Math.max(title ?? -1, host === undefined ? -1 : host + 38, broad ?? -1);
    if (best < 0) return undefined;
    total += best;
  }
  return total;
};

const deterministicCompare = (left: RankedItem, right: RankedItem): number =>
  right.score - left.score ||
  left.item.title.localeCompare(right.item.title) ||
  left.item.id.localeCompare(right.item.id);

export const rankItems = (
  items: readonly SwitcherItem[],
  rawQuery: string,
  now = Date.now(),
  limit = 50,
): readonly RankedItem[] => {
  const normalizedQuery = normalizeSearchText(rawQuery);
  if (normalizedQuery.length === 0)
    return items
      .map((item) => ({ item, score: tabUtilityScore(item, now) }))
      .toSorted(deterministicCompare)
      .slice(0, Math.max(0, limit));

  const tokens = normalizedQuery.split(' ');
  const ranked: RankedItem[] = [];

  for (const item of items) {
    const match = textualScore(item, tokens);
    if (match === undefined) continue;
    ranked.push({ item, score: match + tabUtilityScore(item, now) });
  }

  return ranked.toSorted(deterministicCompare).slice(0, Math.max(0, limit));
};
