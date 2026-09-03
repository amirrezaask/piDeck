import { describe, expect, it } from 'vitest';

import type { TabSwitcherItem } from '/src/domain/switcher-item';
import { makeTabItem } from '/src/providers/open-tabs-provider';
import { normalizeSearchText, parseTabUrl } from '/src/search/normalize';
import { orderedFuzzyScore, tokenTextScore } from '/src/search/fuzzy-score';
import { rankItems } from '/src/search/rank-items';

const now = 1_700_000_000_000;
const context = {
  tabs: [],
  currentTabId: 1,
  currentWindowId: 1,
  shortcut: 'Ctrl+Shift+K',
  theme: 'system' as const,
};
const tab = (
  id: number,
  title: string,
  url: string,
  overrides: Partial<Parameters<typeof makeTabItem>[0]> = {},
): TabSwitcherItem =>
  makeTabItem(
    {
      id,
      windowId: 1,
      index: id,
      title,
      url,
      active: false,
      pinned: false,
      audible: false,
      muted: false,
      ...overrides,
    },
    context,
  );

describe('search normalization and parsing', () => {
  it('normalizes unicode, separators, and whitespace', () => {
    expect(normalizeSearchText('  Café.GitHub///Pull_Request  ')).toBe('cafe github pull request');
  });
  it('parses normal and malformed URLs safely', () => {
    expect(parseTabUrl('https://grafana.example.com/d/team?view=1')).toEqual({
      hostname: 'grafana.example.com',
      path: '/d/team?view=1',
    });
    expect(parseTabUrl('not a url/path')).toEqual({ hostname: 'not a url', path: '/path' });
  });
});

describe('fuzzy scoring and ranking', () => {
  it('covers exact, prefix, boundary, substring, and ordered fuzzy matches', () => {
    expect(tokenTextScore('dispatch', 'dispatch')).toBeGreaterThan(
      tokenTextScore('disp', 'dispatch') ?? 0,
    );
    expect(tokenTextScore('disp', 'dispatch')).toBeGreaterThan(
      tokenTextScore('patch', 'dispatch status') ?? 0,
    );
    expect(tokenTextScore('status', 'dispatch status')).toBeGreaterThan(
      tokenTextScore('pat', 'dispatch status') ?? 0,
    );
    expect(orderedFuzzyScore('dsp', 'dispatch')).toBeDefined();
    expect(orderedFuzzyScore('xyz', 'dispatch')).toBeUndefined();
  });
  it('ranks Dispatch and supports multiple tokens across title and host', () => {
    const dispatch = tab(1, 'Dispatch', 'https://github.com/acme/dispatch');
    const display = tab(2, 'Display settings', 'https://example.com');
    expect(rankItems([display, dispatch], 'disp', now)[0]?.item.id).toBe(dispatch.id);
    expect(rankItems([display, dispatch], 'git disp', now)[0]?.item.id).toBe(dispatch.id);
  });
  it('weights exact hostname above an incidental title substring', () => {
    const host = tab(1, 'Observability', 'https://grafana/team');
    const title = tab(2, 'Grafana notes from last week', 'https://notes.example.com');
    expect(rankItems([title, host], 'grafana', now)[0]?.item.id).toBe(host.id);
  });
  it('combines recency, current-window affinity, and pinned weighting without overpowering text', () => {
    const recent = tab(1, 'Grafana dashboards', 'https://metrics.example.com', {
      lastAccessed: now - 60_000,
    });
    const stale = tab(2, 'Graf overview', 'https://old.example.com', {
      windowId: 2,
      lastAccessed: now - 100 * 3_600_000,
    });
    expect(rankItems([stale, recent], 'graf', now)[0]?.item.id).toBe(recent.id);

    const currentWeak = tab(3, 'Repository index', 'https://example.com', { windowId: 1 });
    const otherStrong = tab(4, 'Dispatch', 'https://github.com/dispatch', { windowId: 2 });
    expect(rankItems([currentWeak, otherStrong], 'disp', now)[0]?.item.id).toBe(otherStrong.id);

    const pinned = tab(5, 'Same', 'https://a.example.com', {
      pinned: true,
      lastAccessed: now - 10_000,
    });
    const plain = tab(6, 'Same', 'https://b.example.com', { lastAccessed: now - 10_000 });
    expect(rankItems([plain, pinned], 'same', now)[0]?.item.id).toBe(pinned.id);
  });
  it('returns nothing for an empty query and keeps result ordering stable and bounded', () => {
    const recent = tab(2, 'Zulu', 'https://z.example.com', { lastAccessed: now });
    const stale = tab(1, 'Alpha', 'https://a.example.com', { lastAccessed: now - 300 * 3_600_000 });
    expect(rankItems([stale, recent], '', now)).toEqual([]);
    expect(
      rankItems(
        [tab(2, 'Same', 'https://b.test'), tab(1, 'Same', 'https://a.test')],
        'same',
        now,
      ).map(({ item }) => item.id),
    ).toEqual(['tab:1', 'tab:2']);
    const many = Array.from({ length: 80 }, (_, index) =>
      tab(index + 1, `Tab ${index}`, `https://example.com/${index}`),
    );
    expect(rankItems(many, 'tab', now)).toHaveLength(50);
  });
  it('scores 500 tabs within an ordinary interaction frame budget', () => {
    const many = Array.from({ length: 500 }, (_, index) =>
      tab(
        index + 1,
        `Service dashboard ${index}`,
        `https://service-${index}.example.com/path/${index}`,
        { lastAccessed: now - index * 10_000 },
      ),
    );
    const started = performance.now();
    const results = rankItems(many, 'service 42', now);
    expect(results[0]?.item.title).toContain('42');
    expect(performance.now() - started).toBeLessThan(25);
  });
});
