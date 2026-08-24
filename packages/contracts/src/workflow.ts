import { z } from 'zod';

import {
  IdempotencyKeySchema,
  IdSchema,
  IsoTimestampSchema,
  PaginationQuerySchema,
} from './common';
import { JsonObjectSchema, JsonValueSchema } from './json';

export const RunStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_for_approval',
  'completed',
  'rejected',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StepStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_for_approval',
  'completed',
  'rejected',
  'failed',
  'cancelled',
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'cancelled']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const DecisionOutcomeSchema = z.enum(['approve', 'reject']);
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

export const CreateWorkflowRequestSchema = z.object({
  name: z.string().trim().min(1).max(256),
  description: z.string().max(10_000).default(''),
  draft: JsonObjectSchema,
});
export type CreateWorkflowRequest = z.infer<typeof CreateWorkflowRequestSchema>;

export const UpdateWorkflowDraftRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(256),
  description: z.string().max(10_000),
  draft: JsonObjectSchema,
});
export type UpdateWorkflowDraftRequest = z.infer<typeof UpdateWorkflowDraftRequestSchema>;

export const PublishWorkflowRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
});
export type PublishWorkflowRequest = z.infer<typeof PublishWorkflowRequestSchema>;

export const StartRunRequestSchema = z.object({
  version: z.number().int().positive().optional(),
  input: JsonValueSchema.default(null),
  correlationId: z.string().trim().min(1).max(256).optional(),
  metadata: JsonObjectSchema.default({}),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const WorkflowResponseSchema = z.object({
  id: IdSchema,
  name: z.string(),
  description: z.string(),
  draft: JsonObjectSchema,
  draftVersion: z.number().int().positive(),
  createdBy: IdSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type WorkflowResponse = z.infer<typeof WorkflowResponseSchema>;

export const WorkflowSummaryResponseSchema = WorkflowResponseSchema.omit({ draft: true }).extend({
  latestPublishedVersion: z.number().int().positive().nullable(),
});
export type WorkflowSummaryResponse = z.infer<typeof WorkflowSummaryResponseSchema>;

export const WorkflowListQuerySchema = PaginationQuerySchema.extend({
  query: z.string().trim().min(1).max(256).optional(),
});
export type WorkflowListQuery = z.infer<typeof WorkflowListQuerySchema>;

export const WorkflowListResponseSchema = z.object({
  workflows: z.array(WorkflowSummaryResponseSchema),
  nextCursor: z.string().nullable(),
});
export type WorkflowListResponse = z.infer<typeof WorkflowListResponseSchema>;

export const WorkflowVersionResponseSchema = z.object({
  id: IdSchema,
  workflowId: IdSchema,
  version: z.number().int().positive(),
  definition: JsonObjectSchema,
  definitionDigest: z.string().min(1),
  publishedBy: IdSchema,
  publishedAt: IsoTimestampSchema,
});
export type WorkflowVersionResponse = z.infer<typeof WorkflowVersionResponseSchema>;

export const RunResponseSchema = z.object({
  id: IdSchema,
  workflowId: IdSchema,
  workflowVersionId: IdSchema,
  initiatedBy: IdSchema,
  input: JsonValueSchema,
  status: RunStatusSchema,
  stateVersion: z.number().int().positive(),
  cancellationRequested: z.boolean(),
  idempotencyKey: IdempotencyKeySchema.nullable(),
  correlationId: z.string().nullable(),
  metadata: JsonObjectSchema,
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  createdAt: IsoTimestampSchema,
  startedAt: IsoTimestampSchema.nullable(),
  completedAt: IsoTimestampSchema.nullable(),
});
export type RunResponse = z.infer<typeof RunResponseSchema>;

export const RunListQuerySchema = PaginationQuerySchema.extend({
  status: RunStatusSchema.optional(),
  workflowId: IdSchema.optional(),
  correlationId: z.string().trim().min(1).max(256).optional(),
});
export type RunListQuery = z.infer<typeof RunListQuerySchema>;

export const RunListResponseSchema = z.object({
  runs: z.array(RunResponseSchema),
  nextCursor: z.string().nullable(),
});
export type RunListResponse = z.infer<typeof RunListResponseSchema>;

export const ApprovalDecisionRequestSchema = z.object({
  outcome: DecisionOutcomeSchema,
  comment: z.string().max(10_000).optional(),
  upstreamDigest: z.string().min(1),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

export const ApprovalResponseSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  stepInstanceId: IdSchema,
  status: ApprovalStatusSchema,
  requiredRoleIds: z.array(z.string()),
  matchingMode: z.enum(['any', 'all']),
  minimumApprovals: z.number().int().positive(),
  initiatorMayApprove: z.boolean(),
  upstreamDigest: z.string().min(1),
  createdAt: IsoTimestampSchema,
  resolvedAt: IsoTimestampSchema.nullable(),
  cancelledAt: IsoTimestampSchema.nullable(),
});
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

export const ApprovalDecisionResponseSchema = z.object({
  id: IdSchema,
  approvalRequestId: IdSchema,
  userId: IdSchema,
  observedRoleIds: z.array(z.string()),
  outcome: DecisionOutcomeSchema,
  comment: z.string().nullable(),
  upstreamDigest: z.string(),
  createdAt: IsoTimestampSchema,
});
export type ApprovalDecisionResponse = z.infer<typeof ApprovalDecisionResponseSchema>;

export const RunStepAttemptResponseSchema = z.object({
  id: IdSchema,
  attemptNumber: z.number().int().positive(),
  status: z.string().min(1),
  input: JsonValueSchema.nullable(),
  output: JsonValueSchema.nullable(),
  error: JsonValueSchema.nullable(),
  supervisorExecutionId: IdSchema.nullable(),
  createdAt: IsoTimestampSchema,
  startedAt: IsoTimestampSchema.nullable(),
  completedAt: IsoTimestampSchema.nullable(),
});
export type RunStepAttemptResponse = z.infer<typeof RunStepAttemptResponseSchema>;

export const RunTimelineStepSchema = z.object({
  id: IdSchema,
  nodeId: z.string().min(1),
  nodeType: z.string().min(1),
  ordinal: z.number().int().min(0),
  status: StepStatusSchema,
  input: JsonValueSchema.nullable(),
  output: JsonValueSchema.nullable(),
  observed: JsonValueSchema.nullable(),
  attempts: z.array(RunStepAttemptResponseSchema),
  approvalRequest: ApprovalResponseSchema.nullable(),
  approvalDecisions: z.array(ApprovalDecisionResponseSchema),
  createdAt: IsoTimestampSchema,
  startedAt: IsoTimestampSchema.nullable(),
  completedAt: IsoTimestampSchema.nullable(),
});
export type RunTimelineStep = z.infer<typeof RunTimelineStepSchema>;

export const RunInspectionResponseSchema = z.object({
  run: RunResponseSchema,
  workflow: WorkflowResponseSchema.pick({ id: true, name: true, description: true }),
  version: WorkflowVersionResponseSchema,
  steps: z.array(RunTimelineStepSchema),
});
export type RunInspectionResponse = z.infer<typeof RunInspectionResponseSchema>;
