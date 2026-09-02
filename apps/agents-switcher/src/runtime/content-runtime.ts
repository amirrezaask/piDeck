import { ManagedRuntime, Layer } from 'effect';

import { RuntimeClient } from '/src/services/runtime-client-service';
import { sendRuntimeRequest } from './runtime-client';

export const ContentRuntime = ManagedRuntime.make(
  Layer.succeed(RuntimeClient, { send: sendRuntimeRequest }),
);
