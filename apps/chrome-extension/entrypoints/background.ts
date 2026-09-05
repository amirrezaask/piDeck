import { Effect, ManagedRuntime } from 'effect';
import { browser } from 'wxt/browser';

import { decodeRequest } from '/src/protocol/decode';
import type { RuntimeResponse } from '/src/protocol/responses';
import { handleRequest } from '/src/runtime/background-runtime';
import {
  ChromeCommands,
  PaletteInjection,
  WorkbenchNavigation,
} from '/src/services/chrome-services';
import type { WorkbenchSurface } from '/src/runtime/workbench-navigation';
import { makeLiveLayer } from '/src/services/live-layer';

const invalidResponse: RuntimeResponse = {
  ok: false,
  type: 'palette/error',
  code: 'InvalidMessageError',
  message: 'Switcher received an invalid request.',
};

export default defineBackground({
  type: 'module',
  main() {
    const runtime = ManagedRuntime.make(makeLiveLayer());
    const invoke = (): Promise<void> =>
      runtime.runPromise(
        Effect.gen(function* () {
          const injection = yield* PaletteInjection;
          yield* injection.openActive();
        }).pipe(Effect.catchAll(() => Effect.void)),
      );
    const openSurface = (surface: WorkbenchSurface): Promise<void> =>
      runtime.runPromise(
        Effect.gen(function* () {
          const workbench = yield* WorkbenchNavigation;
          yield* workbench.openSurface(surface);
        }).pipe(Effect.catchAll(() => Effect.void)),
      );

    browser.runtime.onMessage.addListener((input: unknown, sender) =>
      runtime.runPromise(
        decodeRequest(input).pipe(
          Effect.flatMap((request) => handleRequest(request, sender)),
          Effect.catchAll(() => Effect.succeed(invalidResponse)),
        ),
      ),
    );
    browser.action.onClicked.addListener(() => {
      void invoke();
    });
    browser.commands.onCommand.addListener((command) => {
      if (command === 'toggle-switcher') void invoke();
      else if (command === 'open-terminal') void openSurface('terminal');
      else if (command === 'open-agent') void openSurface('agent');
    });
    browser.runtime.onInstalled.addListener(() => {
      void runtime.runPromise(
        Effect.gen(function* () {
          const commands = yield* ChromeCommands;
          yield* commands.updateBadge();
        }).pipe(Effect.catchAll(() => Effect.void)),
      );
    });
  },
});
