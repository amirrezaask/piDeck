import { Effect } from 'effect';
import { browser } from 'wxt/browser';

import type { RuntimeRequest } from '/src/protocol/messages';
import { decodeResponse } from '/src/protocol/decode';
import type { RuntimeResponse } from '/src/protocol/responses';

export const sendRuntimeRequest = (
  request: RuntimeRequest,
): Effect.Effect<RuntimeResponse, Error> =>
  Effect.tryPromise({
    try: () => browser.runtime.sendMessage(request),
    catch: (cause) => new Error(cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.flatMap(decodeResponse),
    Effect.mapError((error) => new Error(error.message)),
  );
