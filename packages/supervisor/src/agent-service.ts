import { resolve } from 'node:path';

import {
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
  type SupervisorAgentRunsTable,
  type SupervisorAgentsTable,
  type SupervisorDatabase,
  withBusyRetry,
} from '@nextflow/database';
import { type Kysely, type Selectable, sql } from 'kysely';
import { ManagedAgentEventHub } from './agent-event-hub.js';
import type { CreatePiSessionOptions, ManagedPiSession, PiSessionFactory } from './pi-session.js';
import type { SupervisorLogger } from './service.js';

const defaultLogger: SupervisorLogger = {
  info: (message, context) => console.info(message, context ?? ''),
  warn: (message, context) => console.warn(message, context ?? ''),
  error: (message, context) => console.error(message, context ?? ''),
};

type AgentRow = Selectable<SupervisorAgentsTable>;
type AgentRunRow = Selectable<SupervisorAgentRunsTable>;

interface ActiveRun {
  readonly runId: string;
  readonly agentId: string;
  readonly session: ManagedPiSession;
  readonly operations: Set<Promise<void>>;
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
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly eventTails = new Map<string, Promise<void>>();
  private readonly commandTails = new Map<string, Promise<void>>();
  private legacyAgentStatusColumn?: Promise<boolean>;
  private started = false;
  private closed = false;

  constructor(options: ManagedAgentServiceOptions) {
    this.db = options.db;
    this.sessionFactory = options.sessionFactory;
    this.defaultCwd = resolve(options.defaultCwd ?? process.cwd());
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? nowIso;
    this.idFactory = options.idFactory ?? createId;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.closed) throw new Error('managed_agent_service_closed');
    this.started = true;

