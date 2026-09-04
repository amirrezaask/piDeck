import { Effect, Layer } from 'effect';
import { browser } from 'wxt/browser';

import type { ThemePreference } from '/src/domain/theme';
import type { TabSnapshot } from '/src/protocol/responses';
import { isInjectableUrl } from '/src/runtime/restricted-url';
import {
  ChromeApiError,
  TabNotFoundError,
  type SwitcherError,
  UnsupportedPageError,
} from './errors';
import {
  ChromeCommands,
  ChromeStorage,
  ChromeTabs,
  type InvocationContext,
  PaletteInjection,
} from './chrome-services';

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
const apiError = (
  operation: string,
  cause: unknown,
  ids: { readonly tabId?: number; readonly windowId?: number } = {},
): ChromeApiError => new ChromeApiError({ operation, message: errorText(cause), ...ids });

const fromPromise = <A>(
  operation: string,
  task: () => Promise<A>,
  ids?: { readonly tabId?: number; readonly windowId?: number },
): Effect.Effect<A, ChromeApiError> =>
  Effect.tryPromise({ try: task, catch: (cause) => apiError(operation, cause, ids) });

const toSnapshot = (tab: chrome.tabs.Tab): TabSnapshot | undefined => {
  if (tab.id === undefined || tab.windowId === undefined) return undefined;
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title ?? '',
    url: tab.url ?? '',
    ...(tab.favIconUrl === undefined ? {} : { favIconUrl: tab.favIconUrl }),
    active: tab.active,
    pinned: tab.pinned,
    audible: tab.audible ?? false,
    muted: tab.mutedInfo?.muted ?? false,
    ...(tab.lastAccessed === undefined ? {} : { lastAccessed: tab.lastAccessed }),
  };
};

const getTab = (tabId: number): Effect.Effect<chrome.tabs.Tab, SwitcherError> =>
  fromPromise('tabs.get', () => browser.tabs.get(tabId), { tabId }).pipe(
    Effect.catchAll(() => Effect.fail(new TabNotFoundError({ tabId }))),
  );

export const isTabInSplitView = (tab: object): boolean => {
  if (!('splitViewId' in tab)) return false;
  return typeof tab.splitViewId === 'number' && tab.splitViewId !== -1;
};

const FALLBACK_WIDTH = 920;
const FALLBACK_HEIGHT = 680;

interface WindowBounds {
  readonly left?: number;
  readonly top?: number;
  readonly width?: number;
  readonly height?: number;
}

export const centeredFallbackBounds = (
  source: WindowBounds | undefined,
): {
  readonly left?: number;
  readonly top?: number;
  readonly width: number;
  readonly height: number;
} => {
  const sourceWidth = source?.width;
  const sourceHeight = source?.height;
  const width = sourceWidth === undefined ? FALLBACK_WIDTH : Math.min(FALLBACK_WIDTH, sourceWidth);
  const height =
    sourceHeight === undefined ? FALLBACK_HEIGHT : Math.min(FALLBACK_HEIGHT, sourceHeight);

  return {
    ...(source?.left === undefined || sourceWidth === undefined
      ? {}
      : { left: source.left + Math.floor((sourceWidth - width) / 2) }),
    ...(source?.top === undefined || sourceHeight === undefined
      ? {}
      : { top: source.top + Math.floor((sourceHeight - height) / 2) }),
    width,
    height,
  };
};

const makeStorage = () => ({
  getTheme: (): Effect.Effect<ThemePreference, ChromeApiError> =>
    fromPromise('storage.local.get', () => browser.storage.local.get('theme')).pipe(
      Effect.map((stored): ThemePreference =>
        stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : 'system',
      ),
    ),
  setTheme: (theme: ThemePreference) =>
    fromPromise('storage.local.set', () => browser.storage.local.set({ theme })),
  getInvocation: () =>
    fromPromise('storage.local.get', () => browser.storage.local.get('lastInvocation')).pipe(
      Effect.map((stored): InvocationContext => {
        const value = stored.lastInvocation;
        if (typeof value !== 'object' || value === null)
          return { tabId: undefined, windowId: undefined };
        const record = Object.fromEntries(Object.entries(value));
        return {
          tabId: typeof record.tabId === 'number' ? record.tabId : undefined,
          windowId: typeof record.windowId === 'number' ? record.windowId : undefined,
        };
      }),
    ),
  setInvocation: (context: InvocationContext) =>
    fromPromise('storage.local.set', () => browser.storage.local.set({ lastInvocation: context })),
});

const commandShortcut = (): Effect.Effect<string | undefined, ChromeApiError> =>
  fromPromise('commands.getAll', () => browser.commands.getAll()).pipe(
    Effect.map(
      (commands) =>
        commands.find((command) => command.name === 'toggle-switcher')?.shortcut || undefined,
    ),
  );

const makeCommands = () => ({
  getShortcut: commandShortcut,
  openShortcutSettings: () =>
    fromPromise('tabs.create.shortcut-settings', () =>
      browser.tabs.create({ url: 'chrome://extensions/shortcuts' }),
    ).pipe(Effect.asVoid),
  updateBadge: () =>
    commandShortcut().pipe(
      Effect.flatMap((shortcut) =>
        fromPromise('action.setBadgeText', () =>
          browser.action.setBadgeText({ text: shortcut === undefined ? '!' : '' }),
        ),
      ),
      Effect.tap(() =>
        fromPromise('action.setBadgeBackgroundColor', () =>
          browser.action.setBadgeBackgroundColor({ color: '#D97706' }),
        ),
      ),
    ),
});

