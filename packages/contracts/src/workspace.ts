import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './common';

export const ExecutionModeSchema = z.enum(['local', 'worktree']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const FleetHealthSchema = z.object({
  status: z.enum(['healthy', 'degraded']),
  database: z.literal('connected'),
  runtime: z.enum(['ready', 'stopping']),
  checkedAt: IsoTimestampSchema,
});
export type FleetHealth = z.infer<typeof FleetHealthSchema>;

export interface FleetRun {
  id: string;
  parentRunId: string | null;
  agentId: string;
  agentName: string;
  prompt: string;
  cwd: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  executionMode: ExecutionMode;
  worktreeId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  children: FleetRun[];
}
export const FleetRunSchema: z.ZodType<FleetRun> = z.object({
  id: IdSchema,
  parentRunId: IdSchema.nullable(),
  agentId: IdSchema,
  agentName: z.string().min(1),
  prompt: z.string(),
  cwd: z.string().min(1),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  executionMode: ExecutionModeSchema,
  worktreeId: IdSchema.nullable(),
  createdAt: IsoTimestampSchema,
  startedAt: IsoTimestampSchema.nullable(),
  completedAt: IsoTimestampSchema.nullable(),
  children: z.lazy(() => z.array(FleetRunSchema)),
});
export const FleetOverviewResponseSchema = z.object({
  health: FleetHealthSchema,
  runs: z.array(FleetRunSchema),
  counts: z.object({
    active: z.number().int().nonnegative(),
    attention: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  complete: z.boolean(),
});
export type FleetOverviewResponse = z.infer<typeof FleetOverviewResponseSchema>;

export const ChangeScopeSchema = z.enum(['last_turn', 'working_tree', 'staged', 'branch']);
export type ChangeScope = z.infer<typeof ChangeScopeSchema>;
export const ChangedFileSchema = z.object({
  path: z.string().min(1),
  status: z.string().min(1).max(4),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export const RunChangesResponseSchema = z.object({
  runId: IdSchema,
  scope: ChangeScopeSchema,
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  baseRef: z.string().nullable(),
  files: z.array(ChangedFileSchema),
  patch: z.string(),
  truncated: z.boolean(),
});
export type RunChangesResponse = z.infer<typeof RunChangesResponseSchema>;

export const WorktreeStatusSchema = z.enum([
  'creating',
  'ready',
  'busy',
  'releasing',
  'deleted',
  'failed',
]);
export const WorktreeResponseSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  path: z.string().min(1),
  branch: z.string().min(1),
  baseRef: z.string().min(1),
  status: WorktreeStatusSchema,
  error: z.string().nullable(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type WorktreeResponse = z.infer<typeof WorktreeResponseSchema>;
export const CreateWorktreeRequestSchema = z.object({
  projectId: IdSchema,
  branch: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9._/-]+$/),
  baseRef: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9._/-]+$/)
    .default('HEAD'),
});
export type CreateWorktreeRequest = z.infer<typeof CreateWorktreeRequestSchema>;
export const WorktreeListResponseSchema = z.object({ worktrees: z.array(WorktreeResponseSchema) });

export const TerminalStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'output_limited',
]);
export const CreateTerminalSessionRequestSchema = z.object({
  cwd: z.string().trim().min(1).max(4096),
  command: z.string().trim().min(1).max(1024),
  args: z.array(z.string().max(8192)).max(128).default([]),
  timeoutMs: z.number().int().min(1000).max(3_600_000).default(900_000),
  maxOutputBytes: z.number().int().min(1024).max(10_000_000).default(1_000_000),
});
export type CreateTerminalSessionRequest = z.infer<typeof CreateTerminalSessionRequestSchema>;
export const TerminalSessionResponseSchema = z.object({
  id: IdSchema,
  cwd: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  status: TerminalStatusSchema,
  exitCode: z.number().int().nullable(),
  output: z.string(),
  truncated: z.boolean(),
  createdAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema.nullable(),
});
export type TerminalSessionResponse = z.infer<typeof TerminalSessionResponseSchema>;
export const TerminalSessionListResponseSchema = z.object({
  sessions: z.array(TerminalSessionResponseSchema),
});

export const InboxItemKindSchema = z.enum(['approval', 'question']);
export const InboxItemStatusSchema = z.enum(['pending', 'resolved', 'cancelled']);
export const InboxItemResponseSchema = z.object({
  id: IdSchema,
  kind: InboxItemKindSchema,
  runId: IdSchema.nullable(),
  title: z.string().min(1),
  body: z.string(),
  options: z.array(z.string()),
  status: InboxItemStatusSchema,
  response: z.string().nullable(),
  createdAt: IsoTimestampSchema,
  resolvedAt: IsoTimestampSchema.nullable(),
});
export type InboxItemResponse = z.infer<typeof InboxItemResponseSchema>;
export const InboxListResponseSchema = z.object({ items: z.array(InboxItemResponseSchema) });
export const CreateInboxItemRequestSchema = z.object({
  kind: InboxItemKindSchema,
  runId: IdSchema.nullable().optional(),
  title: z.string().trim().min(1).max(512),
  body: z.string().max(10_000).default(''),
  options: z.array(z.string().min(1).max(256)).max(20).default([]),
});
export const ResolveInboxItemRequestSchema = z.object({
  response: z.string().trim().min(1).max(10_000),
});

export const SessionSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(256),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const SessionSearchResultSchema = z.object({
  runId: IdSchema,
  agentId: IdSchema,
  title: z.string(),
  cwd: z.string(),
  status: z.string(),
  createdAt: IsoTimestampSchema,
});
export const SessionSearchResponseSchema = z.object({
  results: z.array(SessionSearchResultSchema),
});
export type SessionSearchResponse = z.infer<typeof SessionSearchResponseSchema>;
