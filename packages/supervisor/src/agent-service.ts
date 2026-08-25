import { createHash } from 'node:crypto';

import {
  type AgentImageAttachment,
  AgentImageAttachmentSchema,
  type AgentMessageRequest,
  AgentMessageRequestSchema,
  type AgentThinkingLevel,
  type AgentToolName,
  type CreateManagedAgentRequest,
  CreateManagedAgentRequestSchema,
  type CreateManagedAgentRunRequest,
  CreateManagedAgentRunRequestSchema,
  decodeJson,
  encodeJson,
  type JsonObject,
  type JsonValue,
  type ManagedAgentEvent,
  type ManagedAgentEventsQuery,
  type ManagedAgentListQuery,
  type ManagedAgentModelsResponse,
  type ManagedAgentResponse,
  ManagedAgentResponseSchema,
  type ManagedAgentRunAttachmentsResponse,
  type ManagedAgentRunListQuery,
  type ManagedAgentRunResponse,
  ManagedAgentRunResponseSchema,
  type ManagedAgentRunStatus,
  ManagedAgentRunStatusSchema,
  type UpdateManagedAgentRequest,
  UpdateManagedAgentRequestSchema,
} from '@nextflow/contracts';
import {
  createId,
  nowIso,
  type SupervisorAgentRunAttachmentsTable,
  type SupervisorAgentRunsTable,
  type SupervisorAgentsTable,
  type SupervisorDatabase,
  withBusyRetry,
} from '@nextflow/database';
import { type Kysely, type Selectable, sql, type Transaction } from 'kysely';
import { ManagedAgentEventHub } from './agent-event-hub.js';
import type {
  CreatePiSessionOptions,
  ManagedPiSession,
  PiImageContent,
  PiSessionFactory,
} from './pi-session.js';
import { ProjectService } from './project-service.js';
import type { SupervisorLogger } from './service.js';
import { resolveWorkingDirectory } from './working-directory.js';

const defaultLogger: SupervisorLogger = {
  info: (message, context) => console.info(message, context ?? ''),
  warn: (message, context) => console.warn(message, context ?? ''),
  error: (message, context) => console.error(message, context ?? ''),
};

type AgentRow = Selectable<SupervisorAgentsTable>;
type AgentRunRow = Selectable<SupervisorAgentRunsTable>;
type AgentRunAttachmentRow = Selectable<SupervisorAgentRunAttachmentsTable>;

export interface EventPayloadLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxItems: number;
}

interface ActiveRun {
  readonly runId: string;
  readonly agentId: string;
  readonly session: ManagedPiSession;
  readonly operations: Set<Promise<void>>;
  generation: number;
  settled: boolean;
  unsubscribed: boolean;
  disposePromise?: Promise<void>;
  unsubscribe: () => void;
}

export class ManagedAgentNotFoundError extends Error {
  readonly code = 'not_found';

  constructor(readonly agentId: string) {
    super(`Agent ${agentId} was not found`);
    this.name = 'ManagedAgentNotFoundError';
  }
}

export class ManagedAgentNotAvailableError extends Error {
  readonly code = 'agent_not_available';

  constructor(
    readonly agentId: string,
    message = `Agent ${agentId} is not available`,
  ) {
    super(message);
    this.name = 'ManagedAgentNotAvailableError';
  }
}

export class ManagedAgentBusyError extends Error {
  readonly code = 'agent_busy';

  constructor(
    readonly agentId: string,
    message = `Agent ${agentId} is already running`,
  ) {
    super(message);
    this.name = 'ManagedAgentBusyError';
  }
}

export class ManagedAgentRunNotFoundError extends Error {
  readonly code = 'not_found';

  constructor(readonly runId: string) {
    super(`Run ${runId} was not found`);
    this.name = 'ManagedAgentRunNotFoundError';
  }
}

