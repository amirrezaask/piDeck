import { Effect } from 'effect';
import type { RuntimeRequest } from '/src/protocol/messages';
import type { RuntimeResponse } from '/src/protocol/responses';
import {
  ChromeCommands,
  ChromeStorage,
  ChromeTabs,
  type InvocationContext,
  PaletteInjection,
} from '/src/services/chrome-services';
import { errorMessage, type SwitcherError } from '/src/services/errors';

const failure = (error: SwitcherError): RuntimeResponse => ({
  ok: false,
  type: 'palette/error',
  code: error._tag,
  message: errorMessage(error),
});

const invocationFrom = (
  sender: chrome.runtime.MessageSender,
): Effect.Effect<InvocationContext, SwitcherError, ChromeStorage> =>
  Effect.gen(function* () {
    if (sender.tab?.id !== undefined && sender.tab.windowId !== undefined) {
      return { tabId: sender.tab.id, windowId: sender.tab.windowId };
    }
    const storage = yield* ChromeStorage;
    return yield* storage.getInvocation();
  });

export const handleRequest = (
  request: RuntimeRequest,
  sender: chrome.runtime.MessageSender,
): Effect.Effect<
  RuntimeResponse,
  never,
  ChromeTabs | ChromeStorage | ChromeCommands | PaletteInjection
> =>
  Effect.gen(function* () {
    const tabs = yield* ChromeTabs;
    const storage = yield* ChromeStorage;
    const commands = yield* ChromeCommands;
    const injection = yield* PaletteInjection;

    if (request.type === 'test/invoke' || request.type === 'palette/toggle') {
      yield* injection.openActive();
      return { ok: true as const, type: 'done' as const, closePalette: false };
    }
    const context = yield* invocationFrom(sender);
    if (request.type === 'palette/bootstrap' || request.type === 'palette/refresh') {
      const fallback = sender.tab === undefined || sender.url?.includes('/switcher.html') === true;
      return yield* tabs.snapshot(context, fallback);
    }
    if (request.type === 'keyboard-shortcut/get') {
      const shortcut = yield* commands.getShortcut();
      return {
        ok: true as const,
        type: 'shortcut' as const,
        ...(shortcut === undefined ? {} : { shortcut }),
      };
    }
    if (request.type === 'theme/set') {
      yield* storage.setTheme(request.theme);
      return { ok: true as const, type: 'done' as const, closePalette: false };
    }
    if (request.type === 'tab/activate')
      return yield* tabs.activate(request.tabId, request.windowId);
    if (request.type === 'tab/close') return yield* tabs.close(request.tabId);
    if (request.type === 'tab/set-pinned')
      return yield* tabs.setPinned(request.tabId, request.pinned);
    return yield* tabs.setMuted(request.tabId, request.muted);
  }).pipe(Effect.catchAll((error) => Effect.succeed(failure(error))));
