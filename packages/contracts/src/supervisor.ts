import { z } from 'zod';

import { IdSchema, IsoTimestampSchema, PaginationQuerySchema } from './common';
import { JsonObjectSchema, JsonValueSchema } from './json';

export const ExecutionStatusSchema = z.enum([
  'pending',
  'starting',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const ExecutionEventTypeSchema = z.enum([
  'started',
  'message',
  'output',
  'completed',
  'failed',
]);
export type ExecutionEventType = z.infer<typeof ExecutionEventTypeSchema>;

export const CreateExecutionRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(512),
  agentType: z.string().trim().min(1).max(256),
  input: JsonValueSchema,
  config: JsonObjectSchema,
  timeoutMs: z.number().int().min(1).max(86_400_000),
});
export type CreateExecutionRequest = z.infer<typeof CreateExecutionRequestSchema>;

export const ExecutionErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type ExecutionError = z.infer<typeof ExecutionErrorSchema>;

export const ExecutionResponseSchema = z.object({
  id: IdSchema,
  idempotencyKey: z.string(),
  agentType: z.string(),
  status: ExecutionStatusSchema,
  timeoutMs: z.number().int().positive(),
  output: JsonValueSchema.nullable(),
  error: ExecutionErrorSchema.nullable(),
  createdAt: IsoTimestampSchema,
  startedAt: IsoTimestampSchema.nullable(),
  finishedAt: IsoTimestampSchema.nullable(),
});
export type ExecutionResponse = z.infer<typeof ExecutionResponseSchema>;

export const PersistedExecutionEventSchema = z.object({
  executionId: IdSchema,
  sequence: z.number().int().positive(),
  type: ExecutionEventTypeSchema,
  payload: JsonValueSchema,
  createdAt: IsoTimestampSchema,
});
export type PersistedExecutionEvent = z.infer<typeof PersistedExecutionEventSchema>;

export const ExecutionListQuerySchema = PaginationQuerySchema.extend({
  status: ExecutionStatusSchema.optional(),
});
export type ExecutionListQuery = z.infer<typeof ExecutionListQuerySchema>;

export const ExecutionEventsQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(0).default(0),
});
export type ExecutionEventsQuery = z.infer<typeof ExecutionEventsQuerySchema>;

export const ExecutionListResponseSchema = z.object({
  executions: z.array(ExecutionResponseSchema),
  nextCursor: z.string().nullable(),
});
export type ExecutionListResponse = z.infer<typeof ExecutionListResponseSchema>;

export const ExecutionEventsResponseSchema = z.object({
  events: z.array(PersistedExecutionEventSchema),
});
export type ExecutionEventsResponse = z.infer<typeof ExecutionEventsResponseSchema>;

export const CancelExecutionResponseSchema = ExecutionResponseSchema;
export type CancelExecutionResponse = z.infer<typeof CancelExecutionResponseSchema>;
