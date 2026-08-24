import {
  type AgentEvent,
  AgentEventSchema,
  type AgentExecutionRequest,
  type AgentFactory,
  type AgentInstance,
} from '@nextflow/agent-runtime';
import {
  type CreateExecutionRequest,
  CreateExecutionRequestSchema,
  decodeJson,
  decodeJsonObject,
  type ExecutionEventsQuery,
  type ExecutionListQuery,
  type ExecutionResponse,
  ExecutionResponseSchema,
  type ExecutionStatus,
  ExecutionStatusSchema,
  encodeJson,
  type JsonObject,
  type PersistedExecutionEvent,
} from '@nextflow/contracts';
import {
  createId,
  nowIso,
  type SupervisorDatabase,
  type SupervisorExecutionsTable,
  withBusyRetry,
} from '@nextflow/database';
import type { Kysely, Selectable } from 'kysely';
import { ExecutionEventHub } from './event-hub.js';
import { assertExecutionTransition, isTerminalExecutionStatus } from './execution-state.js';

export interface SupervisorLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const defaultLogger: SupervisorLogger = {
  info: (message, context) => console.info(message, context ?? ''),
  warn: (message, context) => console.warn(message, context ?? ''),
  error: (message, context) => console.error(message, context ?? ''),
};

type ExecutionRow = Selectable<SupervisorExecutionsTable>;

type PersistResult = {
  event?: PersistedExecutionEvent;
  ignored: boolean;
  terminal: boolean;
};

interface ActiveExecution {
  readonly controller: AbortController;
  done: Promise<void>;
}

export class ExecutionNotFoundError extends Error {
  readonly code = 'not_found';

  constructor(readonly executionId: string) {
    super(`Execution ${executionId} was not found`);
    this.name = 'ExecutionNotFoundError';
  }
}

export class ExecutionNotCancellableError extends Error {
  readonly code = 'execution_not_cancellable';

  constructor(readonly executionId: string) {
    super(`Execution ${executionId} is not cancellable`);
    this.name = 'ExecutionNotCancellableError';
  }
}

export interface SupervisorServiceOptions {
  readonly db: Kysely<SupervisorDatabase>;
  readonly agentFactory: AgentFactory;
  readonly logger?: SupervisorLogger;
  readonly now?: () => string;
  readonly idFactory?: () => string;
}

export interface CreateExecutionResult {
  readonly execution: ExecutionResponse;
  readonly created: boolean;
}

export class SupervisorService {
  readonly events = new ExecutionEventHub();

  private readonly db: Kysely<SupervisorDatabase>;
  private readonly agentFactory: AgentFactory;
  private readonly logger: SupervisorLogger;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly active = new Map<string, ActiveExecution>();
  private started = false;
  private closed = false;

  constructor(options: SupervisorServiceOptions) {
    this.db = options.db;
    this.agentFactory = options.agentFactory;
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? nowIso;
    this.idFactory = options.idFactory ?? createId;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.closed) {
      throw new Error('supervisor_service_closed');
    }

    this.started = true;
    const interrupted = await this.db
      .selectFrom('supervisor_executions')
      .selectAll()
      .where('status', 'in', ['pending', 'starting', 'running'])
      .execute();

