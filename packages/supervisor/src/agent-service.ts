import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

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
  ErrorCodeSchema,
  encodeJson,
  type JsonObject,
  type JsonValue,
  type ManagedAgentCommandReceipt,
  ManagedAgentCommandReceiptSchema,
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

export interface EventQueueLimits {
  readonly maxCount: number;
  readonly maxBytes: number;
}

export type SupervisorWriteClass = 'admission' | 'event' | 'terminal';

export type SupervisorLifecyclePhase =
  | 'before_run_insert'
  | 'after_queued_commit'
  | 'after_session_identity_commit'
  | 'after_prompt_preflight'
  | 'after_running_commit'
  | 'during_event_write'
  | 'after_provider_completion'
  | 'during_graceful_shutdown';

interface EventQueueState {
  tail: Promise<unknown>;
  count: number;
  bytes: number;
}

interface ActiveRun {
  readonly runId: string;
  readonly agentId: string;
  readonly session: ManagedPiSession;
  readonly operations: Set<Promise<void>>;
  generation: number;
  settled: boolean;
  acceptingEvents: boolean;
  persistenceFailure?: Promise<void>;
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

export class ManagedAgentCommandOutcomeUnknownError extends Error {
  readonly code = 'command_outcome_unknown';

  constructor(readonly runId: string) {
    super(`The outcome of run ${runId} is unknown because durable state could not be persisted`);
    this.name = 'ManagedAgentCommandOutcomeUnknownError';
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

class EventBackpressureError extends Error {
  constructor(
    readonly queuedCount: number,
    readonly queuedBytes: number,
  ) {
    super('event_backpressure_exceeded');
    this.name = 'EventBackpressureError';
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
  readonly eventQueueLimits?: Partial<EventQueueLimits>;
  /** Optional explicit retention policy; undefined retains full history. */
  readonly eventRetentionDays?: number;
  /** Test/integration fault boundary. Throw to simulate a failed durable write. */
  readonly writeFaultInjector?: (writeClass: SupervisorWriteClass) => void | Promise<void>;
  /** Test fixture observer for deterministic process-kill boundaries. */
  readonly lifecycleObserver?: (
    phase: SupervisorLifecyclePhase,
    runId?: string,
  ) => void | Promise<void>;
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
  private readonly eventQueueLimits: EventQueueLimits;
  private readonly eventRetentionDays: number | undefined;
  private readonly writeFaultInjector:
    | ((writeClass: SupervisorWriteClass) => void | Promise<void>)
    | undefined;
  private readonly lifecycleObserver:
    | ((phase: SupervisorLifecyclePhase, runId?: string) => void | Promise<void>)
    | undefined;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly eventQueues = new Map<string, EventQueueState>();
  private readonly commandTails = new Map<string, Promise<void>>();
  private readonly startTasks = new Map<string, { agentId: string; task: Promise<void> }>();
  private readonly stoppingAgents = new Set<string>();
  /** Runs whose terminal state could not be persisted; fail closed in-process. */
  private readonly degradedRuns = new Map<string, { agentId: string }>();
  private readonly instanceId: string;
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
    this.instanceId = randomUUID();
    this.projectService =
      options.projectService ?? new ProjectService({ db: options.db, now: this.now });
    this.shutdownTimeoutMs = Math.max(1, options.shutdownTimeoutMs ?? 5_000);
    this.operationTimeoutMs = Math.max(1, options.operationTimeoutMs ?? this.shutdownTimeoutMs);
    this.eventPayloadLimits = {
      maxBytes: Math.max(1, options.eventPayloadLimits?.maxBytes ?? 256_000),
      maxDepth: Math.max(1, options.eventPayloadLimits?.maxDepth ?? 16),
      maxItems: Math.max(1, options.eventPayloadLimits?.maxItems ?? 10_000),
    };
    this.eventQueueLimits = {
      maxCount: Math.max(1, options.eventQueueLimits?.maxCount ?? 1_000),
      maxBytes: Math.max(1, options.eventQueueLimits?.maxBytes ?? 8_000_000),
    };
    this.eventRetentionDays =
      options.eventRetentionDays === undefined
        ? undefined
        : Math.max(1, Math.floor(options.eventRetentionDays));
    this.writeFaultInjector = options.writeFaultInjector;
    this.lifecycleObserver = options.lifecycleObserver;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.closed) throw new Error('managed_agent_service_closed');
    this.started = true;
    await this.projectService.initialize();
    await this.markStaleReceiptsIndeterminate();
    await this.compactEventsIfConfigured();

    // Pi cannot reattach an in-flight provider request after process death. We
    // never replay it. Its saved session remains usable for an explicit later
    // continuation, while completed sessions are reconstructed below.
    const interrupted = await this.db
      .selectFrom('supervisor_agent_runs')
      .selectAll()
      .where('status', 'in', ['queued', 'running'])
      .execute();
    for (const run of interrupted) {
      await this.tryFinalizeRun(
        run.agent_id,
        run.id,
        'failed',
        {
          code: run.pi_session_id ? 'run_interrupted' : 'supervisor_restarted',
          message: 'The run was interrupted when the Supervisor restarted and was not replayed',
        },
        'supervisor.run_failed',
      );
    }

    if (this.sessionFactory.resume) {
      const recoverable = await this.db
        .selectFrom('supervisor_agent_runs')
        .innerJoin('supervisor_agents', 'supervisor_agents.id', 'supervisor_agent_runs.agent_id')
        .select([
          'supervisor_agent_runs.id as run_id',
          'supervisor_agent_runs.agent_id',
          'supervisor_agent_runs.cwd',
          'supervisor_agent_runs.pi_session_id',
          'supervisor_agent_runs.pi_session_file',
          'supervisor_agents.system_prompt',
          'supervisor_agents.system_prompt_mode',
          'supervisor_agents.tools_json',
        ])
        .where('supervisor_agent_runs.status', '=', 'completed')
        .where('supervisor_agent_runs.pi_session_id', 'is not', null)
        .where('supervisor_agent_runs.pi_session_file', 'is not', null)
        .execute();
      for (const row of recoverable) {
        try {
          const sessionId = row.pi_session_id;
          const sessionFile = row.pi_session_file;
          if (!sessionId || !sessionFile) continue;
          const session = await this.sessionFactory.resume({
            sessionId,
            sessionFile,
            cwd: row.cwd,
            systemPrompt: row.system_prompt,
            systemPromptMode: row.system_prompt_mode,
            ...(row.tools_json ? { tools: decodeJson(row.tools_json) as AgentToolName[] } : {}),
          });
          this.attachRecoveredSession(row.run_id, row.agent_id, session);
          await this.db
            .updateTable('supervisor_agent_runs')
            .set({
              pi_owner_instance: this.instanceId,
              pi_recovery_state: 'recovered',
              pi_recovered_at: this.now(),
            })
            .where('id', '=', row.run_id)
            .execute();
        } catch (error) {
          await this.db
            .updateTable('supervisor_agent_runs')
            .set({ pi_recovery_state: 'unavailable', pi_recovered_at: this.now() })
            .where('id', '=', row.run_id)
            .execute();
          this.logger.warn('Pi session recovery failed', {
            agentId: row.agent_id,
            runId: row.run_id,
            error: sanitizeError(error),
          });
        }
      }
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
    await this.observeLifecycle('during_graceful_shutdown');
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
    for (const agentId of new Set([...this.eventQueues.keys()])) {
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
    this.eventQueues.clear();
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
          id, name, status, system_prompt, system_prompt_mode, cwd, tools_json,
          requested_model_provider, requested_model_id, model_provider, model_id,
          thinking_level, pi_session_id, pi_session_file, message_count,
          pending_message_count, error_code, error_message, created_at, updated_at, disposed_at
        ) VALUES (
          ${id}, ${name}, 'defined', ${request.systemPrompt}, ${request.systemPromptMode}, ${cwd}, ${toolsJson},
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
          system_prompt_mode: request.systemPromptMode,
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
    if (request.parentRunId && !(await this.getRunRow(request.parentRunId))) {
      throw new ManagedAgentRunNotFoundError(request.parentRunId);
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
      if (receipt.id) await this.settleReceiptAfterFailure(receipt.id, error);
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
      if (existing) {
        this.assertRunHealthy(existing.id);
        throw new ManagedAgentBusyError(agent.id);
      }

      const workspace = await this.resolveRunWorkspace(request);
      const admittedRequest = workspace ? { ...request, cwd: workspace.path } : request;
      const sessionOptions = createSessionOptions(agent, admittedRequest);
      if (!workspace) await this.projectService.touchPath(sessionOptions.cwd ?? this.defaultCwd);
      const runId = this.idFactory();
      const createdAt = this.now();
      try {
        await this.observeLifecycle('before_run_insert', runId);
        await this.injectWriteFault('admission');
        await this.db.transaction().execute(async (transaction) => {
          if (workspace) {
            const claimed = await transaction
              .updateTable('supervisor_worktrees')
              .set({ status: 'busy', error: null, updated_at: createdAt })
              .where('id', '=', workspace.id)
              .where('status', '=', 'ready')
              .executeTakeFirst();
            if (Number(claimed.numUpdatedRows) !== 1) {
              throw new ManagedAgentNotAvailableError(
                agent.id,
                `Worktree ${workspace.id} is no longer ready`,
              );
            }
          }
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
              execution_mode: admittedRequest.executionMode ?? 'local',
              worktree_id: admittedRequest.worktreeId ?? null,
              parent_run_id: admittedRequest.parentRunId ?? null,
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
        await this.observeLifecycle('after_queued_commit', runId);
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
      this.assertRunHealthy(runId);
      return this.requireRun(runId);
    });
  }

  private async resolveRunWorkspace(
    request: CreateManagedAgentRunRequest,
  ): Promise<{ id: string; path: string } | undefined> {
    const mode = request.executionMode ?? 'local';
    if (mode === 'local') {
      if (request.worktreeId) {
        throw new ManagedAgentNotAvailableError(
          request.agentId,
          'Local execution cannot reference a worktree',
        );
      }
      return undefined;
    }
    if (!request.worktreeId) {
      throw new ManagedAgentNotAvailableError(
        request.agentId,
        'Worktree execution requires a worktree id',
      );
    }
    const worktree = await this.db
      .selectFrom('supervisor_worktrees')
      .select(['id', 'path', 'status'])
      .where('id', '=', request.worktreeId)
      .executeTakeFirst();
    if (worktree?.status !== 'ready') {
      throw new ManagedAgentNotAvailableError(
        request.agentId,
        `Worktree ${request.worktreeId} is not ready`,
      );
    }
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(resolveWorkingDirectory(worktree.path));
    } catch {
      throw new ManagedAgentNotAvailableError(
        request.agentId,
        `Worktree ${request.worktreeId} is not available on disk`,
      );
    }
    if (request.cwd) {
      let requestedPath: string;
      try {
        requestedPath = await realpath(resolveWorkingDirectory(request.cwd));
      } catch {
        throw new ManagedAgentNotAvailableError(
          request.agentId,
          'The requested worktree directory is not available on disk',
        );
      }
      if (requestedPath !== canonicalPath) {
        throw new ManagedAgentNotAvailableError(
          request.agentId,
          'The requested working directory does not match the selected worktree',
        );
      }
    }
    return { id: worktree.id, path: canonicalPath };
  }

  async getRun(runId: string): Promise<ManagedAgentRunResponse | null> {
    const row = await this.getRunRow(runId);
    return row ? this.toRunResponse(row) : null;
  }

  async getCommandReceipt(idempotencyKey: string): Promise<ManagedAgentCommandReceipt | null> {
    const row = await this.db
      .selectFrom('supervisor_agent_command_receipts')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (!row) return null;
    return ManagedAgentCommandReceiptSchema.parse({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      agentId: row.agent_id,
      command: row.command_type,
      status: row.status,
      result: row.result_json === null ? null : decodeJson(row.result_json),
      error:
        row.error_code === null || row.error_message === null
          ? null
          : {
              code: ErrorCodeSchema.safeParse(row.error_code).success
                ? row.error_code
                : 'internal_error',
              message: row.error_message,
            },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    });
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
    let query = this.db
      .selectFrom('supervisor_agent_runs')
      .selectAll('supervisor_agent_runs')
      .select((expression) =>
        expression
          .selectFrom('supervisor_agent_events as events')
          .select((events) => events.fn.max<number>('events.sequence').as('latest_event_sequence'))
          .whereRef('events.run_id', '=', 'supervisor_agent_runs.id')
          .as('latest_event_sequence'),
      );
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
      this.assertRunHealthy(runId);
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
          try {
            await this.waitForEvents(active.agentId);
          } catch (error) {
            if (active.persistenceFailure) {
              await active.persistenceFailure.catch(() => undefined);
              throw new ManagedAgentCommandOutcomeUnknownError(runId);
            }
            throw error;
          }
        }
        const won = await this.tryFinalizeRun(
          row.agent_id,
          runId,
          'cancelled',
          { code: 'run_cancelled', message: 'The run was cancelled by an operator' },
          'supervisor.run_cancelled',
        );
        if (!won) {
          if (active)
            await this.disposeActiveRunSafely(active, 'cancel terminal persistence failed');
          throw new ManagedAgentCommandOutcomeUnknownError(runId);
        }
        if (active) await this.disposeActiveRunSafely(active, 'cancel');
        const result = await this.requireRun(runId);
        if (receipt.id) {
          await this.completeReceipt(receipt.id, result);
          return { ...result, acknowledgementId: receipt.id };
        }
        return result;
      } catch (error) {
        if (receipt.id) await this.settleReceiptAfterFailure(receipt.id, error);
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
          ...(request.systemPromptMode === undefined
            ? {}
            : { system_prompt_mode: request.systemPromptMode }),
          ...(request.tools === undefined
            ? {}
            : { tools_json: request.tools === null ? null : encodeJson(request.tools) }),
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
          await this.tryFinalizeRun(
            agentId,
            active.runId,
            'cancelled',
            { code: 'agent_deleted', message: 'The agent profile was deleted' },
            'supervisor.run_cancelled',
          );
          await this.disposeActiveRunSafely(active, 'agent deletion');
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
          await this.tryFinalizeRun(
            agentId,
            active.runId,
            'cancelled',
            { code: 'agent_deleted', message: 'The agent profile was deleted' },
            'supervisor.run_cancelled',
          );
          await this.disposeActiveRunSafely(active, 'agent deletion');
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
        if (receipt.id) await this.settleReceiptAfterFailure(receipt.id, error);
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
        if (receipt.id) await this.settleReceiptAfterFailure(receipt.id, error);
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
  ): Promise<{
    events: ManagedAgentEvent[];
    nextSequence: number | null;
    previousSequence: number | null;
    hasMore: boolean;
  }> {
    await this.waitForEvents(agentId);
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    let query = this.db
      .selectFrom('supervisor_agent_events')
      .selectAll()
      .where('agent_id', '=', agentId);
    if (options.beforeSequence !== undefined) {
      query = query.where('sequence', '<', options.beforeSequence);
    } else {
      query = query.where('sequence', '>', options.afterSequence);
    }
    if (runId) query = query.where('run_id', '=', runId);
    const rows = await query
      .orderBy('sequence', options.beforeSequence === undefined ? 'asc' : 'desc')
      .limit(limit + 1)
      .execute();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const orderedPage = options.beforeSequence === undefined ? page : [...page].reverse();
    return {
      events: orderedPage.map(toEvent),
      nextSequence:
        options.beforeSequence === undefined && hasMore
          ? (orderedPage.at(-1)?.sequence ?? null)
          : null,
      previousSequence:
        options.beforeSequence !== undefined && hasMore ? (orderedPage[0]?.sequence ?? null) : null,
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
  ): Promise<{
    events: ManagedAgentEvent[];
    nextSequence: number | null;
    previousSequence: number | null;
    hasMore: boolean;
  }> {
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
      const finalized = await this.tryFinalizeRun(
        agent.id,
        runId,
        'failed',
        { code: 'agent_start_failed', message: 'The Pi agent could not be created' },
        'supervisor.run_failed',
        error,
      );
      this.logger.error('Pi session creation failed', {
        agentId: agent.id,
        runId,
        error: sanitizeError(error),
      });
      if (!finalized) throw new ManagedAgentCommandOutcomeUnknownError(runId);
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
      const finalized = await this.tryFinalizeRun(
        agent.id,
        runId,
        'failed',
        { code: 'agent_deleted', message: 'The agent was deleted before the run started' },
        'supervisor.run_failed',
      );
      if (!finalized) throw new ManagedAgentCommandOutcomeUnknownError(runId);
      return;
    }

    const active: ActiveRun = {
      runId,
      agentId: agent.id,
      session,
      operations: new Set(),
      generation: 1,
      settled: false,
      acceptingEvents: true,
      unsubscribed: false,
      unsubscribe: () => undefined,
    };
    active.unsubscribe = session.subscribe((event) => {
      if (active.acceptingEvents) this.enqueueSessionEvent(agent.id, runId, event);
    });
    this.activeRuns.set(runId, active);

    try {
      const sessionFile = session.sessionFile;
      if (!sessionFile) throw new Error('pi_session_file_unavailable');
      const identity = await withBusyRetry(() =>
        this.db
          .updateTable('supervisor_agent_runs')
          .set({
            pi_session_id: session.sessionId,
            pi_session_file: sessionFile,
            pi_owner_instance: this.instanceId,
            pi_recovery_state: 'owned',
          })
          .where('id', '=', runId)
          .where('status', '=', 'queued')
          .executeTakeFirst(),
      );
      if (Number(identity.numUpdatedRows) === 0) throw new Error('run_admission_race_lost');
      await this.observeLifecycle('after_session_identity_commit', runId);
    } catch (error) {
      const finalized = await this.compensateAdmissionFailure(active, error);
      if (!finalized) throw new ManagedAgentCommandOutcomeUnknownError(runId);
      return;
    }

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
    await this.observeLifecycle('after_prompt_preflight', runId);

    if (accepted && active.generation === generation) {
      try {
        const result = await withBusyRetry(() =>
          this.db
            .updateTable('supervisor_agent_runs')
            .set({ status: 'running', started_at: this.now() })
            .where('id', '=', runId)
            .where('status', '=', 'queued')
            .executeTakeFirst(),
        );
        if (Number(result.numUpdatedRows) === 0) throw new Error('run_admission_race_lost');
        await this.observeLifecycle('after_running_commit', runId);
        resolveRunAcceptance(true);
        await this.enqueueCustomEvent(agent.id, runId, 'supervisor.prompt_accepted', {});
        return;
      } catch (error) {
        resolveRunAcceptance(false);
        const finalized = await this.compensateAdmissionFailure(active, error);
        if (!finalized) throw new ManagedAgentCommandOutcomeUnknownError(runId);
        return;
      }
    }

    resolveRunAcceptance(false);
    if (accepted) return;
    const finalized = await this.tryFinalizeRun(
      agent.id,
      runId,
      'failed',
      { code: 'prompt_rejected', message: 'The Pi agent rejected the prompt before execution' },
      'supervisor.prompt_rejected',
    );
    await this.disposeActiveRunSafely(active, 'prompt rejected');
    if (!finalized) throw new ManagedAgentCommandOutcomeUnknownError(runId);
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
        else if (this.degradedRuns.has(active.runId)) {
          await this.disposeActiveRunSafely(active, 'terminal persistence failed');
        }
      })
      .catch(async (error: unknown) => {
        if (runAcceptance && !(await runAcceptance)) return;
        if (active.generation !== generation) return;
        const won = await this.tryFinalizeRun(
          active.agentId,
          active.runId,
          'failed',
          { code: 'agent_operation_failed', message: 'The Pi agent operation failed' },
          'supervisor.run_failed',
          error,
        );
        this.logger.error('Pi agent operation failed', {
          agentId: active.agentId,
          runId: active.runId,
          error: sanitizeError(error),
        });
        if (won) active.settled = true;
        await this.disposeActiveRunSafely(active, 'agent operation finished');
      })
      .finally(async () => {
        if (runAcceptance && !(await runAcceptance)) {
          await this.disposeActiveRunSafely(active, 'run admission rejected');
        }
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
    const event = normalizeSessionEvent(rawEvent, this.eventPayloadLimits);
    const queuedBytes = event.encodedBytes;
    void this.enqueueEventWork(agentId, queuedBytes, async () => {
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
    })
      .catch((error: unknown) => {
        if (error instanceof EventBackpressureError) {
          return this.handleEventBackpressure(runId, error);
        }
        throw error;
      })
      .catch((error: unknown) => this.handleEventPersistenceFailure(runId, error))
      .catch((error: unknown) => {
        this.logger.error('Could not persist terminal event failure state', {
          agentId,
          runId,
          error: sanitizeError(error),
        });
      });
  }

  private async enqueueCustomEvent(
    agentId: string,
    runId: string | null,
    type: string,
    payload: JsonObject,
  ): Promise<void> {
    await this.enqueueEventWork(
      agentId,
      Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      async () => {
        await this.persistEvent(agentId, runId, type, payload);
      },
    );
  }

  private enqueueEventWork<T>(
    agentId: string,
    queuedBytes: number,
    work: () => Promise<T>,
  ): Promise<T> {
    const current = this.eventQueues.get(agentId);
    const previous = current?.tail ?? Promise.resolve();
    const nextCount = (current?.count ?? 0) + 1;
    const nextBytes = (current?.bytes ?? 0) + queuedBytes;
    if (nextCount > this.eventQueueLimits.maxCount || nextBytes > this.eventQueueLimits.maxBytes) {
      return Promise.reject(new EventBackpressureError(nextCount, nextBytes));
    }
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
    const state: EventQueueState = { tail: next, count: nextCount, bytes: nextBytes };
    this.eventQueues.set(agentId, state);
    void next
      .finally(() => {
        const queued = this.eventQueues.get(agentId);
        if (!queued) return;
        queued.count -= 1;
        queued.bytes -= queuedBytes;
        if (queued.count === 0) this.eventQueues.delete(agentId);
      })
      .catch(() => undefined);
    return next;
  }

  private async waitForEvents(agentId: string): Promise<void> {
    await this.eventQueues.get(agentId)?.tail;
  }

  private handleEventBackpressure(runId: string, cause: EventBackpressureError): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) return Promise.resolve();
    active.persistenceFailure ??= (async () => {
      active.generation += 1;
      active.acceptingEvents = false;
      active.unsubscribe();
      active.unsubscribed = true;
      await this.tryAbort(active, 'event ingestion backpressure');
      await this.waitForOperations(active, 'event ingestion backpressure');
      await this.waitForEvents(active.agentId).catch(() => undefined);
      const finalized = await this.tryFinalizeRun(
        active.agentId,
        active.runId,
        'failed',
        {
          code: 'event_backpressure_exceeded',
          message: 'Durable event ingestion could not keep up with the provider stream',
        },
        'supervisor.event_backpressure_exceeded',
        cause,
      );
      await this.disposeActiveRunSafely(active, 'event ingestion backpressure');
      this.logger.error('Run stopped after event ingestion backpressure', {
        agentId: active.agentId,
        runId,
        queuedCount: cause.queuedCount,
        queuedBytes: cause.queuedBytes,
        ...(finalized ? {} : { degraded: true }),
      });
    })();
    return active.persistenceFailure;
  }

  private attachRecoveredSession(runId: string, agentId: string, session: ManagedPiSession): void {
    const active: ActiveRun = {
      runId,
      agentId,
      session,
      operations: new Set(),
      generation: 1,
      settled: true,
      acceptingEvents: true,
      unsubscribed: false,
      unsubscribe: () => undefined,
    };
    active.unsubscribe = session.subscribe((event) => {
      if (active.acceptingEvents) this.enqueueSessionEvent(agentId, runId, event);
    });
    this.activeRuns.set(runId, active);
  }

  private async compensateAdmissionFailure(active: ActiveRun, cause: unknown): Promise<boolean> {
    active.generation += 1;
    active.acceptingEvents = false;
    await this.tryAbort(active, 'admission persistence failure');
    await this.waitForOperations(active, 'admission persistence failure');
    await this.waitForEvents(active.agentId).catch(() => undefined);
    const finalized = await this.tryFinalizeRun(
      active.agentId,
      active.runId,
      'failed',
      {
        code: 'run_admission_persistence_failed',
        message: 'The run could not be admitted durably',
      },
      'supervisor.run_failed',
      cause,
    );
    await this.disposeActiveRunSafely(active, 'admission persistence failure');
    this.logger.error('Run admission persistence failed', {
      agentId: active.agentId,
      runId: active.runId,
      error: sanitizeError(cause),
      ...(finalized ? {} : { degraded: true }),
    });
    return finalized;
  }

  private handleEventPersistenceFailure(runId: string, cause: unknown): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) return Promise.resolve();
    active.persistenceFailure ??= (async () => {
      active.generation += 1;
      active.acceptingEvents = false;
      await this.tryAbort(active, 'event persistence failure');
      await this.waitForOperations(active, 'event persistence failure');
      await this.waitForEvents(active.agentId).catch(() => undefined);
      const finalized = await this.tryFinalizeRun(
        active.agentId,
        active.runId,
        'failed',
        { code: 'event_persistence_failed', message: 'Durable event persistence failed' },
        'supervisor.run_failed',
        cause,
      );
      await this.disposeActiveRunSafely(active, 'event persistence failure');
      this.logger.error('Run stopped after durable event persistence failure', {
        agentId: active.agentId,
        runId: active.runId,
        error: sanitizeError(cause),
        ...(finalized ? {} : { degraded: true }),
      });
    })();
    return active.persistenceFailure;
  }

