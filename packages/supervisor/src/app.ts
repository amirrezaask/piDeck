import { dirname, join, resolve } from 'node:path';

import type { AgentFactory } from '@nextflow/agent-runtime';
import {
  AgentMessageRequestSchema,
  CancelExecutionResponseSchema,
  CreateExecutionRequestSchema,
  CreateManagedAgentRequestSchema,
  CreateManagedAgentRunRequestSchema,
  type ErrorCode,
  ErrorResponseSchema,
  ExecutionEventsQuerySchema,
  ExecutionListQuerySchema,
  ExecutionListResponseSchema,
  HealthResponseSchema,
  ManagedAgentEventsQuerySchema,
  ManagedAgentEventsResponseSchema,
  ManagedAgentListQuerySchema,
  ManagedAgentListResponseSchema,
  ManagedAgentModelsResponseSchema,
  ManagedAgentRunListQuerySchema,
  ManagedAgentRunListResponseSchema,
  ManagedAgentRunResponseSchema,
  UpdateManagedAgentRequestSchema,
} from '@nextflow/contracts';
import {
  createSupervisorDatabase,
  type MigrationDatabase,
  migrateToLatest,
  type NextflowDatabase,
  type SupervisorDatabase,
} from '@nextflow/database';
import { createLogger } from '@nextflow/observability';
import { createTestAgentFactory } from '@nextflow/test-agents';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  ManagedAgentBusyError,
  ManagedAgentNotAvailableError,
  ManagedAgentNotFoundError,
  ManagedAgentRunNotCancellableError,
  ManagedAgentRunNotFoundError,
  ManagedAgentService,
} from './agent-service.js';
import type { PiSessionFactory } from './pi-session.js';
import { SdkPiSessionFactory } from './pi-session.js';
import {
  ExecutionNotCancellableError,
  ExecutionNotFoundError,
  SupervisorService,
} from './service.js';

const ExecutionParamsSchema = z.object({ executionId: z.string().min(1) });
const AgentParamsSchema = z.object({ agentId: z.string().uuid() });
const AgentRunParamsSchema = z.object({ runId: z.string().uuid() });

export interface SupervisorAppOptions {
  databasePath: string;
  logger?: boolean;
  agentFactory?: AgentFactory;
  piSessionFactory?: PiSessionFactory;
  agentDefaultCwd?: string;
  piSessionDirectory?: string;
  startService?: boolean;
  serviceToken?: string;
}

export interface SupervisorApp {
  readonly server: FastifyInstance;
  readonly database: NextflowDatabase<SupervisorDatabase>;
  readonly service: SupervisorService;
  readonly agents: ManagedAgentService;
}