const makeTabs = (
  storage: ReturnType<typeof makeStorage>,
  commands: ReturnType<typeof makeCommands>,
) => {
  const snapshot = (context: InvocationContext, fallback: boolean) => {
    const tabId = context.tabId;
    const pageZoom =
      fallback || tabId === undefined
        ? Effect.succeed(1)
        : fromPromise('tabs.getZoom', () => browser.tabs.getZoom(tabId), { tabId }).pipe(
            Effect.catchAll(() => Effect.succeed(1)),
          );

    return Effect.all(
      [
        fromPromise('tabs.query', () => browser.tabs.query({ windowType: 'normal' })),
        commands.getShortcut(),
        storage.getTheme(),
        pageZoom,
      ],
      { concurrency: 'unbounded' },
    ).pipe(
      Effect.map(([tabs, shortcut, theme, zoom]) => ({
        ok: true as const,
        type: 'snapshot' as const,
        data: {
          tabs: tabs.flatMap((tab) => {
            const value = toSnapshot(tab);
            return value === undefined ? [] : [value];
          }),
          ...(context.tabId === undefined ? {} : { currentTabId: context.tabId }),
          ...(context.windowId === undefined ? {} : { currentWindowId: context.windowId }),
          ...(shortcut === undefined ? {} : { shortcut }),
          theme,
          fallback,
          pageZoom: zoom,
        },
      })),
    );
  };

  const updateTab = (tabId: number, change: chrome.tabs.UpdateProperties, operation: string) =>
    fromPromise(operation, () => browser.tabs.update(tabId, change), { tabId }).pipe(
      Effect.flatMap((tab) => {
        const value = tab === undefined ? undefined : toSnapshot(tab);
        return value === undefined
          ? Effect.fail(new TabNotFoundError({ tabId }))
          : Effect.succeed({ ok: true as const, type: 'tab' as const, data: value });
      }),
    );

  return {
    snapshot,
    activate: (tabId: number, windowId: number) =>
      Effect.gen(function* () {
        yield* getTab(tabId);
        yield* fromPromise(
          'windows.update',
          () => browser.windows.update(windowId, { focused: true }),
          { windowId },
        );
        yield* fromPromise(
          'tabs.update.active',
          () => browser.tabs.update(tabId, { active: true }),
          { tabId },
        );
        return { ok: true as const, type: 'done' as const, closePalette: true };
      }),
    close: (tabId: number) =>
      getTab(tabId).pipe(
        Effect.flatMap(() =>
          fromPromise('tabs.remove', () => browser.tabs.remove(tabId), { tabId }),
        ),
        Effect.as({ ok: true as const, type: 'done' as const, closePalette: false }),
      ),
    setPinned: (tabId: number, pinned: boolean) => updateTab(tabId, { pinned }, 'tabs.update.pin'),
    setMuted: (tabId: number, muted: boolean) => updateTab(tabId, { muted }, 'tabs.update.mute'),
  };
};

const openFallback = (context: InvocationContext): Effect.Effect<void, ChromeApiError> => {
  const url = browser.runtime.getURL('/switcher.html');
  const sourceWindowId = context.windowId;
  const sourceWindow =
    sourceWindowId === undefined
      ? Effect.succeed(undefined)
      : fromPromise('windows.get.invocation', () => browser.windows.get(sourceWindowId), {
          windowId: sourceWindowId,
        }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

  return Effect.all(
    [fromPromise('tabs.query.fallback', () => browser.tabs.query({ url })), sourceWindow],
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.flatMap(([tabs, source]) => {
      const existing = tabs[0];
      const bounds = centeredFallbackBounds(source);
      if (existing?.windowId !== undefined)
        return fromPromise('windows.update.fallback', () =>
          browser.windows.update(existing.windowId, { focused: true, ...bounds }),
        ).pipe(Effect.asVoid);
      return fromPromise('windows.create.fallback', () =>
        browser.windows.create({ url, type: 'popup', focused: true, ...bounds }),
      ).pipe(Effect.asVoid);
    }),
    Effect.tap(() => makeStorage().setInvocation(context)),
  );
};

const openPalette = (
  tabId: number,
  windowId: number,
  url: string | undefined,
  inSplitView = false,
): Effect.Effect<void, SwitcherError> => {
  const context = { tabId, windowId };
  if (inSplitView || !isInjectableUrl(url)) return openFallback(context);
  return fromPromise(
    'tabs.sendMessage.toggle',
    () => browser.tabs.sendMessage(tabId, { type: 'palette/toggle' }),
    { tabId },
  ).pipe(
    Effect.catchAll(() =>
      fromPromise(
        'scripting.executeScript',
        () =>
          browser.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            files: ['/content-scripts/overlay.js'],
          }),
        { tabId },
      ).pipe(Effect.asVoid),
    ),
    Effect.catchAll(() => openFallback(context)),
    Effect.tap(() => makeStorage().setInvocation(context)),
  );
};

const makeInjection = () => ({
  open: openPalette,
  openActive: () =>
    fromPromise('tabs.query.active', () =>
      browser.tabs.query({ active: true, lastFocusedWindow: true }),
    ).pipe(
      Effect.flatMap((tabs) => {
        const tab = tabs[0];
        if (tab?.id === undefined || tab.windowId === undefined)
          return Effect.fail(new TabNotFoundError({ tabId: -1 }));
        return openPalette(tab.id, tab.windowId, tab.url, isTabInSplitView(tab));
      }),
    ),
});

export const makeLiveLayer = () => {
  const storage = makeStorage();
  const commands = makeCommands();
  return Layer.mergeAll(
    Layer.succeed(ChromeStorage, storage),
    Layer.succeed(ChromeCommands, commands),
    Layer.succeed(ChromeTabs, makeTabs(storage, commands)),
    Layer.succeed(PaletteInjection, makeInjection()),
  );
};

export const unsupported = (url: string): UnsupportedPageError => new UnsupportedPageError({ url });