export class ManagedAgentIdempotencyConflictError extends Error {
  readonly code = 'idempotency_conflict';

  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used for a different request`);
    this.name = 'ManagedAgentIdempotencyConflictError';
  }
}

export class ManagedAgentCommandInProgressError extends Error {
  readonly code = 'idempotency_in_progress';

  constructor(readonly idempotencyKey: string) {
    super(`The command for idempotency key ${idempotencyKey} is still in progress`);
    this.name = 'ManagedAgentCommandInProgressError';
  }
}

export class ManagedAgentCommandReplayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ManagedAgentCommandReplayError';
  }
}

export class ManagedAgentRunNotCancellableError extends Error {
  readonly code = 'run_not_cancellable';

  constructor(readonly runId: string) {
    super(`Run ${runId} is not cancellable`);
    this.name = 'ManagedAgentRunNotCancellableError';
  }
}

export interface ManagedAgentServiceOptions {
  readonly db: Kysely<SupervisorDatabase>;
  readonly sessionFactory: PiSessionFactory;
  readonly defaultCwd?: string;
  readonly logger?: SupervisorLogger;
  readonly now?: () => string;
  readonly idFactory?: () => string;
  readonly projectService?: ProjectService;
  /** Bounds shutdown and abort cleanup when an SDK session is unhealthy. */
  readonly shutdownTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly eventPayloadLimits?: Partial<EventPayloadLimits>;
  /** Optional explicit retention policy; undefined retains full history. */
  readonly eventRetentionDays?: number;
}

/**
 * Stores agent definitions and owns the process-local session for each run.
 *
 * An agent is deliberately inert: creating or reading one never creates a Pi
 * session and never reports runtime state. A run snapshots the definition,
 * creates its own session, and owns the only lifecycle/status for that work.
 */
export class ManagedAgentService {
  readonly events = new ManagedAgentEventHub();

  private readonly db: Kysely<SupervisorDatabase>;
  private readonly sessionFactory: PiSessionFactory;
  private readonly defaultCwd: string;
  private readonly logger: SupervisorLogger;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly projectService: ProjectService;
  private readonly shutdownTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly eventPayloadLimits: EventPayloadLimits;
  private readonly eventRetentionDays: number | undefined;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly eventTails = new Map<string, Promise<unknown>>();
  private readonly commandTails = new Map<string, Promise<void>>();
  private readonly startTasks = new Map<string, { agentId: string; task: Promise<void> }>();
  private readonly stoppingAgents = new Set<string>();
  private closePromise?: Promise<void>;
  private legacyAgentStatusColumn?: Promise<boolean>;
  private started = false;
  private closed = false;

  constructor(options: ManagedAgentServiceOptions) {
    this.db = options.db;
    this.sessionFactory = options.sessionFactory;
    this.defaultCwd = resolveWorkingDirectory(options.defaultCwd ?? process.cwd());
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? nowIso;
    this.idFactory = options.idFactory ?? createId;
    this.projectService =
      options.projectService ?? new ProjectService({ db: options.db, now: this.now });
    this.shutdownTimeoutMs = Math.max(1, options.shutdownTimeoutMs ?? 5_000);
    this.operationTimeoutMs = Math.max(1, options.operationTimeoutMs ?? this.shutdownTimeoutMs);
    this.eventPayloadLimits = {
      maxBytes: Math.max(1, options.eventPayloadLimits?.maxBytes ?? 256_000),
      maxDepth: Math.max(1, options.eventPayloadLimits?.maxDepth ?? 16),
      maxItems: Math.max(1, options.eventPayloadLimits?.maxItems ?? 10_000),
    };
    this.eventRetentionDays =
      options.eventRetentionDays === undefined
        ? undefined
        : Math.max(1, Math.floor(options.eventRetentionDays));
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.closed) throw new Error('managed_agent_service_closed');
    this.started = true;
    await this.projectService.initialize();
    await this.compactEventsIfConfigured();

    // Sessions are process-local and are intentionally not reconstructed. A
    // recovery event is written for every row whose reservation was lost.
    const interrupted = await this.db
      .selectFrom('supervisor_agent_runs')
      .select(['id', 'agent_id'])
      .where('status', 'in', ['queued', 'running'])
      .execute();
    for (const run of interrupted) {
      await this.finalizeRunWithoutSession(
        run.agent_id,
        run.id,
        'failed',
        {
          code: 'supervisor_restarted',
          message: 'The run was interrupted when the Supervisor restarted',
        },
        'supervisor.run_failed',
      );
    }
  }

  private async compactEventsIfConfigured(): Promise<void> {
    if (this.eventRetentionDays === undefined) return;
    const cutoff = new Date(Date.now() - this.eventRetentionDays * 86_400_000).toISOString();
    await this.db.deleteFrom('supervisor_agent_events').where('created_at', '<', cutoff).execute();
    this.logger.info('Compacted Supervisor event history', {
      retentionDays: this.eventRetentionDays,
      cutoff,
    });
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const activeRuns = [...this.activeRuns.values()];
    await Promise.allSettled(
      activeRuns.map(async (active) => {
        active.generation += 1;
        await this.tryAbort(active, 'shutdown');
        await this.waitForOperations(active, 'shutdown');
        await this.disposeActiveRun(active);
      }),
    );

    const starts = [...this.startTasks.values()].map((entry) => entry.task);
    await this.withTimeout(
      Promise.allSettled(starts).then(() => undefined),
      this.shutdownTimeoutMs,
      'session starts during shutdown',
    ).catch((error: unknown) => {
      this.logger.warn('Sessions did not stop before shutdown deadline', {
        error: sanitizeError(error),
      });
    });
    await Promise.allSettled(
      [...this.activeRuns.values()].map((active) => this.disposeActiveRun(active)),
    );
    for (const agentId of new Set([...this.eventTails.keys()])) {
      await this.withTimeout(
        this.waitForEvents(agentId),
        this.shutdownTimeoutMs,
        'event persistence',
      ).catch((error: unknown) => {
        this.logger.warn('Event persistence did not stop before shutdown deadline', {
          agentId,
          error: sanitizeError(error),
        });
      });
    }
    this.eventTails.clear();
    this.commandTails.clear();
    this.activeRuns.clear();
    this.startTasks.clear();
  }

  async createAgent(input: CreateManagedAgentRequest): Promise<ManagedAgentResponse> {
    this.assertMutable();

    const request = CreateManagedAgentRequestSchema.parse(input);
    const id = this.idFactory();
    const createdAt = this.now();
    const cwd = resolveWorkingDirectory(request.cwd ?? this.defaultCwd);
    const name = request.name ?? 'Pi agent';
    const toolsJson = request.tools ? encodeJson(request.tools) : null;
    if (await this.usesLegacyAgentRuntimeColumns()) {
      await sql`
        INSERT INTO supervisor_agents (
          id, name, status, system_prompt, cwd, tools_json,
          requested_model_provider, requested_model_id, model_provider, model_id,
          thinking_level, pi_session_id, pi_session_file, message_count,
          pending_message_count, error_code, error_message, created_at, updated_at, disposed_at
        ) VALUES (
          ${id}, ${name}, 'defined', ${request.systemPrompt}, ${cwd}, ${toolsJson},
          ${request.model?.provider ?? null}, ${request.model?.id ?? null}, NULL, NULL,
          ${request.thinkingLevel ?? null}, NULL, NULL, 0, 0, NULL, NULL,
          ${createdAt}, ${createdAt}, NULL
        )
      `.execute(this.db);
    } else {
      await this.db
        .insertInto('supervisor_agents')
        .values({
          id,
          name,
          system_prompt: request.systemPrompt,
          cwd,
          tools_json: toolsJson,
          requested_model_provider: request.model?.provider ?? null,
          requested_model_id: request.model?.id ?? null,
          thinking_level: request.thinkingLevel ?? null,
          created_at: createdAt,
          updated_at: createdAt,
          deleted_at: null,
        })
        .execute();
    }

    await this.enqueueCustomEvent(id, null, 'supervisor.agent_created', {});
    return this.requireAgent(id);
  }

  async createRun(input: CreateManagedAgentRunRequest): Promise<ManagedAgentRunResponse> {
    this.assertMutable();
    const request = CreateManagedAgentRunRequestSchema.parse(input);
    if (!(await this.getAgentRow(request.agentId))) {
      throw new ManagedAgentNotFoundError(request.agentId);
    }
    const receipt = await this.beginReceipt(
      request.agentId,
      'run_create',
      request.idempotencyKey,
      request,
    );
    if (receipt.result) {
      return {
        ...ManagedAgentRunResponseSchema.parse(receipt.result),
        acknowledgementId: receipt.id,
      };
    }
    try {
      const result = await this.createRunAdmitted(request);
      if (receipt.id) {
        await this.completeReceipt(receipt.id, result);
        return { ...result, acknowledgementId: receipt.id };
      }
      return result;
    } catch (error) {
      if (receipt.id) await this.failReceipt(receipt.id, error);
      throw error;
    }
  }

  private async createRunAdmitted(
    request: CreateManagedAgentRunRequest,
  ): Promise<ManagedAgentRunResponse> {
    // The in-process fence avoids a check-then-insert race. The partial
    // unique index below is the cross-process backstop.
    return this.serializeCommand(`agent:${request.agentId}`, async () => {
      const agent = await this.getAgentRow(request.agentId);
      if (!agent) throw new ManagedAgentNotFoundError(request.agentId);
      const existing = await this.db
        .selectFrom('supervisor_agent_runs')
        .select('id')
        .where('agent_id', '=', agent.id)
        .where('status', 'in', ['queued', 'running'])
        .executeTakeFirst();
      if (existing) throw new ManagedAgentBusyError(agent.id);

      const sessionOptions = createSessionOptions(agent, request);
      await this.projectService.touchPath(sessionOptions.cwd ?? this.defaultCwd);
      const runId = this.idFactory();
      const createdAt = this.now();
      try {
        await this.db.transaction().execute(async (transaction) => {
          await transaction
            .insertInto('supervisor_agent_runs')
            .values({
              id: runId,
              agent_id: agent.id,
              prompt: request.prompt,
              model_provider: sessionOptions.model?.provider ?? null,
              model_id: sessionOptions.model?.id ?? null,
              thinking_level: sessionOptions.thinkingLevel ?? null,
              cwd: sessionOptions.cwd ?? this.defaultCwd,
              status: 'queued',
              error_code: null,
              error_message: null,
              created_at: createdAt,
              started_at: null,
              completed_at: null,
            })
            .execute();
          if (request.attachments?.length) {
            await transaction
              .insertInto('supervisor_agent_run_attachments')
              .values(
                request.attachments.map((attachment, position) => ({
                  run_id: runId,
                  position,
                  name: attachment.name,
                  mime_type: attachment.mimeType,
                  data: attachment.data,
                  created_at: createdAt,
                })),
              )
              .execute();
          }
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) throw new ManagedAgentBusyError(agent.id);
        throw error;
      }

      const startTask = this.startRun(
        agent,
        runId,
        request.prompt,
        sessionOptions,
        request.attachments,
      );
      this.startTasks.set(runId, { agentId: agent.id, task: startTask });
      try {
        await startTask;
      } finally {
        if (this.startTasks.get(runId)?.task === startTask) this.startTasks.delete(runId);
      }
      return this.requireRun(runId);
    });
  }

  async getRun(runId: string): Promise<ManagedAgentRunResponse | null> {
    const row = await this.getRunRow(runId);
    return row ? this.toRunResponse(row) : null;
  }

  async listRunAttachments(runId: string): Promise<ManagedAgentRunAttachmentsResponse> {
    const run = await this.getRunRow(runId);
    if (!run) throw new ManagedAgentRunNotFoundError(runId);
    const rows = await this.db
      .selectFrom('supervisor_agent_run_attachments')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('position', 'asc')
      .execute();
    return {
      attachments: rows.map((row) => this.toRunAttachment(row)),
    };
  }

  async listRuns(options: ManagedAgentRunListQuery): Promise<{
    runs: ManagedAgentRunResponse[];
    nextCursor: string | null;
  }> {
    let query = this.db.selectFrom('supervisor_agent_runs').selectAll();
    if (options.agentId) query = query.where('agent_id', '=', options.agentId);
    if (options.status) query = query.where('status', '=', options.status);
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      if (cursor) {
        query = query.where((expression) =>
          expression.or([
            expression('created_at', '<', cursor.createdAt),
            expression.and([
              expression('created_at', '=', cursor.createdAt),
              expression('id', '<', cursor.id),
            ]),
          ]),
        );
      }
    }

    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(options.limit + 1)
      .execute();
    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    return {
      runs: page.map((row) => this.toRunResponse(row)),
      nextCursor: hasMore
        ? encodeCursor(page.at(-1)?.created_at ?? '', page.at(-1)?.id ?? '')
        : null,
    };
  }

  async cancelRun(runId: string, idempotencyKey?: string): Promise<ManagedAgentRunResponse> {
    this.assertMutable();
    return this.serializeRunCommand(runId, async () => {
      const row = await this.getRunRow(runId);
      if (!row) throw new ManagedAgentRunNotFoundError(runId);
      const receipt = await this.beginReceipt(row.agent_id, 'cancel', idempotencyKey, {
        command: 'cancel',
        runId,
      });
      if (receipt.result) {
        return {
          ...ManagedAgentRunResponseSchema.parse(receipt.result),
          acknowledgementId: receipt.id,
        };
      }
      try {
        const status = ManagedAgentRunStatusSchema.parse(row.status);
        if (isTerminalRunStatus(status)) throw new ManagedAgentRunNotCancellableError(runId);

        const active = this.activeRuns.get(runId);
        if (active) {
          // Invalidate every older prompt before asking the SDK to stop. Even a
          // rejected abort therefore cannot turn the cancelled row into failed.
          active.generation += 1;
          await this.tryAbort(active, 'cancel');
          await this.waitForOperations(active, 'cancel');
          await this.waitForEvents(active.agentId);
        }
        const won = await this.finalizeRun(
          row.agent_id,
          runId,
          'cancelled',
          { code: 'run_cancelled', message: 'The run was cancelled by an operator' },
          'supervisor.run_cancelled',
        );
        if (won && active) await this.disposeActiveRun(active);
        const result = await this.requireRun(runId);
        if (receipt.id) {
          await this.completeReceipt(receipt.id, result);
          return { ...result, acknowledgementId: receipt.id };
        }
        return result;
      } catch (error) {
        if (receipt.id) await this.failReceipt(receipt.id, error);
        throw error;
      }
    });
  }

  async getAgent(agentId: string): Promise<ManagedAgentResponse | null> {
    const row = await this.getAgentRow(agentId);
    return row ? this.toResponse(row) : null;
  }

  async listModels(): Promise<ManagedAgentModelsResponse> {
    return (
      (await this.sessionFactory.listModels?.()) ?? {
        models: [],
        defaultModel: null,
      }
    );
  }

  async renameAgent(
    agentId: string,
    input: UpdateManagedAgentRequest,
  ): Promise<ManagedAgentResponse> {
    this.assertMutable();
    const request = UpdateManagedAgentRequestSchema.parse(input);
    return this.serializeCommand(`agent:${agentId}`, async () => {
      if (!(await this.getAgentRow(agentId))) throw new ManagedAgentNotFoundError(agentId);
      const updatedAt = this.now();
      await this.db
        .updateTable('supervisor_agents')
        .set({
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.systemPrompt === undefined ? {} : { system_prompt: request.systemPrompt }),
          updated_at: updatedAt,
        })
        .where('id', '=', agentId)
        .execute();
      await this.enqueueCustomEvent(agentId, null, 'supervisor.agent_updated', {
        ...(request.name === undefined ? {} : { name: request.name }),
      });
      return this.requireAgent(agentId);
    });
  }

  async listAgents(options: ManagedAgentListQuery): Promise<{
    agents: ManagedAgentResponse[];
    nextCursor: string | null;
  }> {
    let query = this.db.selectFrom('supervisor_agents').selectAll().where('deleted_at', 'is', null);
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      if (cursor) {
        query = query.where((expression) =>
          expression.or([
            expression('created_at', '<', cursor.createdAt),
            expression.and([
              expression('created_at', '=', cursor.createdAt),
              expression('id', '<', cursor.id),
            ]),
          ]),
        );
      }
    }

    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(options.limit + 1)
      .execute();
    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    return {
      agents: page.map((row) => this.toResponse(row)),
      nextCursor: hasMore
        ? encodeCursor(page.at(-1)?.created_at ?? '', page.at(-1)?.id ?? '')
        : null,
    };
  }

  async deleteAgent(agentId: string): Promise<ManagedAgentResponse> {
    this.assertMutable();
    return this.serializeCommand(`agent:${agentId}`, async () => {
      this.stoppingAgents.add(agentId);
      const pendingStarts = [...this.startTasks.values()]
        .filter((entry) => entry.agentId === agentId)
        .map((entry) => entry.task);
      const activeRuns = [...this.activeRuns.values()].filter(
        (active) => active.agentId === agentId,
      );
      await Promise.allSettled(
        activeRuns.map(async (active) => {
          active.generation += 1;
          await this.tryAbort(active, 'agent deletion');
          await this.waitForOperations(active, 'agent deletion');
          await this.finalizeRun(
            agentId,
            active.runId,
            'cancelled',
            { code: 'agent_deleted', message: 'The agent profile was deleted' },
            'supervisor.run_cancelled',
          );
          await this.disposeActiveRun(active);
        }),
      );
      await this.withTimeout(
        Promise.allSettled(pendingStarts).then(() => undefined),
        this.shutdownTimeoutMs,
        'agent deletion session starts',
      );
      const lateRuns = [...this.activeRuns.values()].filter((active) => active.agentId === agentId);
      await Promise.allSettled(
        lateRuns.map(async (active) => {
          active.generation += 1;
          await this.tryAbort(active, 'agent deletion');
          await this.waitForOperations(active, 'agent deletion');
          await this.finalizeRun(
            agentId,
            active.runId,
            'cancelled',
            { code: 'agent_deleted', message: 'The agent profile was deleted' },
            'supervisor.run_cancelled',
          );
          await this.disposeActiveRun(active);
        }),
      );
      const row = await this.db
        .selectFrom('supervisor_agents')
        .selectAll()
        .where('id', '=', agentId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!row) throw new ManagedAgentNotFoundError(agentId);
      await this.db
        .updateTable('supervisor_agents')
        .set({ deleted_at: this.now(), updated_at: this.now() })
        .where('id', '=', agentId)
        .where('deleted_at', 'is', null)
        .execute();
      return this.toResponse(row);
    }).finally(() => {
      this.stoppingAgents.delete(agentId);
    });
  }

  async steerRun(runId: string, input: AgentMessageRequest): Promise<ManagedAgentRunResponse> {
    this.assertMutable();
    const request = AgentMessageRequestSchema.parse(input);
    return this.serializeRunCommand(runId, async () => {
      const active = await this.requireActiveRun(runId);
      const receipt = await this.beginReceipt(active.agentId, 'steer', request.idempotencyKey, {
        command: 'steer',
        message: request.message,
        runId,
      });
      if (receipt.result) {
        return {
          ...ManagedAgentRunResponseSchema.parse(receipt.result),
          acknowledgementId: receipt.id,
        };
      }
      try {
        if (!active.session.isStreaming) {
          throw new ManagedAgentBusyError(active.agentId, `Run ${runId} is not running`);
        }
        await active.session.steer(request.message, toPiImages(request.attachments));
        await this.enqueueCustomEvent(active.agentId, runId, 'supervisor.steer_accepted', {});
        const result = await this.requireRun(runId);
        if (receipt.id) {
          await this.completeReceipt(receipt.id, result);
          return { ...result, acknowledgementId: receipt.id };
        }
        return result;
      } catch (error) {
        if (receipt.id) await this.failReceipt(receipt.id, error);
        if (error instanceof ManagedAgentBusyError) throw error;
        throw commandError(active.agentId, error);
      }
    });
  }

  async followUpRun(runId: string, input: AgentMessageRequest): Promise<ManagedAgentRunResponse> {
    this.assertMutable();
    const request = AgentMessageRequestSchema.parse(input);
    return this.serializeRunCommand(runId, async () => {
      const active = await this.requireActiveRun(runId, { allowCompleted: true });
      const receipt = await this.beginReceipt(active.agentId, 'follow_up', request.idempotencyKey, {
        command: 'follow_up',
        message: request.message,
        runId,
      });
      if (receipt.result) {
        return {
          ...ManagedAgentRunResponseSchema.parse(receipt.result),
          acknowledgementId: receipt.id,
        };
      }
      try {
        if (active.session.isStreaming) {
          await active.session.followUp(request.message, toPiImages(request.attachments));
        } else {
          const generation = ++active.generation;
          const transitioned = await this.markRunRunning(runId);
          if (!transitioned || active.generation !== generation) {
            throw new ManagedAgentBusyError(active.agentId, `Run ${runId} is no longer available`);
          }
          active.settled = false;
          this.launchOperation(
            active,
            promptSession(active.session, request.message, request.attachments),
            generation,
          );
        }
        await this.enqueueCustomEvent(active.agentId, runId, 'supervisor.follow_up_accepted', {
          message: request.message,
        });
        const result = await this.requireRun(runId);
        if (receipt.id) {
          await this.completeReceipt(receipt.id, result);
          return { ...result, acknowledgementId: receipt.id };
        }
        return result;
      } catch (error) {
        if (receipt.id) await this.failReceipt(receipt.id, error);
        if (error instanceof ManagedAgentBusyError) throw error;
        throw commandError(active.agentId, error);
      }
    });
  }

  async listEvents(
    agentId: string,
    options: ManagedAgentEventsQuery,
  ): Promise<ManagedAgentEvent[]> {
    return (await this.listEventsPage(agentId, options)).events;
  }

  async listEventsPage(
    agentId: string,
    options: ManagedAgentEventsQuery,
    runId?: string,
  ): Promise<{ events: ManagedAgentEvent[]; nextSequence: number | null; hasMore: boolean }> {
    await this.waitForEvents(agentId);
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    let query = this.db
      .selectFrom('supervisor_agent_events')
      .selectAll()
      .where('agent_id', '=', agentId)
      .where('sequence', '>', options.afterSequence);
    if (runId) query = query.where('run_id', '=', runId);
    const rows = await query
      .orderBy('sequence', 'asc')
      .limit(limit + 1)
      .execute();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      events: page.map(toEvent),
      nextSequence: hasMore ? (page.at(-1)?.sequence ?? null) : null,
      hasMore,
    };
  }

  async listRunEvents(
    runId: string,
    options: ManagedAgentEventsQuery,
  ): Promise<ManagedAgentEvent[]> {
    const row = await this.getRunRow(runId);
    if (!row) throw new ManagedAgentRunNotFoundError(runId);
    return (await this.listEventsPage(row.agent_id, options, runId)).events;
  }

  async listRunEventsPage(
    runId: string,
    options: ManagedAgentEventsQuery,
  ): Promise<{ events: ManagedAgentEvent[]; nextSequence: number | null; hasMore: boolean }> {
    const row = await this.getRunRow(runId);
    if (!row) throw new ManagedAgentRunNotFoundError(runId);
    return this.listEventsPage(row.agent_id, options, runId);
  }

  subscribe(agentId: string, listener: (event: ManagedAgentEvent) => void): () => void {
    return this.events.subscribe(agentId, listener);
  }

  async streamAgent(
    agentId: string,
    afterSequence: number,
    send: (event: ManagedAgentEvent) => void,
  ): Promise<() => void> {
    if (!(await this.getAgentRow(agentId))) throw new ManagedAgentNotFoundError(agentId);
    return this.streamEvents(agentId, afterSequence, (event) => event.agentId === agentId, send);
  }

  async streamRun(
    runId: string,
    afterSequence: number,
    send: (event: ManagedAgentEvent) => void,
  ): Promise<() => void> {
    const run = await this.getRunRow(runId);
    if (!run) throw new ManagedAgentRunNotFoundError(runId);
    return this.streamEvents(run.agent_id, afterSequence, (event) => event.runId === runId, send);
  }

  private async streamEvents(
    agentId: string,
    afterSequence: number,
    include: (event: ManagedAgentEvent) => boolean,
    send: (event: ManagedAgentEvent) => void,
  ): Promise<() => void> {
    let replaying = true;
    const buffered: ManagedAgentEvent[] = [];
    let lastSequence = afterSequence;
    const unsubscribe = this.subscribe(agentId, (event) => {
      if (!include(event)) return;
      if (replaying) {
        buffered.push(event);
        return;
      }
      if (event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      send(event);
    });

    try {
      let cursor = afterSequence;
      let page: { events: ManagedAgentEvent[]; nextSequence: number | null; hasMore: boolean };
      do {
        page = await this.listEventsPage(agentId, { afterSequence: cursor, limit: 100 });
        for (const event of page.events) {
          if (!include(event) || event.sequence <= lastSequence) continue;
          lastSequence = event.sequence;
          send(event);
        }
        if (page.hasMore && page.nextSequence !== null) cursor = page.nextSequence;
      } while (page.hasMore);
      replaying = false;
      buffered.sort((left, right) => left.sequence - right.sequence);
      for (const event of buffered) {
        if (event.sequence <= lastSequence) continue;
        lastSequence = event.sequence;
        send(event);
      }
      return unsubscribe;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  private async startRun(
    agent: AgentRow,
    runId: string,
    prompt: string,
    sessionOptions: CreatePiSessionOptions,
    attachments?: AgentImageAttachment[],
  ): Promise<void> {
    let session: ManagedPiSession;
    try {
      session = await this.sessionFactory.create(sessionOptions);
    } catch (error) {
      if (this.closed) return;
      await this.finalizeRunWithoutSession(
        agent.id,
        runId,
        'failed',
        { code: 'agent_start_failed', message: 'The Pi agent could not be created' },
        'supervisor.run_failed',
      );
      this.logger.error('Pi session creation failed', {
        agentId: agent.id,
        runId,
        error: sanitizeError(error),
      });
      return;
    }

    if (this.closed || this.stoppingAgents.has(agent.id)) {
      try {
        await session.abort();
      } catch {
        // Shutdown/deletion is already authoritative; disposal is still best effort.
      }
      await this.withTimeout(session.dispose(), this.shutdownTimeoutMs, `dispose session ${runId}`);
      if (this.closed) return;
      await this.finalizeRunWithoutSession(
        agent.id,
        runId,
        'failed',
        { code: 'agent_deleted', message: 'The agent was deleted before the run started' },
        'supervisor.run_failed',
      );
      return;
    }

    const active: ActiveRun = {
      runId,
      agentId: agent.id,
      session,
      operations: new Set(),
      generation: 1,
      settled: false,
      unsubscribed: false,
      unsubscribe: () => undefined,
    };
    active.unsubscribe = session.subscribe((event) => {
      this.enqueueSessionEvent(agent.id, runId, event);
    });
    this.activeRuns.set(runId, active);

    let resolvePreflight: (accepted: boolean) => void = () => undefined;
    const preflight = new Promise<boolean>((resolveResult) => {
      resolvePreflight = resolveResult;
    });
    let resolveRunAcceptance: (accepted: boolean) => void = () => undefined;
    const runAcceptance = new Promise<boolean>((resolveResult) => {
      resolveRunAcceptance = resolveResult;
    });
    const generation = active.generation;
    let operation: Promise<void>;
    try {
      operation = promptSession(session, prompt, attachments, resolvePreflight);
    } catch (error) {
      operation = Promise.reject(error);
    }
    this.launchOperation(active, operation, generation, runAcceptance);
    const accepted = await Promise.race([
      preflight,
      operation.then(
        () => false,
        () => false,
      ),
    ]);

    if (accepted && active.generation === generation) {
      const result = await this.db
        .updateTable('supervisor_agent_runs')
        .set({ status: 'running', started_at: this.now() })
        .where('id', '=', runId)
        .where('status', '=', 'queued')
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) > 0) {
        resolveRunAcceptance(true);
        await this.enqueueCustomEvent(agent.id, runId, 'supervisor.prompt_accepted', {});
        return;
      }
    }

    resolveRunAcceptance(false);
    if (accepted) return;
    await this.finalizeRun(
      agent.id,
      runId,
      'failed',
      { code: 'prompt_rejected', message: 'The Pi agent rejected the prompt before execution' },
      'supervisor.prompt_rejected',
    );
    await this.disposeActiveRun(active);
  }

  private launchOperation(
    active: ActiveRun,
    operation: Promise<void>,
    generation: number,
    runAcceptance?: Promise<boolean>,
  ): void {
    const tracked = operation
      .then(async () => {
        if (runAcceptance && !(await runAcceptance)) return;
        if (active.generation !== generation) return;
        const won = await this.completeRun(active, generation);
        if (won) active.settled = true;
      })
      .catch(async (error: unknown) => {
        if (runAcceptance && !(await runAcceptance)) return;
        if (active.generation !== generation) return;
        const won = await this.finalizeRun(
          active.agentId,
          active.runId,
          'failed',
          { code: 'agent_operation_failed', message: 'The Pi agent operation failed' },
          'supervisor.run_failed',
        );
        this.logger.error('Pi agent operation failed', {
          agentId: active.agentId,
          runId: active.runId,
          error: sanitizeError(error),
        });
        if (won) {
          active.settled = true;
          await this.disposeActiveRun(active);
        }
      })
      .finally(async () => {
        if (runAcceptance && !(await runAcceptance)) await this.disposeActiveRun(active);
      });
    active.operations.add(tracked);
    void tracked
      .finally(() => active.operations.delete(tracked))
      .catch((error: unknown) => {
        this.logger.error('Could not finalize Pi agent operation', {
          agentId: active.agentId,
          runId: active.runId,
          error: sanitizeError(error),
        });
      });
  }

  private enqueueSessionEvent(agentId: string, runId: string, rawEvent: unknown): void {
    void this.enqueueEventWork(agentId, async () => {
      const event = normalizeSessionEvent(rawEvent, this.eventPayloadLimits);
      await this.persistEvent(
        agentId,
        runId,
        event.truncated ? 'supervisor.event_truncated' : event.type,
        event.truncated
          ? {
              originalType: event.type,
              reason: event.truncated,
              maxBytes: this.eventPayloadLimits.maxBytes,
            }
          : event.payload,
      );
    });
  }

  private async enqueueCustomEvent(
    agentId: string,
    runId: string | null,
    type: string,
    payload: JsonObject,
  ): Promise<void> {
    await this.enqueueEventWork(agentId, async () => {
      await this.persistEvent(agentId, runId, type, payload);
    });
  }

  private enqueueEventWork<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.eventTails.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(work)
      .catch((error: unknown) => {
        this.logger.error('Could not persist Pi agent event', {
          agentId,
          error: sanitizeError(error),
        });
        throw error;
      });
    this.eventTails.set(agentId, next);
    void next
      .finally(() => {
        if (this.eventTails.get(agentId) === next) this.eventTails.delete(agentId);
      })
      .catch(() => undefined);
    return next;
  }

  private async waitForEvents(agentId: string): Promise<void> {
    await this.eventTails.get(agentId)?.catch(() => undefined);
  }

  private async persistEvent(
    agentId: string,
    runId: string | null,
    eventType: string,
    payload: JsonValue,
  ): Promise<void> {
    const persisted = await withBusyRetry(() =>
      this.db.transaction().execute(async (transaction) => {
        const row = await transaction
          .selectFrom('supervisor_agents')
          .select('id')
          .where('id', '=', agentId)
          .executeTakeFirst();
        if (!row) throw new ManagedAgentNotFoundError(agentId);
        if (runId !== null) {
          const run = await transaction
            .selectFrom('supervisor_agent_runs')
            .select('id')
            .where('id', '=', runId)
            .where('agent_id', '=', agentId)
            .executeTakeFirst();
          if (!run) throw new ManagedAgentRunNotFoundError(runId);
        }
        return this.insertEvent(transaction, agentId, runId, eventType, payload);
      }),
    );
    this.events.publish(persisted);
  }

  private async insertEvent(
    transaction: Transaction<SupervisorDatabase>,
    agentId: string,
    runId: string | null,
    eventType: string,
    payload: JsonValue,
  ): Promise<ManagedAgentEvent> {
    const sequenceRow = await transaction
      .selectFrom('supervisor_agent_events')
      .select('sequence')
      .where('agent_id', '=', agentId)
      .orderBy('sequence', 'desc')
      .limit(1)
      .executeTakeFirst();
    const event: ManagedAgentEvent = {
      agentId,
      runId,
      sequence: (sequenceRow?.sequence ?? 0) + 1,
      type: eventType,
      payload,
      createdAt: this.now(),
    };
    await transaction
      .insertInto('supervisor_agent_events')
      .values({
        agent_id: agentId,
        run_id: runId,
        sequence: event.sequence,
        event_type: event.type,
        payload_json: encodeJson(event.payload),
        created_at: event.createdAt,
      })
      .execute();
    return event;
  }

  private async beginReceipt(
    agentId: string,
    commandType: 'create' | 'prompt' | 'abort' | 'run_create' | 'steer' | 'follow_up' | 'cancel',
    idempotencyKey: string | undefined,
    request: unknown,
  ): Promise<{ id?: string; result?: unknown }> {
    if (!idempotencyKey) return {};
    const digest = requestDigest(request);
    const id = this.idFactory();
    const now = this.now();
    try {
      await this.db
        .insertInto('supervisor_agent_command_receipts')
        .values({
          id,
          idempotency_key: idempotencyKey,
          agent_id: agentId,
          command_type: commandType,
          request_digest: digest,
          status: 'pending',
          result_json: null,
          error_code: null,
          error_message: null,
          http_status: null,
          created_at: now,
          updated_at: now,
          completed_at: null,
        })
        .execute();
      return { id };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await this.db
        .selectFrom('supervisor_agent_command_receipts')
        .selectAll()
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (!existing || existing.request_digest !== digest) {
        throw new ManagedAgentIdempotencyConflictError(idempotencyKey);
      }
      if (existing.status === 'pending') {
        throw new ManagedAgentCommandInProgressError(idempotencyKey);
      }
      if (existing.status === 'succeeded' && existing.result_json) {
        return { id: existing.id, result: decodeJson(existing.result_json) };
      }
      throw new ManagedAgentCommandReplayError(
        existing.error_code ?? 'internal_error',
        existing.error_message ?? 'The original command failed',
      );
    }
  }

  private async completeReceipt(receiptId: string, result: ManagedAgentRunResponse): Promise<void> {
    const now = this.now();
    await this.db
      .updateTable('supervisor_agent_command_receipts')
      .set({
        status: 'succeeded',
        result_json: encodeJson(JSON.parse(JSON.stringify(result)) as JsonValue),
        updated_at: now,
        completed_at: now,
        http_status: 200,
        error_code: null,
        error_message: null,
      })
      .where('id', '=', receiptId)
      .where('status', '=', 'pending')
      .execute();
  }

  private async failReceipt(receiptId: string, error: unknown): Promise<void> {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'internal_error';
    const message = error instanceof Error ? error.message : 'The command failed';
    const now = this.now();
    await this.db
      .updateTable('supervisor_agent_command_receipts')
      .set({
        status: 'failed',
        result_json: null,
        error_code: code,
        error_message: message,
        updated_at: now,
        completed_at: now,
        http_status: code === 'not_found' ? 404 : code === 'agent_busy' ? 409 : 500,
      })
      .where('id', '=', receiptId)
      .where('status', '=', 'pending')
      .execute();
  }

  private async requireActiveRun(
    runId: string,
    options: { allowCompleted?: boolean } = {},
  ): Promise<ActiveRun> {
    const row = await this.getRunRow(runId);
    if (!row) throw new ManagedAgentRunNotFoundError(runId);
    const status = ManagedAgentRunStatusSchema.parse(row.status);
    if (isTerminalRunStatus(status) && !(options.allowCompleted && status === 'completed')) {
      throw new ManagedAgentBusyError(row.agent_id, `Run ${runId} is no longer active`);
    }
    const active = this.activeRuns.get(runId);
    if (!active)
      throw new ManagedAgentNotAvailableError(row.agent_id, `Run ${runId} is unavailable`);
    return active;
  }

  private async markRunRunning(runId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('supervisor_agent_runs')
      .set({
        status: 'running',
        started_at: this.now(),
        completed_at: null,
        error_code: null,
        error_message: null,
      })
      .where('id', '=', runId)
      .where('status', '=', 'completed')
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  private async disposeActiveRun(active: ActiveRun): Promise<void> {
    if (active.disposePromise) return active.disposePromise;
    active.disposePromise = (async () => {
      if (this.activeRuns.get(active.runId) === active) {
        if (!active.unsubscribed) {
          active.unsubscribed = true;
          active.unsubscribe();
        }
        this.activeRuns.delete(active.runId);
      }
      await this.withTimeout(
        active.session.dispose(),
        this.shutdownTimeoutMs,
        `dispose session ${active.runId}`,
      );
    })();
    return active.disposePromise;
  }

  private async completeRun(active: ActiveRun, generation: number): Promise<boolean> {
    if (active.generation !== generation) return false;
    await this.waitForEvents(active.agentId);
    return this.finalizeRun(
      active.agentId,
      active.runId,
      'completed',
      undefined,
      'supervisor.run_completed',
    );
  }

  private async finalizeRunWithoutSession(
    agentId: string,
    runId: string,
    status: Extract<ManagedAgentRunStatus, 'failed' | 'cancelled'>,
    error: { code: string; message: string },
    eventType: string,
  ): Promise<boolean> {
    return this.finalizeRun(agentId, runId, status, error, eventType);
  }

  /**
   * Compare-and-set the row and append the authoritative terminal event in
   * one transaction. Callers must drain the session event tail first.
   */
  private async finalizeRun(
    agentId: string,
    runId: string,
    status: Extract<ManagedAgentRunStatus, 'completed' | 'failed' | 'cancelled'>,
    error: { code: string; message: string } | undefined,
    eventType: string,
  ): Promise<boolean> {
    // Put the terminal transaction at the end of the same per-agent event
    // fence. This makes observing the last SDK event a safe point: once the
    // event tail is drained, status and the authoritative terminal event have
    // committed together.
    return this.enqueueEventWork(agentId, async () => {
      const persisted = await withBusyRetry(() =>
        this.db.transaction().execute(async (transaction) => {
          const result = await transaction
            .updateTable('supervisor_agent_runs')
            .set({
              status,
              error_code: error?.code ?? null,
              error_message: error?.message ?? null,
              completed_at: this.now(),
            })
            .where('id', '=', runId)
            .where('agent_id', '=', agentId)
            .where('status', 'in', ['queued', 'running'])
            .executeTakeFirst();
          if (Number(result.numUpdatedRows) === 0) return undefined;
          return this.insertEvent(
            transaction,
            agentId,
            runId,
            eventType,
            error ? { code: error.code, message: error.message } : {},
          );
        }),
      );
      if (persisted) this.events.publish(persisted);
      return persisted !== undefined;
    });
  }

  private assertMutable(): void {
    if (this.closed) throw new Error('managed_agent_service_closed');
  }

  private async tryAbort(active: ActiveRun, reason: string): Promise<void> {
    try {
      await this.withTimeout(
        active.session.abort(),
        this.operationTimeoutMs,
        `abort ${active.runId}`,
      );
    } catch (error) {
      this.logger.warn('Pi session did not abort cleanly', {
        agentId: active.agentId,
        runId: active.runId,
        reason,
        error: sanitizeError(error),
      });
    }
  }

  private async waitForOperations(active: ActiveRun, reason: string): Promise<void> {
    try {
      await this.withTimeout(
        Promise.allSettled([...active.operations]).then(() => undefined),
        this.operationTimeoutMs,
        `operations for ${active.runId}`,
      );
    } catch (error) {
      this.logger.warn('Pi session operations did not stop cleanly', {
        agentId: active.agentId,
        runId: active.runId,
        reason,
        error: sanitizeError(error),
      });
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    description: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timeout waiting for ${description}`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async requireRun(runId: string): Promise<ManagedAgentRunResponse> {
    const row = await this.getRunRow(runId);
    if (!row) throw new ManagedAgentRunNotFoundError(runId);
    return this.toRunResponse(row);
  }