    // Sessions are process-local and are intentionally not reconstructed. Only
    // runs have runtime state, so restart recovery only touches run rows.
    await this.db
      .updateTable('supervisor_agent_runs')
      .set({
        status: 'failed',
        error_code: 'supervisor_restarted',
        error_message: 'The run was interrupted when the Supervisor restarted',
        completed_at: this.now(),
      })
      .where('status', 'in', ['queued', 'running'])
      .execute();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const activeRuns = [...this.activeRuns.values()];
    await Promise.allSettled(
      activeRuns.map(async (active) => {
        try {
          await active.session.abort();
          await Promise.allSettled([...active.operations]);
        } finally {
          active.unsubscribe();
          await active.session.dispose();
          await this.waitForEvents(active.agentId);
        }
      }),
    );
    this.activeRuns.clear();
  }

  async createAgent(input: CreateManagedAgentRequest): Promise<ManagedAgentResponse> {
    if (this.closed) throw new Error('managed_agent_service_closed');

    const request = CreateManagedAgentRequestSchema.parse(input);
    const id = this.idFactory();
    const createdAt = this.now();
    const cwd = resolve(request.cwd ?? this.defaultCwd);
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
        })
        .execute();
    }

    await this.enqueueCustomEvent(id, null, 'supervisor.agent_created', {});
    return this.requireAgent(id);
  }

  async createRun(input: CreateManagedAgentRunRequest): Promise<ManagedAgentRunResponse> {
    const request = CreateManagedAgentRunRequestSchema.parse(input);
    const agent = await this.getAgentRow(request.agentId);
    if (!agent) throw new ManagedAgentNotFoundError(request.agentId);
    if (this.findActiveRun(agent.id)) {
      throw new ManagedAgentBusyError(agent.id);
    }

    const sessionOptions = createSessionOptions(agent, request);
    const runId = this.idFactory();
    const createdAt = this.now();
    await this.db
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

    await this.startRun(agent, runId, request.prompt, sessionOptions);
    return this.requireRun(runId);
  }

  async getRun(runId: string): Promise<ManagedAgentRunResponse | null> {
    const row = await this.getRunRow(runId);
    return row ? this.toRunResponse(row) : null;
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

  async cancelRun(runId: string): Promise<ManagedAgentRunResponse> {
    const row = await this.getRunRow(runId);
    if (!row) throw new ManagedAgentRunNotFoundError(runId);
    const status = ManagedAgentRunStatusSchema.parse(row.status);
    if (isTerminalRunStatus(status)) throw new ManagedAgentRunNotCancellableError(runId);

    await this.markRunTerminal(runId, 'cancelled', {
      code: 'run_cancelled',
      message: 'The run was cancelled by an operator',
    });
    const active = this.activeRuns.get(runId);
    if (active) {
      await active.session.abort();
      await Promise.allSettled([...active.operations]);
    }
    return this.requireRun(runId);
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
    const request = UpdateManagedAgentRequestSchema.parse(input);
    return this.serializeCommand(agentId, async () => {
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
    let query = this.db.selectFrom('supervisor_agents').selectAll();
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
    return this.serializeCommand(agentId, async () => {
      if (this.findActiveRun(agentId)) {
        throw new ManagedAgentBusyError(agentId, 'The agent has an active run');
      }
      const row = await this.getAgentRow(agentId);
      if (!row) throw new ManagedAgentNotFoundError(agentId);
      await this.db.deleteFrom('supervisor_agents').where('id', '=', agentId).execute();
      return this.toResponse(row);
    });
  }

  async steerRun(runId: string, input: AgentMessageRequest): Promise<ManagedAgentRunResponse> {
    const request = AgentMessageRequestSchema.parse(input);
    return this.serializeCommand(runId, async () => {
      const active = await this.requireActiveRun(runId);
      if (!active.session.isStreaming) {
        throw new ManagedAgentBusyError(active.agentId, `Run ${runId} is not running`);
      }
      try {
        await active.session.steer(request.message);
      } catch (error) {
        throw commandError(active.agentId, error);
      }
      await this.enqueueCustomEvent(active.agentId, runId, 'supervisor.steer_accepted', {});
      return this.requireRun(runId);
    });
  }

  async followUpRun(runId: string, input: AgentMessageRequest): Promise<ManagedAgentRunResponse> {
    const request = AgentMessageRequestSchema.parse(input);
    return this.serializeCommand(runId, async () => {
      const active = await this.requireActiveRun(runId);
      if (!active.session.isStreaming) {
        throw new ManagedAgentBusyError(active.agentId, `Run ${runId} is not running`);
      }
      try {
        await active.session.followUp(request.message);
      } catch (error) {
        throw commandError(active.agentId, error);
      }
      await this.enqueueCustomEvent(active.agentId, runId, 'supervisor.follow_up_accepted', {});
      return this.requireRun(runId);
    });
  }

  async listEvents(
    agentId: string,
    options: ManagedAgentEventsQuery,
  ): Promise<ManagedAgentEvent[]> {
    const rows = await this.db
      .selectFrom('supervisor_agent_events')
      .selectAll()
      .where('agent_id', '=', agentId)
      .where('sequence', '>', options.afterSequence)
      .orderBy('sequence', 'asc')
      .execute();
    return rows.map(toEvent);
  }

  async listRunEvents(
    runId: string,
    options: ManagedAgentEventsQuery,
  ): Promise<ManagedAgentEvent[]> {
    const row = await this.getRunRow(runId);
    if (!row) throw new ManagedAgentRunNotFoundError(runId);
    const rows = await this.db
      .selectFrom('supervisor_agent_events')
      .selectAll()
      .where('run_id', '=', runId)
      .where('sequence', '>', options.afterSequence)
      .orderBy('sequence', 'asc')
      .execute();
    return rows.map(toEvent);
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
      const events = await this.listEvents(agentId, { afterSequence });
      for (const event of events) {
        if (!include(event) || event.sequence <= lastSequence) continue;
        lastSequence = event.sequence;
        send(event);
      }
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
  ): Promise<void> {
    let session: ManagedPiSession;
    try {
      session = await this.sessionFactory.create(sessionOptions);
    } catch (error) {
      await this.failRun(runId, 'agent_start_failed', 'The Pi agent could not be created');
      await this.enqueueCustomEvent(agent.id, runId, 'supervisor.run_failed', {
        code: 'agent_start_failed',
        message: 'The Pi agent could not be created',
      });
      this.logger.error('Pi session creation failed', {
        agentId: agent.id,
        runId,
        error: sanitizeError(error),
      });
      return;
    }

    const active: ActiveRun = {
      runId,
      agentId: agent.id,
      session,
      operations: new Set(),
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
    const operation = session.prompt(prompt, { preflightResult: resolvePreflight });
    this.launchOperation(active, operation, runAcceptance);
    const accepted = await Promise.race([
      preflight,
      operation.then(
        () => false,
        () => false,
      ),
    ]);

    if (accepted) {
      await this.db
        .updateTable('supervisor_agent_runs')
        .set({ status: 'running', started_at: this.now() })
        .where('id', '=', runId)
        .where('status', '=', 'queued')
        .execute();
      resolveRunAcceptance(true);
      await this.enqueueCustomEvent(agent.id, runId, 'supervisor.prompt_accepted', {});
      return;
    }

    await this.failRun(
      runId,
      'prompt_rejected',
      'The Pi agent rejected the prompt before execution',
    );
    resolveRunAcceptance(false);
    await this.enqueueCustomEvent(agent.id, runId, 'supervisor.prompt_rejected', {});
  }

  private launchOperation(
    active: ActiveRun,
    operation: Promise<void>,
    runAcceptance: Promise<boolean>,
  ): void {
    const tracked = operation
      .then(async () => {
        if (await runAcceptance) await this.completeRun(active.runId);
      })
      .catch(async (error: unknown) => {
        await this.failRun(active.runId, 'agent_operation_failed', 'The Pi agent operation failed');
        this.logger.error('Pi agent operation failed', {
          agentId: active.agentId,
          runId: active.runId,
          error: sanitizeError(error),
        });
        await this.enqueueCustomEvent(active.agentId, active.runId, 'supervisor.run_failed', {
          code: 'agent_operation_failed',
          message: 'The Pi agent operation failed',
        });
      })
      .finally(async () => {
        active.unsubscribe();
        this.activeRuns.delete(active.runId);
        await active.session.dispose();
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
      const event = normalizeSessionEvent(rawEvent);
      await this.persistEvent(agentId, runId, event.type, event.payload);
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

  private enqueueEventWork(agentId: string, work: () => Promise<void>): Promise<void> {
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
    void next.catch(() => undefined);
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
      }),
    );
    this.events.publish(persisted);
  }

  private async requireActiveRun(runId: string): Promise<ActiveRun> {
    const row = await this.getRunRow(runId);
    if (!row) throw new ManagedAgentRunNotFoundError(runId);
    const status = ManagedAgentRunStatusSchema.parse(row.status);
    if (isTerminalRunStatus(status)) {
      throw new ManagedAgentBusyError(row.agent_id, `Run ${runId} is no longer active`);
    }
    const active = this.activeRuns.get(runId);
    if (!active)
      throw new ManagedAgentNotAvailableError(row.agent_id, `Run ${runId} is unavailable`);
    return active;
  }

  private findActiveRun(agentId: string): ActiveRun | undefined {
    return [...this.activeRuns.values()].find((active) => active.agentId === agentId);
  }

  private async completeRun(runId: string): Promise<void> {
    await this.db
      .updateTable('supervisor_agent_runs')
      .set({ status: 'completed', completed_at: this.now() })
      .where('id', '=', runId)
      .where('status', 'in', ['queued', 'running'])
      .execute();
  }

  private async failRun(runId: string, code: string, message: string): Promise<void> {
    await this.markRunTerminal(runId, 'failed', { code, message });
  }

  private async markRunTerminal(
    runId: string,
    status: Extract<ManagedAgentRunStatus, 'failed' | 'cancelled'>,
    error: { code: string; message: string },
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('supervisor_agent_runs')
      .set({
        status,
        error_code: error.code,
        error_message: error.message,
        completed_at: this.now(),
      })
      .where('id', '=', runId)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
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
    cwd: resolve(request.cwd ?? row.cwd),
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

function normalizeSessionEvent(rawEvent: unknown): { type: string; payload: JsonValue } {
  if (typeof rawEvent !== 'object' || rawEvent === null || Array.isArray(rawEvent)) {
    return { type: 'unknown', payload: toJsonValue(rawEvent) };
  }
  const record = rawEvent as Record<string, unknown>;
  const type = typeof record.type === 'string' && record.type.length > 0 ? record.type : 'unknown';
  const payload: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'type') payload[key] = toJsonValue(value);
  }
  return { type, payload };
}

function toJsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return null;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return sanitizeError(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry, seen));
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) result[key] = toJsonValue(entry, seen);
  return result;
}

function sanitizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message.slice(0, 500) };
  return { name: 'UnknownError', message: 'Unknown error' };
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
