import { Context, type Effect } from 'effect';

import type { RuntimeRequest } from '/src/protocol/messages';
import type { RuntimeResponse } from '/src/protocol/responses';

export interface RuntimeClientShape {
  readonly send: (request: RuntimeRequest) => Effect.Effect<RuntimeResponse, Error>;
}

export class RuntimeClient extends Context.Tag('Switcher/RuntimeClient')<
  RuntimeClient,
  RuntimeClientShape
>() {}
