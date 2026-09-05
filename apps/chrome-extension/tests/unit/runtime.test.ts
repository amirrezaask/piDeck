import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { decodeRequest, decodeResponse } from '/src/protocol/decode';
import { isInjectableUrl } from '/src/runtime/restricted-url';
import { ChromeApiError, TabNotFoundError, errorMessage } from '/src/services/errors';
import { centeredFallbackBounds, isTabInSplitView } from '/src/services/live-layer';

describe('restricted URL detection', () => {
  it.each([
    ['https://example.com', true],
    ['http://localhost:3000', true],
    ['chrome://extensions', false],
    ['devtools://devtools', false],
    ['view-source:https://example.com', false],
    ['https://chromewebstore.google.com/detail/test', false],
    [undefined, false],
  ])('classifies %s', (url, expected) => expect(isInjectableUrl(url)).toBe(expected));
});

describe('split view fallback', () => {
  it('detects Chrome split view tabs while remaining compatible with older Chrome versions', () => {
    expect(isTabInSplitView({ splitViewId: 4 })).toBe(true);
    expect(isTabInSplitView({ splitViewId: -1 })).toBe(false);
    expect(isTabInSplitView({})).toBe(false);
  });

  it('centers the fallback over the invoking browser window', () => {
    expect(centeredFallbackBounds({ left: 100, top: 40, width: 1400, height: 900 })).toEqual({
      left: 340,
      top: 150,
      width: 920,
      height: 680,
    });
  });

  it('fits the fallback inside a smaller invoking window', () => {
    expect(centeredFallbackBounds({ left: 20, top: 30, width: 600, height: 500 })).toEqual({
      left: 20,
      top: 30,
      width: 600,
      height: 500,
    });
  });
});

describe('runtime schemas and error mapping', () => {
  it('accepts valid requests and responses', async () => {
    await expect(
      Effect.runPromise(decodeRequest({ type: 'tab/set-muted', tabId: 3, muted: true })),
    ).resolves.toMatchObject({ tabId: 3 });
    await expect(
      Effect.runPromise(decodeRequest({ type: 'keyboard-shortcut/configure' })),
    ).resolves.toMatchObject({ type: 'keyboard-shortcut/configure' });
    await expect(
      Effect.runPromise(decodeRequest({ type: 'workbench/open', surface: 'terminal' })),
    ).resolves.toMatchObject({ type: 'workbench/open', surface: 'terminal' });
    await expect(
      Effect.runPromise(
        decodeResponse({
          ok: true,
          type: 'snapshot',
          data: { tabs: [], theme: 'system', fallback: false, pageZoom: 1.25 },
        }),
      ),
    ).resolves.toMatchObject({ data: { pageZoom: 1.25 } });
    await expect(
      Effect.runPromise(decodeResponse({ ok: true, type: 'done', closePalette: true })),
    ).resolves.toMatchObject({ closePalette: true });
  });
  it.each([
    { type: 'tab/close', tabId: -1 },
    { type: 'tab/set-pinned', tabId: 1, pinned: 'yes' },
    { type: 'unknown' },
  ])('rejects invalid messages', async (message) => {
    const exit = await Effect.runPromiseExit(decodeRequest(message));
    expect(exit._tag).toBe('Failure');
  });
  it('maps Effect adapter errors to concise messages while preserving context', () => {
    const api = new ChromeApiError({ operation: 'tabs.update.mute', message: 'denied', tabId: 8 });
    expect(api.tabId).toBe(8);
    expect(errorMessage(api)).toBe('Chrome did not allow the tab to be muted.');
    expect(errorMessage(new TabNotFoundError({ tabId: 8 }))).toBe('That tab no longer exists.');
  });
});