  private async persistEvent(
    agentId: string,
    runId: string | null,
    eventType: string,
    payload: JsonValue,
  ): Promise<void> {
    await this.observeLifecycle('during_event_write', runId ?? undefined);
    await this.injectWriteFault('event');
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

  private async markStaleReceiptsIndeterminate(): Promise<void> {
    const now = this.now();
    await withBusyRetry(() =>
      this.db
        .updateTable('supervisor_agent_command_receipts')
        .set({
          status: 'indeterminate',
          result_json: null,
          error_code: 'command_outcome_unknown',
          error_message: 'The command was in progress when the Supervisor restarted',
          updated_at: now,
          completed_at: now,
          http_status: 409,
        })
        .where('status', '=', 'pending')
        .execute(),
    );
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
    await withBusyRetry(() =>
      this.db
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
        .execute(),
    );
  }

  private async markReceiptIndeterminate(receiptId: string): Promise<void> {
    const now = this.now();
    await withBusyRetry(() =>
      this.db
        .updateTable('supervisor_agent_command_receipts')
        .set({
          status: 'indeterminate',
          result_json: null,
          error_code: 'command_outcome_unknown',
          error_message: 'The command outcome could not be durably determined',
          updated_at: now,
          completed_at: now,
          http_status: 409,
        })
        .where('id', '=', receiptId)
        .where('status', '=', 'pending')
        .execute(),
    );
  }

  private async settleReceiptAfterFailure(receiptId: string, error: unknown): Promise<void> {
    if (error instanceof ManagedAgentCommandOutcomeUnknownError) {
      await this.markReceiptIndeterminate(receiptId);
    } else {
      await this.failReceipt(receiptId, error);
    }
  }

  private async requireActiveRun(
    runId: string,
    options: { allowCompleted?: boolean } = {},
  ): Promise<ActiveRun> {
    const row = await this.getRunRow(runId);
    if (!row) throw new ManagedAgentRunNotFoundError(runId);
    this.assertRunHealthy(runId);
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
    try {
      await this.waitForEvents(active.agentId);
    } catch {
      // The event failure path owns aborting and terminalizing this run. A
      // provider completion racing it must not surface the same write error or
      // publish a successful terminal state.
      return false;
    }
    await this.observeLifecycle('after_provider_completion', active.runId);
    return this.tryFinalizeRun(
      active.agentId,
      active.runId,
      'completed',
      undefined,
      'supervisor.run_completed',
    );
  }

  /**
   * Terminal persistence is a separate failure boundary from SDK cleanup. If
   * it fails, the run must remain blocked in this process rather than being
   * allowed to look completed or accept another paid command.
   */
  private async tryFinalizeRun(
    agentId: string,
    runId: string,
    status: Extract<ManagedAgentRunStatus, 'completed' | 'failed' | 'cancelled'>,
    error: { code: string; message: string } | undefined,
    eventType: string,
    cause?: unknown,
  ): Promise<boolean> {
    try {
      return await this.finalizeRun(agentId, runId, status, error, eventType);
    } catch (failure) {
      this.degradedRuns.set(runId, { agentId });
      this.logger.error('Could not persist terminal run state; run is degraded', {
        agentId,
        runId,
        error: sanitizeError(failure),
        ...(cause === undefined ? {} : { cause: sanitizeError(cause) }),
      });
      return false;
    }
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
    return this.enqueueEventWork(agentId, 512, async () => {
      await this.injectWriteFault('terminal');
      const persisted = await withBusyRetry(() =>
        this.db.transaction().execute(async (transaction) => {
          const run = await transaction
            .selectFrom('supervisor_agent_runs')
            .select('worktree_id')
            .where('id', '=', runId)
            .where('agent_id', '=', agentId)
            .executeTakeFirst();
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
          if (run?.worktree_id) {
            await transaction
              .updateTable('supervisor_worktrees')
              .set({ status: 'ready', error: null, updated_at: this.now() })
              .where('id', '=', run.worktree_id)
              .where('status', '=', 'busy')
              .execute();
          }
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

  private assertRunHealthy(runId: string): void {
    if (this.degradedRuns.has(runId)) {
      throw new ManagedAgentCommandOutcomeUnknownError(runId);
    }
  }

  private async disposeActiveRunSafely(active: ActiveRun, reason: string): Promise<void> {
    try {
      await this.disposeActiveRun(active);
    } catch (error) {
      this.logger.warn('Pi session disposal did not complete', {
        agentId: active.agentId,
        runId: active.runId,
        reason,
        error: sanitizeError(error),
      });
    }
  }

  private assertMutable(): void {
    if (this.closed) throw new Error('managed_agent_service_closed');
  }

  private async injectWriteFault(writeClass: SupervisorWriteClass): Promise<void> {
    await this.writeFaultInjector?.(writeClass);
  }

  private async observeLifecycle(phase: SupervisorLifecyclePhase, runId?: string): Promise<void> {
    await this.lifecycleObserver?.(phase, runId);
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

  private toRunResponse(
    row: AgentRunRow & { latest_event_sequence?: number | null },
  ): ManagedAgentRunResponse {
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
      executionMode: row.execution_mode,
      worktreeId: row.worktree_id,
      parentRunId: row.parent_run_id,
      ...(row.latest_event_sequence === undefined
        ? {}
        : { latestEventSequence: row.latest_event_sequence ?? 0 }),
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
      systemPromptMode: row.system_prompt_mode,
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
    systemPromptMode: row.system_prompt_mode,
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
): { type: string; payload: JsonValue; encodedBytes: number; truncated?: string } {
  const state: PayloadState = { items: 0, bytes: 2, truncated: undefined };
  if (typeof rawEvent !== 'object' || rawEvent === null || Array.isArray(rawEvent)) {
    const payload = toJsonValue(rawEvent, state, limits, new WeakSet<object>(), 0);
    return {
      type: 'unknown',
      payload,
      encodedBytes: state.bytes,
      ...(state.truncated ? { truncated: state.truncated } : {}),
    };
  }
  const record = rawEvent as Record<string, unknown>;
  const type = typeof record.type === 'string' && record.type.length > 0 ? record.type : 'unknown';
  const payload: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'type') continue;
    if (!reservePayloadBytes(state, limits, Buffer.byteLength(JSON.stringify(key), 'utf8') + 2)) {
      break;
    }
    payload[key] = toJsonValue(value, state, limits, new WeakSet<object>(), 0);
  }
  return {
    type,
    payload,
    encodedBytes: Math.min(state.bytes, limits.maxBytes),
    ...(state.truncated ? { truncated: state.truncated } : {}),
  };
}

interface PayloadState {
  items: number;
  bytes: number;
  truncated: string | undefined;
}

function reservePayloadBytes(
  state: PayloadState,
  limits: EventPayloadLimits,
  bytes: number,
): boolean {
  if (state.bytes + bytes <= limits.maxBytes) {
    state.bytes += bytes;
    return true;
  }
  state.truncated ??= 'payload_bytes';
  return false;
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
  if (value === null || typeof value === 'boolean') {
    reservePayloadBytes(state, limits, value === null ? 4 : value ? 4 : 5);
    return value;
  }
  if (typeof value === 'string') {
    const encodedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (reservePayloadBytes(state, limits, encodedBytes)) return value;
    return '[truncated]';
  }
  if (typeof value === 'number') {
    const normalized = Number.isFinite(value) ? value : String(value);
    reservePayloadBytes(state, limits, Buffer.byteLength(JSON.stringify(normalized), 'utf8'));
    return normalized;
  }
  if (typeof value === 'bigint') {
    const normalized = value.toString();
    reservePayloadBytes(state, limits, Buffer.byteLength(JSON.stringify(normalized), 'utf8'));
    return normalized;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return null;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return sanitizeError(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const entry of value) {
      if (!reservePayloadBytes(state, limits, 1)) break;
      result.push(toJsonValue(entry, state, limits, seen, depth + 1));
      if (state.truncated === 'payload_bytes') break;
    }
    return result;
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!reservePayloadBytes(state, limits, Buffer.byteLength(JSON.stringify(key), 'utf8') + 2)) {
      break;
    }
    result[key] = toJsonValue(entry, state, limits, seen, depth + 1);
    if (state.truncated === 'payload_bytes') break;
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