    for (const execution of interrupted) {
      await this.markTerminal(execution.id, 'failed', {
        code: 'supervisor_restarted',
        message: 'Execution was interrupted when the Supervisor restarted',
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    const active = [...this.active.values()];
    for (const execution of active) {
      execution.controller.abort();
    }
    await Promise.allSettled(active.map((execution) => execution.done));
  }

  async createExecution(input: CreateExecutionRequest): Promise<CreateExecutionResult> {
    const request = CreateExecutionRequestSchema.parse(input);
    const existing = await this.findByIdempotencyKey(request.idempotencyKey);
    if (existing) {
      return { execution: this.toResponse(existing), created: false };
    }

    const id = this.idFactory();
    const createdAt = this.now();
    try {
      await withBusyRetry(() =>
        this.db.transaction().execute(async (transaction) => {
          await transaction
            .insertInto('supervisor_executions')
            .values({
              id,
              idempotency_key: request.idempotencyKey,
              agent_type: request.agentType,
              request_json: encodeJson({ input: request.input, config: request.config }),
              status: 'pending',
              timeout_ms: request.timeoutMs,
              output_json: null,
              error_code: null,
              error_message: null,
              created_at: createdAt,
              started_at: null,
              finished_at: null,
            })
            .execute();
          await transaction
            .insertInto('supervisor_idempotency_keys')
            .values({
              idempotency_key: request.idempotencyKey,
              execution_id: id,
              created_at: createdAt,
            })
            .execute();
        }),
      );
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const concurrent = await this.findByIdempotencyKey(request.idempotencyKey);
      if (!concurrent) {
        throw error;
      }
      return { execution: this.toResponse(concurrent), created: false };
    }

    const execution = await this.getExecutionRow(id);
    if (!execution) {
      throw new Error('execution_insert_missing');
    }

    this.schedule(id);
    return { execution: this.toResponse(execution), created: true };
  }

  async getExecution(executionId: string): Promise<ExecutionResponse | null> {
    const row = await this.getExecutionRow(executionId);
    return row ? this.toResponse(row) : null;
  }

  async listExecutions(options: ExecutionListQuery): Promise<{
    executions: ExecutionResponse[];
    nextCursor: string | null;
  }> {
    let query = this.db.selectFrom('supervisor_executions').selectAll();
    if (options.status) {
      query = query.where('status', '=', options.status);
    }
    if (options.cursor) {
      const cursorCreatedAt = decodeCursor(options.cursor);
      if (cursorCreatedAt) {
        query = query.where('created_at', '<', cursorCreatedAt);
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
      executions: page.map((row) => this.toResponse(row)),
      nextCursor: hasMore ? encodeCursor(page.at(-1)?.created_at ?? '') : null,
    };
  }

  async listEvents(
    executionId: string,
    options: ExecutionEventsQuery,
  ): Promise<PersistedExecutionEvent[]> {
    const rows = await this.db
      .selectFrom('supervisor_execution_events')
      .selectAll()
      .where('execution_id', '=', executionId)
      .where('sequence', '>', options.afterSequence)
      .orderBy('sequence', 'asc')
      .execute();

    return rows.map((row) => ({
      executionId: row.execution_id,
      sequence: row.sequence,
      type: row.event_type as PersistedExecutionEvent['type'],
      payload: decodeJson(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  subscribe(executionId: string, listener: (event: PersistedExecutionEvent) => void): () => void {
    return this.events.subscribe(executionId, listener);
  }

  async cancelExecution(executionId: string): Promise<ExecutionResponse> {
    const row = await this.getExecutionRow(executionId);
    if (!row) {
      throw new ExecutionNotFoundError(executionId);
    }
    if (isTerminalExecutionStatus(ExecutionStatusSchema.parse(row.status))) {
      throw new ExecutionNotCancellableError(executionId);
    }

    const result = await this.markTerminal(executionId, 'cancelled', {
      code: 'execution_cancelled',
      message: 'Execution was cancelled',
    });
    if (result) {
      this.active.get(executionId)?.controller.abort();
    }

    const execution = await this.getExecution(executionId);
    if (!execution) {
      throw new ExecutionNotFoundError(executionId);
    }
    return execution;
  }

  async streamExecution(
    executionId: string,
    afterSequence: number,
    send: (event: PersistedExecutionEvent) => void,
  ): Promise<() => void> {
    const execution = await this.getExecutionRow(executionId);
    if (!execution) {
      throw new ExecutionNotFoundError(executionId);
    }

    let replaying = true;
    const buffered: PersistedExecutionEvent[] = [];
    let lastSequence = afterSequence;
    const unsubscribe = this.subscribe(executionId, (event) => {
      if (replaying) {
        buffered.push(event);
        return;
      }
      if (event.sequence <= lastSequence) {
        return;
      }
      lastSequence = event.sequence;
      send(event);
    });

    try {
      const events = await this.listEvents(executionId, { afterSequence });
      for (const event of events) {
        if (event.sequence <= lastSequence) {
          continue;
        }
        lastSequence = event.sequence;
        send(event);
      }
      replaying = false;
      buffered.sort((left, right) => left.sequence - right.sequence);
      for (const event of buffered) {
        if (event.sequence <= lastSequence) {
          continue;
        }
        lastSequence = event.sequence;
        send(event);
      }
      return unsubscribe;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  private schedule(executionId: string): void {
    const done = this.runExecution(executionId);
    const active = this.active.get(executionId);
    if (active) {
      active.done = done;
    }
    void done;
  }

  private async runExecution(executionId: string): Promise<void> {
    const controller = new AbortController();
    const control: ActiveExecution = { controller, done: Promise.resolve() };
    this.active.set(executionId, control);

    let agent: AgentInstance | undefined;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const row = await this.getExecutionRow(executionId);
      if (!row || isTerminalExecutionStatus(ExecutionStatusSchema.parse(row.status))) {
        return;
      }

      if (!(await this.transitionStatus(executionId, 'starting'))) {
        return;
      }

      const request = this.agentRequest(row);
      timeout = setTimeout(() => {
        void this.timeoutExecution(executionId);
      }, row.timeout_ms);

      try {
        agent = await this.agentFactory.create({
          agentType: request.agentType,
          input: request.input,
          config: request.config,
        });
      } catch (error) {
        await this.markTerminal(executionId, 'failed', {
          code: 'agent_start_failed',
          message: 'The agent could not be started',
        });
        this.logger.error('Agent factory failed', { executionId, error: sanitizeError(error) });
        return;
      }

      if (!(await this.transitionStatus(executionId, 'running'))) {
        return;
      }

      try {
        for await (const rawEvent of agent.execute(request, controller.signal)) {
          const parsed = AgentEventSchema.safeParse(rawEvent);
          if (!parsed.success) {
            await this.markTerminal(executionId, 'failed', {
              code: 'invalid_agent_event',
              message: 'The agent emitted an invalid event',
            });
            this.logger.error('Agent emitted an invalid event', { executionId });
            break;
          }

          const result = await this.persistAgentEvent(executionId, parsed.data);
          if (result.ignored) {
            this.logger.warn('Ignored an agent event after execution became terminal', {
              executionId,
            });
          }
          if (result.terminal) {
            break;
          }
        }

        const current = await this.getExecutionRow(executionId);
        if (current && !isTerminalExecutionStatus(ExecutionStatusSchema.parse(current.status))) {
          await this.markTerminal(executionId, 'failed', {
            code: 'agent_stream_ended',
            message: 'The agent ended without a terminal event',
          });
        }
      } catch (error) {
        const current = await this.getExecutionRow(executionId);
        if (current && !isTerminalExecutionStatus(ExecutionStatusSchema.parse(current.status))) {
          await this.markTerminal(executionId, 'failed', {
            code: 'agent_exception',
            message: 'The agent failed unexpectedly',
          });
          this.logger.error('Agent execution threw', { executionId, error: sanitizeError(error) });
        }
      }
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (agent) {
        try {
          await agent.dispose();
        } catch (error) {
          this.logger.error('Agent disposal failed', { executionId, error: sanitizeError(error) });
        }
      }
      this.active.delete(executionId);
    }
  }

  private async timeoutExecution(executionId: string): Promise<void> {
    const changed = await this.markTerminal(executionId, 'timed_out', {
      code: 'execution_timed_out',
      message: 'Execution exceeded its timeout',
    });
    if (changed) {
      this.active.get(executionId)?.controller.abort();
    }
  }

  private async persistAgentEvent(executionId: string, event: AgentEvent): Promise<PersistResult> {
    const result = await withBusyRetry(() =>
      this.db.transaction().execute(async (transaction) => {
        const row = await transaction
          .selectFrom('supervisor_executions')
          .selectAll()
          .where('id', '=', executionId)
          .executeTakeFirst();
        if (!row) {
          throw new ExecutionNotFoundError(executionId);
        }

        const status = ExecutionStatusSchema.parse(row.status);
        if (isTerminalExecutionStatus(status)) {
          return { ignored: true, terminal: true } satisfies PersistResult;
        }
        if (event.type === 'output' && row.output_json !== null) {
          return { ignored: true, terminal: false } satisfies PersistResult;
        }

        const sequenceRow = await transaction
          .selectFrom('supervisor_execution_events')
          .select('sequence')
          .where('execution_id', '=', executionId)
          .orderBy('sequence', 'desc')
          .limit(1)
          .executeTakeFirst();
        const sequence = (sequenceRow?.sequence ?? 0) + 1;
        const createdAt = this.now();
        const persisted: PersistedExecutionEvent = {
          executionId,
          sequence,
          type: event.type,
          payload: eventPayload(event),
          createdAt,
        };

        await transaction
          .insertInto('supervisor_execution_events')
          .values({
            execution_id: executionId,
            sequence,
            event_type: event.type,
            payload_json: encodeJson(persisted.payload),
            created_at: createdAt,
          })
          .execute();

        const update: Record<string, unknown> = {};
        let terminal = false;
        if (event.type === 'output') {
          update.output_json = encodeJson(event.output);
        }
        if (event.type === 'started' && status === 'starting') {
          assertExecutionTransition(status, 'running');
          update.status = 'running';
          update.started_at = row.started_at ?? createdAt;
        }
        if (event.type === 'completed') {
          assertExecutionTransition(status, 'succeeded');
          update.status = 'succeeded';
          update.finished_at = createdAt;
          terminal = true;
        }
        if (event.type === 'failed') {
          assertExecutionTransition(status, 'failed');
          update.status = 'failed';
          update.error_code = event.code;
          update.error_message = event.message;
          update.finished_at = createdAt;
          terminal = true;
        }

        if (Object.keys(update).length > 0) {
          await transaction
            .updateTable('supervisor_executions')
            .set(update)
            .where('id', '=', executionId)
            .execute();
        }

        return { event: persisted, ignored: false, terminal } satisfies PersistResult;
      }),
    );

    if (result.event) {
      this.events.publish(result.event);
    }
    return result;
  }

  private async markTerminal(
    executionId: string,
    target: Extract<ExecutionStatus, 'failed' | 'cancelled' | 'timed_out'>,
    error: { code: string; message: string },
  ): Promise<boolean> {
    const result = await withBusyRetry(() =>
      this.db.transaction().execute(async (transaction) => {
        const row = await transaction
          .selectFrom('supervisor_executions')
          .selectAll()
          .where('id', '=', executionId)
          .executeTakeFirst();
        if (!row) {
          throw new ExecutionNotFoundError(executionId);
        }

        const status = ExecutionStatusSchema.parse(row.status);
        if (isTerminalExecutionStatus(status)) {
          return { changed: false, event: undefined };
        }
        assertExecutionTransition(status, target);

        const sequenceRow = await transaction
          .selectFrom('supervisor_execution_events')
          .select('sequence')
          .where('execution_id', '=', executionId)
          .orderBy('sequence', 'desc')
          .limit(1)
          .executeTakeFirst();
        const createdAt = this.now();
        const event: PersistedExecutionEvent = {
          executionId,
          sequence: (sequenceRow?.sequence ?? 0) + 1,
          type: 'failed',
          payload: { code: error.code, message: error.message },
          createdAt,
        };

        await transaction
          .insertInto('supervisor_execution_events')
          .values({
            execution_id: executionId,
            sequence: event.sequence,
            event_type: event.type,
            payload_json: encodeJson(event.payload),
            created_at: createdAt,
          })
          .execute();
        await transaction
          .updateTable('supervisor_executions')
          .set({
            status: target,
            error_code: error.code,
            error_message: error.message,
            finished_at: createdAt,
          })
          .where('id', '=', executionId)
          .execute();

        return { changed: true, event };
      }),
    );

    if (result.event) {
      this.events.publish(result.event);
    }
    return result.changed;
  }

  private async transitionStatus(
    executionId: string,
    target: Extract<ExecutionStatus, 'starting' | 'running'>,
  ): Promise<boolean> {
    return withBusyRetry(() =>
      this.db.transaction().execute(async (transaction) => {
        const row = await transaction
          .selectFrom('supervisor_executions')
          .select(['status', 'started_at'])
          .where('id', '=', executionId)
          .executeTakeFirst();
        if (!row) {
          throw new ExecutionNotFoundError(executionId);
        }

        const status = ExecutionStatusSchema.parse(row.status);
        if (isTerminalExecutionStatus(status)) {
          return false;
        }
        if (status === target) {
          return true;
        }
        assertExecutionTransition(status, target);
        await transaction
          .updateTable('supervisor_executions')
          .set({
            status: target,
            ...(target === 'running' ? { started_at: row.started_at ?? this.now() } : {}),
          })
          .where('id', '=', executionId)
          .execute();
        return true;
      }),
    );
  }

  private async getExecutionRow(executionId: string): Promise<ExecutionRow | undefined> {
    return this.db
      .selectFrom('supervisor_executions')
      .selectAll()
      .where('id', '=', executionId)
      .executeTakeFirst();
  }

  private async findByIdempotencyKey(idempotencyKey: string): Promise<ExecutionRow | undefined> {
    return this.db
      .selectFrom('supervisor_executions')
      .innerJoin(
        'supervisor_idempotency_keys',
        'supervisor_idempotency_keys.execution_id',
        'supervisor_executions.id',
      )
      .select([
        'supervisor_executions.id',
        'supervisor_executions.idempotency_key',
        'supervisor_executions.agent_type',
        'supervisor_executions.request_json',
        'supervisor_executions.status',
        'supervisor_executions.timeout_ms',
        'supervisor_executions.output_json',
        'supervisor_executions.error_code',
        'supervisor_executions.error_message',
        'supervisor_executions.created_at',
        'supervisor_executions.started_at',
        'supervisor_executions.finished_at',
      ])
      .where('supervisor_idempotency_keys.idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  private agentRequest(row: ExecutionRow): AgentExecutionRequest {
    const persisted = decodeJsonObject(row.request_json);
    const input = persisted.input;
    const config = persisted.config;
    if (
      input === undefined ||
      typeof config !== 'object' ||
      config === null ||
      Array.isArray(config)
    ) {
      throw new Error('invalid_persisted_agent_request');
    }

    return {
      executionId: row.id,
      agentType: row.agent_type,
      input,
      config: config as JsonObject,
    };
  }

  private toResponse(row: ExecutionRow): ExecutionResponse {
    return ExecutionResponseSchema.parse({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      agentType: row.agent_type,
      status: row.status,
      timeoutMs: row.timeout_ms,
      output: row.output_json === null ? null : decodeJson(row.output_json),
      error:
        row.error_code === null || row.error_message === null
          ? null
          : { code: row.error_code, message: row.error_message },
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    });
  }
}

function eventPayload(event: AgentEvent): JsonObject {
  switch (event.type) {
    case 'started':
    case 'completed':
      return {};
    case 'message':
      return { message: event.message };
    case 'output':
      return { output: event.output };
    case 'failed':
      return { code: event.code, message: event.message };
    default:
      throw new Error('unknown_agent_event');
  }
}

function sanitizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message.slice(0, 500) };
  }
  return { name: 'UnknownError', message: 'Unknown error' };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

function encodeCursor(createdAt: string): string {
  return Buffer.from(createdAt, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string | undefined {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}