  private async getRunRow(runId: string): Promise<AgentRunRow | undefined> {
    return this.db
      .selectFrom('supervisor_agent_runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();
  }

  private toRunAttachment(row: AgentRunAttachmentRow): AgentImageAttachment {
    return AgentImageAttachmentSchema.parse({
      name: row.name,
      mimeType: row.mime_type,
      data: row.data,
    });
  }

  private toRunResponse(row: AgentRunRow): ManagedAgentRunResponse {
    return ManagedAgentRunResponseSchema.parse({
      id: row.id,
      agentId: row.agent_id,
      prompt: row.prompt,
      model:
        row.model_provider && row.model_id
          ? { provider: row.model_provider, id: row.model_id }
          : null,
      thinkingLevel: row.thinking_level,
      cwd: row.cwd,
      status: row.status,
      error:
        row.error_code === null || row.error_message === null
          ? null
          : { code: row.error_code, message: row.error_message },
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    });
  }

  private async requireAgent(agentId: string): Promise<ManagedAgentResponse> {
    const row = await this.getAgentRow(agentId);
    if (!row) throw new ManagedAgentNotFoundError(agentId);
    return this.toResponse(row);
  }

  private async getAgentRow(agentId: string): Promise<AgentRow | undefined> {
    return this.db
      .selectFrom('supervisor_agents')
      .selectAll()
      .where('id', '=', agentId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
  }

  private toResponse(row: AgentRow): ManagedAgentResponse {
    return ManagedAgentResponseSchema.parse({
      id: row.id,
      name: row.name,
      systemPrompt: row.system_prompt,
      model:
        row.requested_model_provider && row.requested_model_id
          ? { provider: row.requested_model_provider, id: row.requested_model_id }
          : null,
      thinkingLevel: row.thinking_level,
      cwd: row.cwd,
      tools: decodeTools(row.tools_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private usesLegacyAgentRuntimeColumns(): Promise<boolean> {
    this.legacyAgentStatusColumn ??= sql<{ name: string }>`PRAGMA table_info(supervisor_agents)`
      .execute(this.db)
      .then((result) => result.rows.some((column) => column.name === 'status'));
    return this.legacyAgentStatusColumn;
  }

  private async serializeRunCommand<T>(runId: string, command: () => Promise<T>): Promise<T> {
    const row = await this.getRunRow(runId);
    if (!row) throw new ManagedAgentRunNotFoundError(runId);
    return this.serializeCommand(`agent:${row.agent_id}`, command);
  }

  private async serializeCommand<T>(key: string, command: () => Promise<T>): Promise<T> {
    const previous = this.commandTails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const current = previous.catch(() => undefined).then(() => gate);
    this.commandTails.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await command();
    } finally {
      release();
      if (this.commandTails.get(key) === current) this.commandTails.delete(key);
    }
  }
}

function toPiImages(attachments: AgentImageAttachment[] | undefined): PiImageContent[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((attachment) => ({
    type: 'image' as const,
    data: attachment.data,
    mimeType: attachment.mimeType,
  }));
}

function promptSession(
  session: ManagedPiSession,
  message: string,
  attachments?: AgentImageAttachment[],
  preflightResult?: (success: boolean) => void,
): Promise<void> {
  const options: Parameters<ManagedPiSession['prompt']>[1] = {
    ...(preflightResult ? { preflightResult } : {}),
  };
  const images = toPiImages(attachments);
  if (images) options.images = images;
  return session.prompt(message, options);
}

function createSessionOptions(
  row: AgentRow,
  request: CreateManagedAgentRunRequest,
): CreatePiSessionOptions {
  const tools = decodeTools(row.tools_json);
  const model =
    request.model ??
    (row.requested_model_provider && row.requested_model_id
      ? { provider: row.requested_model_provider, id: row.requested_model_id }
      : null);
  const thinkingLevel =
    request.thinkingLevel ??
    (row.thinking_level ? (row.thinking_level as AgentThinkingLevel) : null);
  return {
    systemPrompt: row.system_prompt,
    cwd: resolveWorkingDirectory(request.cwd ?? row.cwd),
    ...(tools === null ? {} : { tools }),
    ...(model === null ? {} : { model }),
    ...(thinkingLevel === null ? {} : { thinkingLevel }),
  };
}

function toEvent(row: {
  agent_id: string;
  run_id: string | null;
  sequence: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}): ManagedAgentEvent {
  return {
    agentId: row.agent_id,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.event_type,
    payload: decodeJson(row.payload_json),
    createdAt: row.created_at,
  };
}

function isTerminalRunStatus(status: ManagedAgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function decodeTools(value: string | null): AgentToolName[] | null {
  if (value === null) return null;
  return decodeJson(value) as AgentToolName[];
}

function normalizeSessionEvent(
  rawEvent: unknown,
  limits: EventPayloadLimits,
): { type: string; payload: JsonValue; truncated?: string } {
  const state: PayloadState = { items: 0, truncated: undefined };
  if (typeof rawEvent !== 'object' || rawEvent === null || Array.isArray(rawEvent)) {
    const payload = toJsonValue(rawEvent, state, limits, new WeakSet<object>(), 0);
    return {
      type: 'unknown',
      payload,
      ...(state.truncated ? { truncated: state.truncated } : {}),
    };
  }
  const record = rawEvent as Record<string, unknown>;
  const type = typeof record.type === 'string' && record.type.length > 0 ? record.type : 'unknown';
  const payload: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'type') payload[key] = toJsonValue(value, state, limits, new WeakSet<object>(), 0);
  }
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, 'utf8') > limits.maxBytes) state.truncated ??= 'payload_bytes';
  return { type, payload, ...(state.truncated ? { truncated: state.truncated } : {}) };
}

interface PayloadState {
  items: number;
  truncated: string | undefined;
}

function toJsonValue(
  value: unknown,
  state: PayloadState,
  limits: EventPayloadLimits,
  seen: WeakSet<object>,
  depth: number,
): JsonValue {
  if (state.items >= limits.maxItems) {
    state.truncated ??= 'payload_items';
    return '[truncated]';
  }
  state.items += 1;
  if (depth > limits.maxDepth) {
    state.truncated ??= 'payload_depth';
    return '[truncated]';
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') <= limits.maxBytes) return value;
    state.truncated ??= 'payload_bytes';
    return `${value.slice(0, Math.max(0, limits.maxBytes / 4))}…[truncated]`;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return null;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return sanitizeError(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonValue(entry, state, limits, seen, depth + 1));
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = toJsonValue(entry, state, limits, seen, depth + 1);
  }
  return result;
}

function sanitizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message.slice(0, 500) };
  return { name: 'UnknownError', message: 'Unknown error' };
}

function requestDigest(request: unknown): string {
  return createHash('sha256').update(stableJson(request)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      String((error as { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')) ||
    (error instanceof Error && /unique constraint|UNIQUE constraint/i.test(error.message))
  );
}

function commandError(agentId: string, error: unknown): ManagedAgentNotAvailableError {
  return new ManagedAgentNotAvailableError(agentId, sanitizeError(error).message);
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | undefined {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      'createdAt' in decoded &&
      'id' in decoded &&
      typeof decoded.createdAt === 'string' &&
      typeof decoded.id === 'string' &&
      decoded.createdAt.length > 0 &&
      decoded.id.length > 0
    ) {
      return { createdAt: decoded.createdAt, id: decoded.id };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
