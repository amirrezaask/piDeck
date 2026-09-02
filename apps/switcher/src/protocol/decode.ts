import { Effect, Schema } from 'effect';

import { RuntimeRequestSchema, type RuntimeRequest } from './messages';
import { RuntimeResponseSchema, type RuntimeResponse } from './responses';

export class InvalidMessageError {
  readonly _tag = 'InvalidMessageError';
  constructor(readonly message: string) {}
}

export const decodeRequest = (input: unknown): Effect.Effect<RuntimeRequest, InvalidMessageError> =>
  Schema.decodeUnknown(RuntimeRequestSchema)(input).pipe(
    Effect.mapError((error) => new InvalidMessageError(error.message)),
  );

export const decodeResponse = (
  input: unknown,
): Effect.Effect<RuntimeResponse, InvalidMessageError> =>
  Schema.decodeUnknown(RuntimeResponseSchema)(input).pipe(
    Effect.mapError((error) => new InvalidMessageError(error.message)),
  );
