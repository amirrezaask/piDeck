import { z } from 'zod';

import { JsonValueSchema } from './json';

export const IdSchema = z.string().uuid();
export type Id = z.infer<typeof IdSchema>;

export const IsoTimestampSchema = z.string().datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

export const ErrorCodeSchema = z.enum([
  'validation_failed',
  'not_authenticated',
  'not_authorized',
  'not_found',
  'version_conflict',
  'idempotency_conflict',
  'idempotency_in_progress',
  'command_outcome_unknown',
  'invalid_state_transition',
  'approval_role_required',
  'approval_already_decided',
  'execution_not_cancellable',
  'run_not_cancellable',
  'agent_not_available',
  'agent_busy',
  'supervisor_unavailable',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    details: JsonValueSchema.optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string().min(1),
  requestId: z.string().min(1),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const RequestIdSchema = z.string().min(1).max(128);

export const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[\x21-\x7e]+$/, 'Idempotency keys must contain visible ASCII characters only');
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