export function buildSupervisorApp(options: SupervisorAppOptions): SupervisorApp {
  const database = createSupervisorDatabase(options.databasePath);
  const log = createLogger({ name: 'nextflow.supervisor', enabled: options.logger ?? false });
  const serviceLogger = {
    info: (message: string, context?: Record<string, unknown>) => log.info(context ?? {}, message),
    warn: (message: string, context?: Record<string, unknown>) => log.warn(context ?? {}, message),
    error: (message: string, context?: Record<string, unknown>) =>
      log.error(context ?? {}, message),
  };
  const service = new SupervisorService({
    db: database.db,
    agentFactory: options.agentFactory ?? createTestAgentFactory(),
    logger: serviceLogger,
  });
  const defaultCwd = resolve(options.agentDefaultCwd ?? process.cwd());
  const sessionFactory =
    options.piSessionFactory ??
    new SdkPiSessionFactory({
      defaultCwd,
      sessionDirectory:
        options.piSessionDirectory ?? join(dirname(resolve(options.databasePath)), 'pi-sessions'),
    });
  const agents = new ManagedAgentService({
    db: database.db,
    sessionFactory,
    defaultCwd,
    logger: serviceLogger,
  });
  const server = Fastify({ logger: options.logger ?? false, requestIdHeader: 'x-request-id' });
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return sendError(reply, 400, 'validation_failed', 'The request is invalid', error.issues);
    }
    return handleError(reply, error);
  });
  if (options.serviceToken) {
    server.addHook('onRequest', async (request, reply) => {
      if (request.url.split('?', 1)[0] === '/v1/health') {
        return;
      }
      const authorization = request.headers.authorization;
      if (authorization !== `Bearer ${options.serviceToken}`) {
        return sendError(reply, 401, 'not_authenticated', 'Service authentication is required');
      }
    });
  }

  server.get('/v1/health', async (request) =>
    HealthResponseSchema.parse({
      status: 'ok',
      service: 'supervisor',
      requestId: request.id,
    }),
  );

  server.post('/v1/agents', async (request, reply) => {
    const parsed = CreateManagedAgentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The agent request is invalid',
        parsed.error.issues,
      );
    }

    const agent = await agents.createAgent(parsed.data);
    return reply.code(201).send(agent);
  });

  server.post('/v1/runs', async (request, reply) => {
    const parsed = CreateManagedAgentRunRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The Supervisor run request is invalid',
        parsed.error.issues,
      );
    }
    try {
      return reply.code(202).send(await agents.createRun(parsed.data));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.get('/v1/runs', async (request, reply) => {
    const parsed = ManagedAgentRunListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The Supervisor run query is invalid',
        parsed.error.issues,
      );
    }
    return reply.send(ManagedAgentRunListResponseSchema.parse(await agents.listRuns(parsed.data)));
  });

  server.get('/v1/runs/:runId', async (request, reply) => {
    const params = AgentRunParamsSchema.parse(request.params);
    const run = await agents.getRun(params.runId);
    if (!run) {
      return sendError(reply, 404, 'not_found', 'Run not found');
    }
    return reply.send(ManagedAgentRunResponseSchema.parse(run));
  });

  server.post('/v1/runs/:runId/cancel', async (request, reply) => {
    const params = AgentRunParamsSchema.parse(request.params);
    try {
      return reply.send(await agents.cancelRun(params.runId));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.post('/v1/runs/:runId/steer', async (request, reply) => {
    const params = AgentRunParamsSchema.parse(request.params);
    const body = AgentMessageRequestSchema.parse(request.body);
    try {
      return reply.code(202).send(await agents.steerRun(params.runId, body));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.post('/v1/runs/:runId/follow-up', async (request, reply) => {
    const params = AgentRunParamsSchema.parse(request.params);
    const body = AgentMessageRequestSchema.parse(request.body);
    try {
      return reply.code(202).send(await agents.followUpRun(params.runId, body));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.get('/v1/runs/:runId/events', async (request, reply) => {
    const params = AgentRunParamsSchema.parse(request.params);
    const query = ManagedAgentEventsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The run event query is invalid',
        query.error.issues,
      );
    }
    try {
      return reply.send({ events: await agents.listRunEvents(params.runId, query.data) });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.get('/v1/runs/:runId/stream', async (request, reply) => {
    const params = AgentRunParamsSchema.parse(request.params);
    const query = ManagedAgentEventsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The run event query is invalid',
        query.error.issues,
      );
    }
    if (!(await agents.getRun(params.runId))) {
      return sendError(reply, 404, 'not_found', 'Run not found');
    }

    const lastEventId = request.headers['last-event-id'];
    const headerSequence = typeof lastEventId === 'string' ? Number(lastEventId) : Number.NaN;
    const afterSequence =
      Number.isInteger(headerSequence) && headerSequence >= 0
        ? Math.max(query.data.afterSequence, headerSequence)
        : query.data.afterSequence;

    reply.hijack();
    reply.raw.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: Parameters<ManagedAgentService['events']['publish']>[0]) => {
      reply.raw.write(
        `id: ${event.sequence}\\nevent: ${event.type}\\ndata: ${JSON.stringify(event)}\\n\\n`,
      );
    };
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = await agents.streamRun(params.runId, afterSequence, send);
    } catch {
      reply.raw.end();
      return reply;
    }
    const heartbeat = setInterval(() => {
      reply.raw.write(': keep-alive\\n\\n');
    }, 15_000);
    request.raw.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    });
  });

  server.get('/v1/models', async (_request, reply) => {
    return reply.send(ManagedAgentModelsResponseSchema.parse(await agents.listModels()));
  });

  server.get('/v1/agents', async (request, reply) => {
    const parsed = ManagedAgentListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The agent query is invalid',
        parsed.error.issues,
      );
    }
    return reply.send(ManagedAgentListResponseSchema.parse(await agents.listAgents(parsed.data)));
  });

  server.get('/v1/agents/:agentId', async (request, reply) => {
    const params = AgentParamsSchema.parse(request.params);
    const agent = await agents.getAgent(params.agentId);
    if (!agent) {
      return sendError(reply, 404, 'not_found', 'Agent not found');
    }
    return reply.send(agent);
  });

  server.patch('/v1/agents/:agentId', async (request, reply) => {
    const params = AgentParamsSchema.parse(request.params);
    const body = UpdateManagedAgentRequestSchema.parse(request.body);
    try {
      return reply.send(await agents.renameAgent(params.agentId, body));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.delete('/v1/agents/:agentId', async (request, reply) => {
    const params = AgentParamsSchema.parse(request.params);
    try {
      return reply.send(await agents.deleteAgent(params.agentId));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.get('/v1/agents/:agentId/events', async (request, reply) => {
    const params = AgentParamsSchema.parse(request.params);
    const query = ManagedAgentEventsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The agent event query is invalid',
        query.error.issues,
      );
    }
    if (!(await agents.getAgent(params.agentId))) {
      return sendError(reply, 404, 'not_found', 'Agent not found');
    }
    return reply.send(
      ManagedAgentEventsResponseSchema.parse({
        events: await agents.listEvents(params.agentId, query.data),
      }),
    );
  });

  server.get('/v1/agents/:agentId/stream', async (request, reply) => {
    const params = AgentParamsSchema.parse(request.params);
    const query = ManagedAgentEventsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The agent event query is invalid',
        query.error.issues,
      );
    }
    if (!(await agents.getAgent(params.agentId))) {
      return sendError(reply, 404, 'not_found', 'Agent not found');
    }

    const lastEventId = request.headers['last-event-id'];
    const headerSequence = typeof lastEventId === 'string' ? Number(lastEventId) : Number.NaN;
    const afterSequence =
      Number.isInteger(headerSequence) && headerSequence >= 0
        ? Math.max(query.data.afterSequence, headerSequence)
        : query.data.afterSequence;

    reply.hijack();
    reply.raw.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: Parameters<ManagedAgentService['events']['publish']>[0]) => {
      reply.raw.write(
        `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    };
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = await agents.streamAgent(params.agentId, afterSequence, send);
    } catch {
      reply.raw.end();
      return reply;
    }
    const heartbeat = setInterval(() => {
      reply.raw.write(': keep-alive\n\n');
    }, 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    };
    request.raw.once('close', cleanup);
  });

  server.post('/v1/executions', async (request, reply) => {
    const parsed = CreateExecutionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The execution request is invalid',
        parsed.error.issues,
      );
    }

    try {
      const result = await service.createExecution(parsed.data);
      return reply.code(result.created ? 201 : 200).send(result.execution);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.get('/v1/executions', async (request, reply) => {
    const parsed = ExecutionListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The execution query is invalid',
        parsed.error.issues,
      );
    }

    const result = await service.listExecutions(parsed.data);
    return reply.send(ExecutionListResponseSchema.parse(result));
  });

  server.get('/v1/executions/:executionId', async (request, reply) => {
    const params = ExecutionParamsSchema.parse(request.params);
    const execution = await service.getExecution(params.executionId);
    if (!execution) {
      return sendError(reply, 404, 'not_found', 'Execution not found');
    }
    return reply.send(execution);
  });

  server.post('/v1/executions/:executionId/cancel', async (request, reply) => {
    const params = ExecutionParamsSchema.parse(request.params);
    try {
      const execution = await service.cancelExecution(params.executionId);
      return reply.send(CancelExecutionResponseSchema.parse(execution));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.get('/v1/executions/:executionId/events', async (request, reply) => {
    const params = ExecutionParamsSchema.parse(request.params);
    const query = ExecutionEventsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The event query is invalid',
        query.error.issues,
      );
    }
    if (!(await service.getExecution(params.executionId))) {
      return sendError(reply, 404, 'not_found', 'Execution not found');
    }

    return reply.send({ events: await service.listEvents(params.executionId, query.data) });
  });

  server.get('/v1/executions/:executionId/stream', async (request, reply) => {
    const params = ExecutionParamsSchema.parse(request.params);
    const query = ExecutionEventsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The event query is invalid',
        query.error.issues,
      );
    }
    if (!(await service.getExecution(params.executionId))) {
      return sendError(reply, 404, 'not_found', 'Execution not found');
    }

    const lastEventId = request.headers['last-event-id'];
    const headerSequence = typeof lastEventId === 'string' ? Number(lastEventId) : Number.NaN;
    const afterSequence =
      Number.isInteger(headerSequence) && headerSequence >= 0
        ? Math.max(query.data.afterSequence, headerSequence)
        : query.data.afterSequence;

    reply.hijack();
    reply.raw.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: Parameters<SupervisorService['events']['publish']>[0]) => {
      reply.raw.write(
        `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    };
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = await service.streamExecution(params.executionId, afterSequence, send);
    } catch {
      reply.raw.end();
      return reply;
    }

    const heartbeat = setInterval(() => {
      reply.raw.write(': keep-alive\n\n');
    }, 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    };
    request.raw.once('close', cleanup);
  });

  if (options.startService ?? true) {
    server.addHook('onReady', async () => {
      // The supervisor opens the database itself, so bootstrap and upgrade the
      // schema before either service can issue a query against it.
      await migrateToLatest(database.db as unknown as Kysely<MigrationDatabase>);
      await service.start();
      await agents.start();
    });
  }
  server.addHook('onClose', async () => {
    await agents.close();
    await service.close();
    await database.close();
  });

  return { server, database, service, agents };
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): FastifyReply {
  const response = ErrorResponseSchema.parse({
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  });
  return reply.code(statusCode).send(response);
}

function handleError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ExecutionNotFoundError) {
    return sendError(reply, 404, 'not_found', error.message);
  }
  if (error instanceof ExecutionNotCancellableError) {
    return sendError(reply, 409, 'execution_not_cancellable', error.message);
  }
  if (error instanceof ManagedAgentNotFoundError) {
    return sendError(reply, 404, 'not_found', error.message);
  }
  if (error instanceof ManagedAgentNotAvailableError) {
    return sendError(reply, 409, 'agent_not_available', error.message);
  }
  if (error instanceof ManagedAgentBusyError) {
    return sendError(reply, 409, 'agent_busy', error.message);
  }
  if (error instanceof ManagedAgentRunNotFoundError) {
    return sendError(reply, 404, 'not_found', 'Run not found');
  }
  if (error instanceof ManagedAgentRunNotCancellableError) {
    return sendError(reply, 409, 'run_not_cancellable', error.message);
  }

  console.error(error);
  return sendError(reply, 500, 'internal_error', 'An internal error occurred');
}
