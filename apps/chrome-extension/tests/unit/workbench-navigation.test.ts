import { describe, expect, it } from 'vitest';

import {
  isWorkbenchUrl,
  planSurfacePlacement,
  surfaceUrl,
} from '/src/runtime/workbench-navigation';

describe('workbench navigation', () => {
  it('opens each product as a browser-level surface', () => {
    expect(surfaceUrl('terminal')).toBe('http://ide.local:7774/terminals');
    expect(surfaceUrl('agent')).toBe('http://ide.local:7774/agents/new');
  });

  it('recognizes only the configured local workbench origin', () => {
    expect(isWorkbenchUrl('http://ide.local:7774/terminals')).toBe(true);
    expect(isWorkbenchUrl('http://ide.local.attacker.test:7774/terminals')).toBe(false);
    expect(isWorkbenchUrl(undefined)).toBe(false);
  });

  it('replaces the companion tab when Chrome already has a native split', () => {
    expect(
      planSurfacePlacement({ id: 10, windowId: 2, index: 3, splitViewId: 7 }, [
        { id: 10, windowId: 2, index: 3, splitViewId: 7 },
        { id: 11, windowId: 2, index: 4, splitViewId: 7 },
      ]),
    ).toEqual({ kind: 'replace', tabId: 11 });
  });

  it('reuses the active workbench pane instead of replacing its browser companion', () => {
    expect(
      planSurfacePlacement(
        {
          id: 11,
          windowId: 2,
          index: 4,
          splitViewId: 7,
          url: 'http://ide.local:7774/terminals',
        },
        [
          { id: 10, windowId: 2, index: 3, splitViewId: 7, url: 'https://example.com' },
          {
            id: 11,
            windowId: 2,
            index: 4,
            splitViewId: 7,
            url: 'http://ide.local:7774/terminals',
          },
        ],
      ),
    ).toEqual({ kind: 'replace', tabId: 11 });
  });

  it('creates an adjacent tab when the active tab is not split', () => {
    expect(planSurfacePlacement({ id: 10, windowId: 2, index: 3 }, [])).toEqual({
      kind: 'create',
      windowId: 2,
      index: 4,
      openerTabId: 10,
    });
  });

  it('does not plan a placement for a tab without an id', () => {
    expect(planSurfacePlacement({ windowId: 2, index: 3 }, [])).toBeUndefined();
  });
});
