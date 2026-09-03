import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { decodeRequest, decodeResponse } from '/src/protocol/decode';
import { isInjectableUrl } from '/src/runtime/restricted-url';
import { ChromeApiError, TabNotFoundError, errorMessage } from '/src/services/errors';

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

describe('runtime schemas and error mapping', () => {
  it('accepts valid requests and responses', async () => {
    await expect(
      Effect.runPromise(decodeRequest({ type: 'tab/set-muted', tabId: 3, muted: true })),
    ).resolves.toMatchObject({ tabId: 3 });
    await expect(
      Effect.runPromise(decodeRequest({ type: 'keyboard-shortcut/configure' })),
    ).resolves.toMatchObject({ type: 'keyboard-shortcut/configure' });
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
