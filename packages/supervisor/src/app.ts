import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import type { AgentFactory } from '@nextflow/agent-runtime';
import {
  AgentMessageRequestSchema,
  CancelExecutionResponseSchema,
  ChangeScopeSchema,
  ComposerSuggestionsRequestSchema,
  ComposerSuggestionsResponseSchema,
  CreateExecutionRequestSchema,
  CreateInboxItemRequestSchema,
  CreateManagedAgentRequestSchema,
  CreateManagedAgentRunRequestSchema,
  CreateManagedProjectRequestSchema,
  CreateTerminalSessionRequestSchema,
  CreateWorktreeRequestSchema,
  type ErrorCode,
  ErrorResponseSchema,
  ExecutionEventsQuerySchema,
  ExecutionListQuerySchema,
  ExecutionListResponseSchema,
  FleetOverviewResponseSchema,
  HealthResponseSchema,
  IdempotencyKeySchema,
  InboxItemResponseSchema,
  InboxListResponseSchema,
  ManagedAgentCommandReceiptSchema,
  ManagedAgentEventsQuerySchema,
  ManagedAgentEventsResponseSchema,
  ManagedAgentExtensionsResponseSchema,
  ManagedAgentListQuerySchema,
  ManagedAgentListResponseSchema,
  ManagedAgentModelsResponseSchema,
  ManagedAgentRunAttachmentsResponseSchema,
  ManagedAgentRunListQuerySchema,
  ManagedAgentRunListResponseSchema,
  ManagedAgentRunResponseSchema,
  ManagedProjectListQuerySchema,
  ManagedProjectListResponseSchema,
  ResolveInboxItemRequestSchema,
  RunChangesResponseSchema,
  SessionSearchQuerySchema,
  SessionSearchResponseSchema,
  TerminalSessionListResponseSchema,
  TerminalSessionResponseSchema,
  UpdateManagedAgentRequestSchema,
  UpdateManagedExtensionsRequestSchema,
  UpdateManagedProjectRequestSchema,
  WorktreeListResponseSchema,
  WorktreeResponseSchema,
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
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import {
  ManagedAgentBusyError,
  ManagedAgentCommandInProgressError,
  ManagedAgentCommandOutcomeUnknownError,
  ManagedAgentCommandReplayError,
  ManagedAgentIdempotencyConflictError,
  ManagedAgentNotAvailableError,
  ManagedAgentNotFoundError,
  ManagedAgentRunNotCancellableError,
  ManagedAgentRunNotFoundError,
  ManagedAgentService,
} from './agent-service.js';
import { ComposerCatalog } from './composer.js';
import {
  type PiExtensionCatalog,
  PiExtensionNotConfiguredError,
  PiExtensionService,
} from './extensions.js';
import type { PiSessionFactory } from './pi-session.js';
import { SdkPiSessionFactory } from './pi-session.js';
import { ProjectPathConflictError, ProjectService } from './project-service.js';
import {
  ExecutionNotCancellableError,
  ExecutionNotFoundError,
  SupervisorService,
} from './service.js';
import {
  assertWorkingDirectory,
  InvalidWorkingDirectoryError,
  resolveWorkingDirectory,
} from './working-directory.js';
import { WorkspaceCapabilityError, WorkspaceService } from './workspace-service.js';

const ExecutionParamsSchema = z.object({ executionId: z.string().min(1) });
const AgentParamsSchema = z.object({ agentId: z.string().uuid() });
const AgentRunParamsSchema = z.object({ runId: z.string().uuid() });
const ProjectParamsSchema = z.object({ projectId: z.string().uuid() });
const ResourceParamsSchema = z.object({ id: z.string().uuid() });
const CommandReceiptParamsSchema = z.object({ idempotencyKey: IdempotencyKeySchema });

export interface SupervisorAppOptions {
  databasePath: string;
  logger?: boolean;
  agentFactory?: AgentFactory;
  /** Legacy workflow execution endpoints are disabled unless explicitly opted in. */
  enableLegacyExecutions?: boolean;
  piSessionFactory?: PiSessionFactory;
  piExtensionService?: PiExtensionCatalog;
  agentDefaultCwd?: string;
  piSessionDirectory?: string;
  startService?: boolean;
  serviceToken?: string;
  /** Only permits unauthenticated HTTP/WebSocket use from a loopback peer. */
  allowUnauthenticatedLoopback?: boolean;
  shutdownTimeoutMs?: number;
  websocketTicketTtlMs?: number;
  websocketMaxConnections?: number;
  websocketMaxConnectionsPerCredential?: number;
  websocketMaxQueuedBytes?: number;
  eventPayloadMaxBytes?: number;
  eventPayloadMaxDepth?: number;
  eventPayloadMaxItems?: number;
  eventRetentionDays?: number;
  bodyLimitBytes?: number;
}

export interface SupervisorApp {
  readonly server: FastifyInstance;
  readonly database: NextflowDatabase<SupervisorDatabase>;
  readonly service: SupervisorService;
  readonly agents: ManagedAgentService;
  readonly extensions: PiExtensionCatalog;
  readonly projects: ProjectService;
  readonly workspace: WorkspaceService;
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
  const legacyAgentFactory: AgentFactory =
    options.agentFactory ??
    (options.enableLegacyExecutions === true
      ? createTestAgentFactory()
      : ({
          create: async () => {
            throw new Error('legacy_execution_api_disabled');
          },
        } as AgentFactory));
  const service = new SupervisorService({
    db: database.db,
    agentFactory: legacyAgentFactory,
    logger: serviceLogger,
  });
  const defaultCwd = resolveWorkingDirectory(options.agentDefaultCwd ?? process.cwd());
  const projects = new ProjectService({ db: database.db });
  const sessionFactory =
    options.piSessionFactory ??
    new SdkPiSessionFactory({
      defaultCwd,
      sessionDirectory:
        options.piSessionDirectory ?? join(dirname(resolve(options.databasePath)), 'pi-sessions'),
    });
  const extensionService =
    options.piExtensionService ?? new PiExtensionService({ cwd: defaultCwd });
  const composer = new ComposerCatalog({ defaultCwd });
  const workspace = new WorkspaceService(database.db);
  const agents = new ManagedAgentService({
    db: database.db,
    sessionFactory,
    defaultCwd,
    logger: serviceLogger,
    projectService: projects,
    ...(options.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
    ...(options.eventPayloadMaxBytes === undefined &&
    options.eventPayloadMaxDepth === undefined &&
    options.eventPayloadMaxItems === undefined
      ? {}
      : {
          eventPayloadLimits: {
            ...(options.eventPayloadMaxBytes === undefined
              ? {}
              : { maxBytes: options.eventPayloadMaxBytes }),
            ...(options.eventPayloadMaxDepth === undefined
              ? {}
              : { maxDepth: options.eventPayloadMaxDepth }),
            ...(options.eventPayloadMaxItems === undefined
              ? {}
              : { maxItems: options.eventPayloadMaxItems }),
          },
        }),
    ...(options.eventRetentionDays === undefined
      ? {}
      : { eventRetentionDays: options.eventRetentionDays }),
  });
  // Four 6 MB images expand to roughly 32 MB as base64, plus JSON metadata.
  const server = Fastify({
    logger: options.logger ?? false,
    requestIdHeader: 'x-request-id',
    bodyLimit: Math.max(1_024, options.bodyLimitBytes ?? 34_000_000),
  });
  const eventWebSocketServer = new WebSocketServer({ noServer: true });
  const eventSockets = new Map<WebSocket, string>();
  const websocketTickets = new Map<string, { expiresAt: number; used: boolean }>();
  const maxConnections = Math.max(1, options.websocketMaxConnections ?? 100);
  const maxConnectionsPerCredential = Math.max(
    1,
    options.websocketMaxConnectionsPerCredential ?? 20,
  );
  const maxQueuedBytes = Math.max(16_384, options.websocketMaxQueuedBytes ?? 1_000_000);
  const ticketTtlMs = Math.max(1_000, options.websocketTicketTtlMs ?? 30_000);
  const ticketCleanup = setInterval(
    () => {
      const now = Date.now();
      for (const [ticket, record] of websocketTickets) {
        if (record.used || record.expiresAt <= now) websocketTickets.delete(ticket);
      }
    },
    Math.min(ticketTtlMs, 30_000),
  );
  ticketCleanup.unref?.();

  server.server.on('upgrade', (request, socket, head) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    const runMatch = requestUrl.pathname.match(/^\/v1\/runs\/([^/]+)\/stream$/);
    const agentMatch = requestUrl.pathname.match(/^\/v1\/agents\/([^/]+)\/stream$/);
    const resource = runMatch
      ? { type: 'run' as const, id: runMatch[1] }
      : agentMatch
        ? { type: 'agent' as const, id: agentMatch[1] }
        : undefined;
    if (!resource) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const authorization = request.headers.authorization;
    let credential: string | undefined;
    if (options.serviceToken && authorization === `Bearer ${options.serviceToken}`) {
      credential = 'service-token';
    } else {
      const ticket = requestUrl.searchParams.get('ticket');
      const record = ticket ? websocketTickets.get(ticket) : undefined;
      if (record && !record.used && record.expiresAt > Date.now()) {
        record.used = true;
        websocketTickets.delete(ticket as string);
        credential = 'ticket';
      } else if (
        !options.serviceToken &&
        options.allowUnauthenticatedLoopback === true &&
        isLoopbackAddress(request.socket.remoteAddress)
      ) {
        credential = 'loopback';
      }
    }
    if (!credential) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    const credentialConnections = [...eventSockets.values()].filter(
      (value) => value === credential,
    );
    if (
      eventSockets.size >= maxConnections ||
      credentialConnections.length >= maxConnectionsPerCredential
    ) {
      rejectUpgrade(socket, 429, 'Too Many Connections');
      return;
    }

    const query = ManagedAgentEventsQuerySchema.safeParse({
      afterSequence: requestUrl.searchParams.get('afterSequence') ?? 0,
      limit: requestUrl.searchParams.get('limit') ?? undefined,
    });
    if (!query.success) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    eventWebSocketServer.handleUpgrade(request, socket, head, (eventSocket) => {
      eventWebSocketServer.emit(
        'connection',
        eventSocket,
        request,
        resource.type,
        resource.id,
        query.data.afterSequence,
        credential,
      );
    });
  });

  eventWebSocketServer.on(
    'connection',
    (
      socket: WebSocket,
      _request: unknown,
      resourceType: 'agent' | 'run',
      resourceId: string,
      afterSequence: number,
      credential: string,
    ) => {
      eventSockets.set(socket, credential);
      let unsubscribe: (() => void) | undefined;
      let closed = false;
      let alive = true;
      const pending: string[] = [];
      let pendingBytes = 0;
      let sending = false;
      const flush = () => {
        if (closed || sending || socket.readyState !== WebSocket.OPEN) return;
        const next = pending.shift();
        if (!next) return;
        pendingBytes -= Buffer.byteLength(next, 'utf8');
        sending = true;
        socket.send(next, (error?: Error) => {
          sending = false;
          if (error && !closed) socket.close(1011, 'Event delivery failed');
          flush();
        });
      };
      const send = (event: Parameters<ManagedAgentService['events']['publish']>[0]) => {
        if (closed || socket.readyState !== WebSocket.OPEN) return;
        const encoded = JSON.stringify(event);
        const bytes = Buffer.byteLength(encoded, 'utf8');
        if (
          socket.bufferedAmount > maxQueuedBytes ||
          bytes > maxQueuedBytes ||
          pendingBytes + bytes > maxQueuedBytes
        ) {
          socket.close(1013, 'Slow event consumer');
          return;
        }
        pending.push(encoded);
        pendingBytes += bytes;
        flush();
      };
      const heartbeat = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, 15_000);
      socket.on('pong', () => {
        alive = true;
      });
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
        eventSockets.delete(socket);
        pending.length = 0;
        pendingBytes = 0;
      };
      socket.once('close', cleanup);
      socket.once('error', cleanup);

      const stream =
        resourceType === 'run'
          ? agents.streamRun(resourceId, afterSequence, send)
          : agents.streamAgent(resourceId, afterSequence, send);
      void stream
        .then((nextUnsubscribe) => {
          if (closed) nextUnsubscribe();
          else unsubscribe = nextUnsubscribe;
        })
        .catch(() => {
          if (!closed) socket.close(1008, 'Event resource not found');
        });
    },
  );
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof Error && 'code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return sendError(
        reply,
        413,
        'payload_too_large',
        'The request body exceeds the 34 MB attachment limit',
      );
    }
    if (error instanceof z.ZodError) {
      return sendError(reply, 400, 'validation_failed', 'The request is invalid', error.issues);
    }
    return handleError(reply, error);
  });
  server.addHook('onRequest', async (request, reply) => {
    const requestPath = request.url.split('?', 1)[0] ?? '/';
    if (!requestPath.startsWith('/v1/')) return;
    if (requestPath === '/v1/health') return;
    const authorization = request.headers.authorization;
    if (options.serviceToken) {
      if (authorization !== `Bearer ${options.serviceToken}`) {
        return sendError(reply, 401, 'not_authenticated', 'Service authentication is required');
      }
      return;
    }
    if (options.allowUnauthenticatedLoopback !== true || !isLoopbackAddress(request.ip)) {
      return sendError(reply, 401, 'not_authenticated', 'Service authentication is required');
    }
  });

  server.get('/v1/health', async (request) =>
    HealthResponseSchema.parse({
      status: 'ok',
      service: 'supervisor',
      requestId: request.id,
    }),
  );

  server.post('/v1/ws-tickets', async (_request, reply) => {
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + ticketTtlMs;
    websocketTickets.set(ticket, { expiresAt, used: false });
    return reply.send({ ticket, expiresAt: new Date(expiresAt).toISOString() });
  });

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

  server.post('/v1/projects', async (request, reply) => {
    const parsed = CreateManagedProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The project request is invalid',
        parsed.error.issues,
      );
    }
    return reply.code(201).send(await projects.createProject(parsed.data));
  });

  server.patch('/v1/projects/:projectId', async (request, reply) => {
    const params = ProjectParamsSchema.parse(request.params);
    const body = UpdateManagedProjectRequestSchema.parse(request.body);
    try {
      const project = await projects.updateProject(params.projectId, body);
      if (!project) return sendError(reply, 404, 'not_found', 'Project not found');
      return reply.send(project);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.delete('/v1/projects/:projectId', async (request, reply) => {
    const params = ProjectParamsSchema.parse(request.params);
    const deleted = await projects.deleteProject(params.projectId);
    if (!deleted) return sendError(reply, 404, 'not_found', 'Project not found');
    return reply.send(deleted);
  });

  server.get('/v1/projects', async (request, reply) => {
    const parsed = ManagedProjectListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The project query is invalid',
        parsed.error.issues,
      );
    }
    return reply.send(
      ManagedProjectListResponseSchema.parse(await projects.listProjects(parsed.data)),
    );
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
      const idempotencyKey =
        typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key']
          : undefined;
      let requested = parsed.data;
      if (parsed.data.executionMode === 'worktree') {
        if (!parsed.data.worktreeId)
          throw new WorkspaceCapabilityError(
            'validation_failed',
            'Worktree mode requires a worktree',
          );
        const worktree = await workspace.getWorktree(parsed.data.worktreeId);
        if (worktree.status !== 'ready')
          throw new WorkspaceCapabilityError('invalid_state_transition', 'Worktree is not ready');
        requested = { ...parsed.data, cwd: worktree.path };
      }
      return reply
        .code(202)
        .send(
          await agents.createRun(
            idempotencyKey && !requested.idempotencyKey
              ? { ...requested, idempotencyKey }
              : requested,
          ),
        );
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

  server.get('/v1/runs/:runId/attachments', async (request, reply) => {
    const params = AgentRunParamsSchema.parse(request.params);
    try {
      return reply.send(
        ManagedAgentRunAttachmentsResponseSchema.parse(
          await agents.listRunAttachments(params.runId),
        ),
      );
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.get('/v1/runs/:runId', async (request, reply) => {
    const params = AgentRunParamsSchema.parse(request.params);
    const run = await agents.getRun(params.runId);
    if (!run) {
      return sendError(reply, 404, 'not_found', 'Run not found');
    }
    return reply.send(ManagedAgentRunResponseSchema.parse(run));
  });

  server.get('/v1/command-receipts/:idempotencyKey', async (request, reply) => {
    const params = CommandReceiptParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, 'validation_failed', 'The receipt key is invalid');
    }
    const receipt = await agents.getCommandReceipt(params.data.idempotencyKey);
    if (!receipt) return sendError(reply, 404, 'not_found', 'Command receipt not found');
    return reply.send(ManagedAgentCommandReceiptSchema.parse(receipt));
  });

  server.post('/v1/runs/:runId/cancel', async (request, reply) => {
    const params = AgentRunParamsSchema.parse(request.params);
    const body =
      typeof request.body === 'object' && request.body !== null
        ? (request.body as { idempotencyKey?: unknown })
        : undefined;
    const idempotencyKey =
      typeof body?.idempotencyKey === 'string'
        ? body.idempotencyKey
        : typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key']
          : undefined;
    try {
      return reply.send(await agents.cancelRun(params.runId, idempotencyKey));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.post('/v1/runs/:runId/steer', async (request, reply) => {
    const params = AgentRunParamsSchema.parse(request.params);
    const body = AgentMessageRequestSchema.parse(request.body);
    const idempotencyKey =
      typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key']
        : undefined;
    try {
      return reply
        .code(202)
        .send(
          await agents.steerRun(
            params.runId,
            idempotencyKey && !body.idempotencyKey ? { ...body, idempotencyKey } : body,
          ),
        );
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.post('/v1/runs/:runId/follow-up', async (request, reply) => {
    const params = AgentRunParamsSchema.parse(request.params);
    const body = AgentMessageRequestSchema.parse(request.body);
    const idempotencyKey =
      typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key']
        : undefined;
    try {
      return reply
        .code(202)
        .send(
          await agents.followUpRun(
            params.runId,
            idempotencyKey && !body.idempotencyKey ? { ...body, idempotencyKey } : body,
          ),
        );
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
      return reply.send(
        ManagedAgentEventsResponseSchema.parse(
          await agents.listRunEventsPage(params.runId, query.data),
        ),
      );
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.get('/v1/models', async (_request, reply) => {
    return reply.send(ManagedAgentModelsResponseSchema.parse(await agents.listModels()));
  });

  server.get('/v1/composer/suggestions', async (request, reply) => {
    const parsed = ComposerSuggestionsRequestSchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The composer suggestion query is invalid',
        parsed.error.issues,
      );
    }
    try {
      await assertWorkingDirectory(resolveWorkingDirectory(parsed.data.cwd, defaultCwd));
      return reply.send(ComposerSuggestionsResponseSchema.parse(await composer.list(parsed.data)));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  server.get('/v1/extensions', async (_request, reply) => {
    return reply.send(ManagedAgentExtensionsResponseSchema.parse(await extensionService.list()));
  });

  server.post('/v1/extensions/update', async (request, reply) => {
    const parsed = UpdateManagedExtensionsRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'validation_failed',
        'The extension update request is invalid',
        parsed.error.issues,
      );
    }
    try {
      return reply.send(await extensionService.update(parsed.data.source));
    } catch (error) {
      return handleError(reply, error);
    }
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
      ManagedAgentEventsResponseSchema.parse(
        await agents.listEventsPage(params.agentId, query.data),
      ),
    );
  });

  server.get('/v1/fleet', async (_request, reply) =>
    reply.send(FleetOverviewResponseSchema.parse(await workspace.fleet())),
  );

  server.get('/v1/runs/:runId/changes', async (request, reply) => {
    const params = AgentRunParamsSchema.parse(request.params);
    const query = z
      .object({
        scope: ChangeScopeSchema.default('working_tree'),
        baseRef: z.string().max(256).optional(),
      })
      .parse(request.query);
    return reply.send(
      RunChangesResponseSchema.parse(
        await workspace.changes(params.runId, query.scope, query.baseRef),
      ),
    );
  });

  server.post('/v1/worktrees', async (request, reply) =>
    reply
      .code(201)
      .send(
        WorktreeResponseSchema.parse(
          await workspace.createWorktree(CreateWorktreeRequestSchema.parse(request.body)),
        ),
      ),
  );
  server.get('/v1/worktrees', async (_request, reply) =>
    reply.send(WorktreeListResponseSchema.parse({ worktrees: await workspace.listWorktrees() })),
  );
  server.delete('/v1/worktrees/:id', async (request, reply) => {
    const query = z.object({ force: z.enum(['true']).optional() }).parse(request.query);
    return reply.send(
      WorktreeResponseSchema.parse(
        await workspace.releaseWorktree(
          ResourceParamsSchema.parse(request.params).id,
          query.force === 'true',
        ),
      ),
    );
  });

  server.post('/v1/terminal-sessions', async (request, reply) =>
    reply
      .code(202)
      .send(
        TerminalSessionResponseSchema.parse(
          await workspace.createTerminal(CreateTerminalSessionRequestSchema.parse(request.body)),
        ),
      ),
  );
  server.get('/v1/terminal-sessions', async (_request, reply) =>
    reply.send(
      TerminalSessionListResponseSchema.parse({ sessions: await workspace.listTerminals() }),
    ),
  );
  server.get('/v1/terminal-sessions/:id', async (request, reply) =>
    reply.send(
      TerminalSessionResponseSchema.parse(
        await workspace.getTerminal(ResourceParamsSchema.parse(request.params).id),
      ),
    ),
  );
  server.post('/v1/terminal-sessions/:id/input', async (request, reply) => {
    const body = z.object({ data: z.string().max(65536) }).parse(request.body);
    return reply.send(
      await workspace.writeTerminal(ResourceParamsSchema.parse(request.params).id, body.data),
    );
  });
  server.post('/v1/terminal-sessions/:id/cancel', async (request, reply) =>
    reply.send(await workspace.cancelTerminal(ResourceParamsSchema.parse(request.params).id)),
  );

  server.post('/v1/inbox', async (request, reply) =>
    reply
      .code(201)
      .send(
        InboxItemResponseSchema.parse(
          await workspace.createInbox(CreateInboxItemRequestSchema.parse(request.body)),
        ),
      ),
  );
  server.get('/v1/inbox', async (_request, reply) =>
    reply.send(InboxListResponseSchema.parse({ items: await workspace.listInbox() })),
  );
  server.post('/v1/inbox/:id/resolve', async (request, reply) => {
    const body = ResolveInboxItemRequestSchema.parse(request.body);
    return reply.send(
      InboxItemResponseSchema.parse(
        await workspace.resolveInbox(ResourceParamsSchema.parse(request.params).id, body.response),
      ),
    );
  });
  server.post('/v1/inbox/:id/cancel', async (request, reply) =>
    reply.send(
      InboxItemResponseSchema.parse(
        await workspace.cancelInbox(ResourceParamsSchema.parse(request.params).id),
      ),
    ),
  );

  server.get('/v1/sessions/search', async (request, reply) => {
    const query = SessionSearchQuerySchema.parse(request.query);
    return reply.send(
      SessionSearchResponseSchema.parse(await workspace.search(query.q, query.limit)),
    );
  });

  if (options.enableLegacyExecutions === true) {
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
  }

  if (options.startService ?? true) {
    server.addHook('onReady', async () => {
      // The supervisor opens the database itself, so bootstrap and upgrade the
      // schema before either service can issue a query against it.
      await migrateToLatest(database.db as unknown as Kysely<MigrationDatabase>);
      await workspace.start();
      await service.start();
      await agents.start();
    });
  }
  server.addHook('onClose', async () => {
    for (const socket of eventSockets.keys()) socket.terminate();
    eventSockets.clear();
    websocketTickets.clear();
    clearInterval(ticketCleanup);
    eventWebSocketServer.close();
    await workspace.close();
    await agents.close();
    await service.close();
    await database.close();
  });

  return { server, database, service, agents, extensions: extensionService, projects, workspace };
}

function isPublicErrorCode(value: string): value is ErrorCode {
  return [
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
  ].includes(value);
}

function rejectUpgrade(
  socket: { write(chunk: string): unknown; destroy(): void },
  status: number,
  message: string,
): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
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
  if (error instanceof InvalidWorkingDirectoryError) {
    return sendError(reply, 400, 'validation_failed', error.message, { path: error.path });
  }
  if (error instanceof ProjectPathConflictError) {
    return sendError(reply, 400, 'validation_failed', error.message, { path: error.path });
  }
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
  if (error instanceof ManagedAgentIdempotencyConflictError) {
    return sendError(reply, 409, 'idempotency_conflict', error.message);
  }
  if (error instanceof ManagedAgentCommandInProgressError) {
    return sendError(reply, 409, 'idempotency_in_progress', error.message);
  }
  if (error instanceof ManagedAgentCommandOutcomeUnknownError) {
    return sendError(reply, 409, 'command_outcome_unknown', error.message);
  }
  if (error instanceof ManagedAgentCommandReplayError) {
    const code = isPublicErrorCode(error.code) ? error.code : 'internal_error';
    return sendError(reply, code === 'internal_error' ? 500 : 409, code, error.message);
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
  if (error instanceof WorkspaceCapabilityError) {
    const status =
      error.code === 'not_found' ? 404 : error.code === 'invalid_state_transition' ? 409 : 400;
    return sendError(reply, status, error.code, error.message);
  }
  if (error instanceof PiExtensionNotConfiguredError) {
    return sendError(reply, 400, 'validation_failed', error.message);
  }

  console.error(error);
  return sendError(reply, 500, 'internal_error', 'An internal error occurred');
}
