import { z } from 'zod';

import {
  ErrorCodeSchema,
  IdempotencyKeySchema,
  IdSchema,
  IsoTimestampSchema,
  PaginationQuerySchema,
} from './common';
import { JsonValueSchema } from './json';

export const AgentThinkingLevelSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type AgentThinkingLevel = z.infer<typeof AgentThinkingLevelSchema>;

export const AgentToolNameSchema = z.enum(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
export type AgentToolName = z.infer<typeof AgentToolNameSchema>;

export const AgentModelSchema = z.object({
  provider: z.string().trim().min(1).max(256),
  id: z.string().trim().min(1).max(512),
});
export type AgentModel = z.infer<typeof AgentModelSchema>;

export const AgentModelOptionSchema = AgentModelSchema.extend({
  name: z.string().trim().min(1).max(512),
});
export type AgentModelOption = z.infer<typeof AgentModelOptionSchema>;

export const ManagedAgentModelsResponseSchema = z.object({
  models: z.array(AgentModelOptionSchema),
  defaultModel: AgentModelOptionSchema.nullable(),
});
export type ManagedAgentModelsResponse = z.infer<typeof ManagedAgentModelsResponseSchema>;

export const CreateManagedAgentRequestSchema = z.object({
  name: z.string().trim().min(1).max(256).optional(),
  systemPrompt: z.string().min(1).max(250_000),
  cwd: z.string().trim().min(1).max(4096).optional(),
  tools: z
    .array(AgentToolNameSchema)
    .max(7)
    .refine((tools) => new Set(tools).size === tools.length, 'Tool names must be unique')
    .optional(),
  model: AgentModelSchema.optional(),
  thinkingLevel: AgentThinkingLevelSchema.optional(),
});
export type CreateManagedAgentRequest = z.infer<typeof CreateManagedAgentRequestSchema>;

export const UpdateManagedAgentRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(256).optional(),
    systemPrompt: z.string().min(1).max(250_000).optional(),
  })
  .refine((request) => request.name !== undefined || request.systemPrompt !== undefined, {
    message: 'At least one agent field must be provided',
  });
export type UpdateManagedAgentRequest = z.infer<typeof UpdateManagedAgentRequestSchema>;

export const ManagedAgentResponseSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(256),
  systemPrompt: z.string().min(1).max(250_000),
  model: AgentModelSchema.nullable(),
  thinkingLevel: AgentThinkingLevelSchema.nullable(),
  cwd: z.string().min(1),
  tools: z.array(AgentToolNameSchema).nullable(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type ManagedAgentResponse = z.infer<typeof ManagedAgentResponseSchema>;

export const ManagedAgentListQuerySchema = PaginationQuerySchema.strict();
export type ManagedAgentListQuery = z.infer<typeof ManagedAgentListQuerySchema>;

export const ManagedAgentListResponseSchema = z.object({
  agents: z.array(ManagedAgentResponseSchema),
  nextCursor: z.string().nullable(),
});
export type ManagedAgentListResponse = z.infer<typeof ManagedAgentListResponseSchema>;

export const ManagedAgentRunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type ManagedAgentRunStatus = z.infer<typeof ManagedAgentRunStatusSchema>;

export const CreateManagedAgentRunRequestSchema = z.object({
  agentId: IdSchema,
  prompt: z.string().min(1).max(1_000_000),
  model: AgentModelSchema.optional(),
  thinkingLevel: AgentThinkingLevelSchema.optional(),
  cwd: z.string().trim().min(1).max(4096).optional(),
});
export type CreateManagedAgentRunRequest = z.infer<typeof CreateManagedAgentRunRequestSchema>;

export const ManagedAgentRunErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type ManagedAgentRunError = z.infer<typeof ManagedAgentRunErrorSchema>;

export const ManagedAgentRunResponseSchema = z.object({
  id: IdSchema,
  agentId: IdSchema,
  prompt: z.string().min(1),
  model: AgentModelSchema.nullable(),
  thinkingLevel: AgentThinkingLevelSchema.nullable(),
  cwd: z.string().min(1),
  status: ManagedAgentRunStatusSchema,
  error: ManagedAgentRunErrorSchema.nullable(),
  createdAt: IsoTimestampSchema,
  startedAt: IsoTimestampSchema.nullable(),
  completedAt: IsoTimestampSchema.nullable(),
});
export type ManagedAgentRunResponse = z.infer<typeof ManagedAgentRunResponseSchema>;

export const ManagedAgentRunListQuerySchema = PaginationQuerySchema.extend({
  agentId: IdSchema.optional(),
  status: ManagedAgentRunStatusSchema.optional(),
});
export type ManagedAgentRunListQuery = z.infer<typeof ManagedAgentRunListQuerySchema>;

export const ManagedAgentRunListResponseSchema = z.object({
  runs: z.array(ManagedAgentRunResponseSchema),
  nextCursor: z.string().nullable(),
});
export type ManagedAgentRunListResponse = z.infer<typeof ManagedAgentRunListResponseSchema>;

export const AgentMessageRequestSchema = z.object({
  message: z.string().min(1).max(1_000_000),
});
export type AgentMessageRequest = z.infer<typeof AgentMessageRequestSchema>;

export const ManagedAgentEventSchema = z.object({
  agentId: IdSchema,
  runId: IdSchema.nullable(),
  sequence: z.number().int().positive(),
  type: z.string().min(1).max(256),
  payload: JsonValueSchema,
  createdAt: IsoTimestampSchema,
});
export type ManagedAgentEvent = z.infer<typeof ManagedAgentEventSchema>;

export const ManagedAgentEventsQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(0).default(0),
});
export type ManagedAgentEventsQuery = z.infer<typeof ManagedAgentEventsQuerySchema>;

export const ManagedAgentEventsResponseSchema = z.object({
  events: z.array(ManagedAgentEventSchema),
});
export type ManagedAgentEventsResponse = z.infer<typeof ManagedAgentEventsResponseSchema>;

export const ManagedAgentCommandTypeSchema = z.enum(['create', 'prompt', 'abort', 'dispose']);
export type ManagedAgentCommandType = z.infer<typeof ManagedAgentCommandTypeSchema>;

export const ManagedAgentCommandStatusSchema = z.enum([
  'pending',
  'succeeded',
  'failed',
  'indeterminate',
]);
export type ManagedAgentCommandStatus = z.infer<typeof ManagedAgentCommandStatusSchema>;

export const ManagedAgentCommandReceiptSchema = z.object({
  id: IdSchema,
  idempotencyKey: IdempotencyKeySchema,
  agentId: IdSchema,
  command: ManagedAgentCommandTypeSchema,
  status: ManagedAgentCommandStatusSchema,
  result: ManagedAgentResponseSchema.nullable(),
  error: z
    .object({
      code: ErrorCodeSchema,
      message: z.string().min(1),
    })
    .nullable(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema.nullable(),
});
export type ManagedAgentCommandReceipt = z.infer<typeof ManagedAgentCommandReceiptSchema>;
