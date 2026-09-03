import {
  type AgentMessageRequest,
  AgentMessageRequestSchema,
  type AgentModel,
  type ChangeScope,
  type ComposerSuggestionsRequest,
  ComposerSuggestionsRequestSchema,
  type ComposerSuggestionsResponse,
  ComposerSuggestionsResponseSchema,
  type CreateManagedAgentRequest,
  CreateManagedAgentRequestSchema,
  type CreateManagedAgentRunRequest,
  CreateManagedAgentRunRequestSchema,
  type CreateManagedProjectRequest,
  CreateManagedProjectRequestSchema,
  type CreateTerminalSessionRequest,
  CreateTerminalSessionRequestSchema,
  type CreateWorktreeRequest,
  CreateWorktreeRequestSchema,
  ErrorResponseSchema,
  type FleetOverviewResponse,
  FleetOverviewResponseSchema,
  type InboxItemResponse,
  InboxItemResponseSchema,
  InboxListResponseSchema,
  type ManagedAgentCommandReceipt,
  ManagedAgentCommandReceiptSchema,
  type ManagedAgentEvent,
  ManagedAgentEventSchema,
  type ManagedAgentEventsQuery,
  type ManagedAgentEventsResponse,
  ManagedAgentEventsResponseSchema,
  type ManagedAgentExtensionsResponse,
  ManagedAgentExtensionsResponseSchema,
  type ManagedAgentListQuery,
  type ManagedAgentListResponse,
  ManagedAgentListResponseSchema,
  type ManagedAgentModelsResponse,
  ManagedAgentModelsResponseSchema,
  type ManagedAgentResponse,
  ManagedAgentResponseSchema,
  type ManagedAgentRunAttachmentsResponse,
  ManagedAgentRunAttachmentsResponseSchema,
  type ManagedAgentRunListQuery,
  type ManagedAgentRunListResponse,
  ManagedAgentRunListResponseSchema,
  type ManagedAgentRunResponse,
  ManagedAgentRunResponseSchema,
  type ManagedProjectListQuery,
  type ManagedProjectListResponse,
  ManagedProjectListResponseSchema,
  type ManagedProjectResponse,
  ManagedProjectResponseSchema,
  type RunChangesResponse,
  RunChangesResponseSchema,
  type RunDebugLogResponse,
  RunDebugLogResponseSchema,
  type SessionSearchResponse,
  SessionSearchResponseSchema,
  TerminalSessionListResponseSchema,
  type TerminalSessionResponse,
  TerminalSessionResponseSchema,
  type UpdateManagedAgentRequest,
  UpdateManagedAgentRequestSchema,
  UpdateManagedExtensionsRequestSchema,
  type UpdateManagedProjectRequest,
  UpdateManagedProjectRequestSchema,
  WorktreeListResponseSchema,
  type WorktreeResponse,
  WorktreeResponseSchema,
} from '@nextflow/contracts';
import type { MultiplexerTerminal } from '@pideck/terminal-multiplexer/client';
import { ApiError } from './api-error';

interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

interface WebSocketTicket {
  readonly ticket: string;
  readonly expiresAt: string;
}

const MultiplexerTerminalSchema: RuntimeSchema<MultiplexerTerminal> = {
  parse(value: unknown): MultiplexerTerminal {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as { id?: unknown }).id !== 'string' ||
      typeof (value as { sessionId?: unknown }).sessionId !== 'string' ||
      typeof (value as { title?: unknown }).title !== 'string' ||
      typeof (value as { cwd?: unknown }).cwd !== 'string' ||
      !['running', 'exited'].includes(String((value as { status?: unknown }).status)) ||
      typeof (value as { createdAt?: unknown }).createdAt !== 'string'
    ) {
      throw new Error('Invalid terminal multiplexer response');
    }
    return value as MultiplexerTerminal;
  },
};

const MultiplexerTerminalListSchema: RuntimeSchema<{ terminals: MultiplexerTerminal[] }> = {
  parse(value: unknown) {
    if (
      !value ||
      typeof value !== 'object' ||
      !Array.isArray((value as { terminals?: unknown }).terminals)
    ) {
      throw new Error('Invalid terminal multiplexer list');
    }
    return {
      terminals: (value as { terminals: unknown[] }).terminals.map((terminal) =>
        MultiplexerTerminalSchema.parse(terminal),
      ),
    };
  },
};

const EmptyResponseSchema: RuntimeSchema<Record<string, never>> = {
  parse() {
    return {};
  },
};

const WebSocketTicketSchema: RuntimeSchema<WebSocketTicket> = {
  parse(value: unknown): WebSocketTicket {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as { ticket?: unknown }).ticket !== 'string' ||
      typeof (value as { expiresAt?: unknown }).expiresAt !== 'string'
    ) {
      throw new Error('Invalid Supervisor WebSocket ticket');
    }
    return value as WebSocketTicket;
  },
};

export interface SupervisorClientOptions {
  readonly baseUrl?: string;
  readonly serviceToken?: string;
  readonly fetcher?: typeof fetch;
  readonly webSocketFactory?: typeof WebSocket;
  readonly requestTimeoutMs?: number;
  /** Total attempts for safe read requests. Mutating requests are never retried automatically. */
  readonly maxRequestAttempts?: number;
}

export type StreamConnectionState = 'connected' | 'reconnecting' | 'stale' | 'failed';

export interface StreamAgentEventsOptions {
  readonly afterSequence?: number;
  readonly signal?: AbortSignal;
  readonly reconnect?: boolean;
  readonly maxReconnectAttempts?: number;
  readonly detectGaps?: boolean;
  readonly onConnectionState?: (state: StreamConnectionState) => void;
}

export interface PageIterationOptions {
  readonly signal?: AbortSignal;
  readonly maxPages?: number;
}

export class SupervisorClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly webSocketFactory: typeof WebSocket | undefined;
  private readonly requestTimeoutMs: number;
  private readonly maxRequestAttempts: number;

  constructor(options: SupervisorClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.serviceToken = options.serviceToken;
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.webSocketFactory = options.webSocketFactory ?? globalThis.WebSocket;
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 30_000);
    this.maxRequestAttempts = Math.max(1, Math.floor(options.maxRequestAttempts ?? 2));
  }

  createAgent(request: CreateManagedAgentRequest): Promise<ManagedAgentResponse> {
    return this.request('/v1/agents', ManagedAgentResponseSchema, {
      method: 'POST',
      body: JSON.stringify(CreateManagedAgentRequestSchema.parse(request)),
    });
  }

  listModels(): Promise<ManagedAgentModelsResponse> {
    return this.request('/v1/models', ManagedAgentModelsResponseSchema);
  }

  listComposerSuggestions(
    request: ComposerSuggestionsRequest,
  ): Promise<ComposerSuggestionsResponse> {
    const parsed = ComposerSuggestionsRequestSchema.parse(request);
    const params = new URLSearchParams({
      cwd: parsed.cwd,
      kind: parsed.kind,
      prefix: parsed.prefix,
    });
    return this.request(
      `/v1/composer/suggestions?${params.toString()}`,
      ComposerSuggestionsResponseSchema,
    );
  }

  listExtensions(): Promise<ManagedAgentExtensionsResponse> {
    return this.request('/v1/extensions', ManagedAgentExtensionsResponseSchema);
  }

  updateExtensions(source?: string): Promise<ManagedAgentExtensionsResponse> {
    const body = UpdateManagedExtensionsRequestSchema.parse(source ? { source } : {});
    return this.request('/v1/extensions/update', ManagedAgentExtensionsResponseSchema, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  createRun(request: CreateManagedAgentRunRequest): Promise<ManagedAgentRunResponse> {
    return this.request('/v1/runs', ManagedAgentRunResponseSchema, {
      method: 'POST',
      body: JSON.stringify(CreateManagedAgentRunRequestSchema.parse(request)),
      requestTimeoutMs: 15 * 60_000,
    });
  }

  createProject(request: CreateManagedProjectRequest): Promise<ManagedProjectResponse> {
    return this.request('/v1/projects', ManagedProjectResponseSchema, {
      method: 'POST',
      body: JSON.stringify(CreateManagedProjectRequestSchema.parse(request)),
    });
  }

  updateProject(
    projectId: string,
    request: UpdateManagedProjectRequest,
  ): Promise<ManagedProjectResponse> {
    return this.request(
      `/v1/projects/${encodeURIComponent(projectId)}`,
      ManagedProjectResponseSchema,
      {
        method: 'PATCH',
        body: JSON.stringify(UpdateManagedProjectRequestSchema.parse(request)),
      },
    );
  }

  deleteProject(projectId: string): Promise<ManagedProjectResponse> {
    return this.request(
      `/v1/projects/${encodeURIComponent(projectId)}`,
      ManagedProjectResponseSchema,
      { method: 'DELETE' },
    );
  }

  listProjects(query: Partial<ManagedProjectListQuery> = {}): Promise<ManagedProjectListResponse> {
    const params = new URLSearchParams({ limit: String(query.limit ?? 100) });
    if (query.cursor) params.set('cursor', query.cursor);
    return this.request(`/v1/projects?${params.toString()}`, ManagedProjectListResponseSchema);
  }

  listRuns(query: Partial<ManagedAgentRunListQuery> = {}): Promise<ManagedAgentRunListResponse> {
    return this.listRunsPage(query);
  }

  private listRunsPage(
    query: Partial<ManagedAgentRunListQuery>,
    signal?: AbortSignal,
  ): Promise<ManagedAgentRunListResponse> {
    const params = new URLSearchParams({ limit: String(query.limit ?? 50) });
    if (query.agentId) params.set('agentId', query.agentId);
    if (query.status) params.set('status', query.status);
    if (query.cursor) params.set('cursor', query.cursor);
    return this.request(`/v1/runs?${params.toString()}`, ManagedAgentRunListResponseSchema, {
      signal,
    });
  }

  async listAllRuns(
    query: Partial<ManagedAgentRunListQuery> = {},
    options: PageIterationOptions = {},
  ): Promise<ManagedAgentRunResponse[]> {
    const runs: ManagedAgentRunResponse[] = [];
    const seenCursors = new Set<string>();
    let cursor = query.cursor;
    const maxPages = options.maxPages ?? 100;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      if (options.signal?.aborted) throw abortError();
      const page = await this.listRunsPage({ ...query, cursor }, options.signal);
      runs.push(...page.runs);
      if (!page.nextCursor) return runs;
      if (page.nextCursor === cursor || seenCursors.has(page.nextCursor)) {
        throw new Error('Supervisor pagination cursor did not advance');
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error(`Supervisor pagination exceeded ${maxPages} pages`);
  }

  getFleet(): Promise<FleetOverviewResponse> {
    return this.request('/v1/fleet', FleetOverviewResponseSchema);
  }

  getRunChanges(runId: string, scope: ChangeScope, baseRef?: string): Promise<RunChangesResponse> {
    const query = new URLSearchParams({ scope });
    if (baseRef) query.set('baseRef', baseRef);
    return this.request(
      `/v1/runs/${encodeURIComponent(runId)}/changes?${query}`,
      RunChangesResponseSchema,
    );
  }

  getRunDebugLog(runId: string): Promise<RunDebugLogResponse> {
    return this.request(
      `/v1/runs/${encodeURIComponent(runId)}/debug-log`,
      RunDebugLogResponseSchema,
    );
  }

  createWorktree(request: CreateWorktreeRequest): Promise<WorktreeResponse> {
    return this.request('/v1/worktrees', WorktreeResponseSchema, {
      method: 'POST',
      body: JSON.stringify(CreateWorktreeRequestSchema.parse(request)),
    });
  }
  listWorktrees(): Promise<{ worktrees: WorktreeResponse[] }> {
    return this.request('/v1/worktrees', WorktreeListResponseSchema);
  }
  releaseWorktree(id: string, force = false): Promise<WorktreeResponse> {
    const query = force ? '?force=true' : '';
    return this.request(`/v1/worktrees/${encodeURIComponent(id)}${query}`, WorktreeResponseSchema, {
      method: 'DELETE',
    });
  }

  listSessionTerminals(sessionId: string): Promise<{ terminals: MultiplexerTerminal[] }> {
    return this.request(
      `/v1/runs/${encodeURIComponent(sessionId)}/terminal-multiplexer/terminals`,
      MultiplexerTerminalListSchema,
    );
  }

  createSessionTerminal(sessionId: string): Promise<MultiplexerTerminal> {
    return this.request(
      `/v1/runs/${encodeURIComponent(sessionId)}/terminal-multiplexer/terminals`,
      MultiplexerTerminalSchema,
      { method: 'POST' },
    );
  }

  async closeSessionTerminal(sessionId: string, terminalId: string): Promise<void> {
    await this.request(
      `/v1/runs/${encodeURIComponent(sessionId)}/terminal-multiplexer/terminals/${encodeURIComponent(terminalId)}`,
      EmptyResponseSchema,
      { method: 'DELETE' },
    );
  }

  async openSessionTerminalSocket(sessionId: string, terminalId: string): Promise<WebSocket> {
    if (!this.webSocketFactory) throw new Error('WebSocket is not available in this environment');
    const ticket = await this.websocketTicket();
    const path = `/v1/runs/${encodeURIComponent(sessionId)}/terminal-multiplexer/terminals/${encodeURIComponent(terminalId)}/socket`;
    return new this.webSocketFactory(this.websocketUrl(path, new URLSearchParams(), ticket));
  }

  createTerminalSession(request: CreateTerminalSessionRequest): Promise<TerminalSessionResponse> {
    return this.request('/v1/terminal-sessions', TerminalSessionResponseSchema, {
      method: 'POST',
      body: JSON.stringify(CreateTerminalSessionRequestSchema.parse(request)),
    });
  }
  listTerminalSessions(): Promise<{ sessions: TerminalSessionResponse[] }> {
    return this.request('/v1/terminal-sessions', TerminalSessionListResponseSchema);
  }
  getTerminalSession(id: string): Promise<TerminalSessionResponse> {
    return this.request(
      `/v1/terminal-sessions/${encodeURIComponent(id)}`,
      TerminalSessionResponseSchema,
    );
  }
  writeTerminalSession(id: string, data: string): Promise<TerminalSessionResponse> {
    return this.request(
      `/v1/terminal-sessions/${encodeURIComponent(id)}/input`,
      TerminalSessionResponseSchema,
      { method: 'POST', body: JSON.stringify({ data }) },
    );
  }
  cancelTerminalSession(id: string): Promise<TerminalSessionResponse> {
    return this.request(
      `/v1/terminal-sessions/${encodeURIComponent(id)}/cancel`,
      TerminalSessionResponseSchema,
      { method: 'POST' },
    );
  }

  listInbox(): Promise<{ items: InboxItemResponse[] }> {
    return this.request('/v1/inbox', InboxListResponseSchema);
  }
  resolveInbox(id: string, response: string): Promise<InboxItemResponse> {
    return this.request(`/v1/inbox/${encodeURIComponent(id)}/resolve`, InboxItemResponseSchema, {
      method: 'POST',
      body: JSON.stringify({ response }),
    });
  }
  cancelInbox(id: string): Promise<InboxItemResponse> {
    return this.request(`/v1/inbox/${encodeURIComponent(id)}/cancel`, InboxItemResponseSchema, {
      method: 'POST',
    });
  }

  searchSessions(q: string, limit = 30): Promise<SessionSearchResponse> {
    const query = new URLSearchParams({ q, limit: String(limit) });
    return this.request(`/v1/sessions/search?${query}`, SessionSearchResponseSchema);
  }

  getRun(runId: string): Promise<ManagedAgentRunResponse> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}`, ManagedAgentRunResponseSchema);
  }

  getCommandReceipt(idempotencyKey: string): Promise<ManagedAgentCommandReceipt> {
    return this.request(
      `/v1/command-receipts/${encodeURIComponent(idempotencyKey)}`,
      ManagedAgentCommandReceiptSchema,
    );
  }

  cancelRun(runId: string, idempotencyKey?: string): Promise<ManagedAgentRunResponse> {
    return this.request(
      `/v1/runs/${encodeURIComponent(runId)}/cancel`,
      ManagedAgentRunResponseSchema,
      {
        method: 'POST',
        ...(idempotencyKey ? { body: JSON.stringify({ idempotencyKey }) } : {}),
      },
    );
  }

  steerRun(runId: string, request: AgentMessageRequest): Promise<ManagedAgentRunResponse> {
    return this.runCommand(runId, 'steer', AgentMessageRequestSchema.parse(request));
  }

  followUpRun(runId: string, request: AgentMessageRequest): Promise<ManagedAgentRunResponse> {
    return this.runCommand(runId, 'follow-up', AgentMessageRequestSchema.parse(request));
  }

  listRunAttachments(runId: string): Promise<ManagedAgentRunAttachmentsResponse> {
    return this.request(
      `/v1/runs/${encodeURIComponent(runId)}/attachments`,
      ManagedAgentRunAttachmentsResponseSchema,
    );
  }

  async listRunEventPage(
    runId: string,
    query: Partial<ManagedAgentEventsQuery> = {},
  ): Promise<ManagedAgentEventsResponse> {
    const params = new URLSearchParams({
      afterSequence: String(query.afterSequence ?? 0),
      limit: String(query.limit ?? 500),
    });
    if (query.beforeSequence !== undefined) {
      params.set('beforeSequence', String(query.beforeSequence));
    }
    return this.request(
      `/v1/runs/${encodeURIComponent(runId)}/events?${params.toString()}`,
      ManagedAgentEventsResponseSchema,
    );
  }

  async listRunEvents(runId: string, afterSequence = 0): Promise<ManagedAgentEventsResponse> {
    const events: ManagedAgentEvent[] = [];
    for await (const page of this.listRunEventPages(runId, afterSequence))
      events.push(...page.events);
    return { events };
  }

  async *listRunEventPages(
    runId: string,
    afterSequence = 0,
  ): AsyncGenerator<ManagedAgentEventsResponse> {
    let cursor = afterSequence;
    let hasMore = true;
    while (hasMore) {
      const page = await this.listRunEventPage(runId, { afterSequence: cursor, limit: 500 });
      yield page;
      hasMore = page.hasMore === true && page.nextSequence != null;
      if (hasMore) cursor = page.nextSequence!;
    }
  }

  listAgents(query: Partial<ManagedAgentListQuery> = {}): Promise<ManagedAgentListResponse> {
    const params = new URLSearchParams({ limit: String(query.limit ?? 50) });
    if (query.cursor) params.set('cursor', query.cursor);
    return this.request(`/v1/agents?${params.toString()}`, ManagedAgentListResponseSchema);
  }

  getAgent(agentId: string): Promise<ManagedAgentResponse> {
    return this.request(`/v1/agents/${encodeURIComponent(agentId)}`, ManagedAgentResponseSchema);
  }

  renameAgent(agentId: string, request: UpdateManagedAgentRequest): Promise<ManagedAgentResponse> {
    return this.request(`/v1/agents/${encodeURIComponent(agentId)}`, ManagedAgentResponseSchema, {
      method: 'PATCH',
      body: JSON.stringify(UpdateManagedAgentRequestSchema.parse(request)),
    });
  }

  deleteAgent(agentId: string): Promise<ManagedAgentResponse> {
    return this.request(`/v1/agents/${encodeURIComponent(agentId)}`, ManagedAgentResponseSchema, {
      method: 'DELETE',
    });
  }

  async listEvents(agentId: string, afterSequence = 0): Promise<ManagedAgentEventsResponse> {
    const events: ManagedAgentEvent[] = [];
    let cursor = afterSequence;
    let hasMore = true;
    while (hasMore) {
      const params = new URLSearchParams({ afterSequence: String(cursor) });
      const page = await this.request(
        `/v1/agents/${encodeURIComponent(agentId)}/events?${params.toString()}`,
        ManagedAgentEventsResponseSchema,
      );
      events.push(...page.events);
      hasMore = page.hasMore === true && page.nextSequence != null;
      if (hasMore) cursor = page.nextSequence as number;
    }
    return { events };
  }

  streamRunEvents(
    runId: string,
    options: StreamAgentEventsOptions = {},
  ): AsyncGenerator<ManagedAgentEvent> {
    return this.streamResourceEvents(`/v1/runs/${encodeURIComponent(runId)}/stream`, {
      ...options,
      // A run stream intentionally filters agent-level events, so global
      // sequence numbers may have legitimate gaps. Agent streams can enforce
      // contiguous replay and detect a missing page.
      detectGaps: false,
    });
  }

  async *streamEvents(
    agentId: string,
    options: StreamAgentEventsOptions = {},
  ): AsyncGenerator<ManagedAgentEvent> {
    yield* this.streamResourceEvents(`/v1/agents/${encodeURIComponent(agentId)}/stream`, options);
  }

  private async *streamResourceEvents(
    path: string,
    options: StreamAgentEventsOptions,
  ): AsyncGenerator<ManagedAgentEvent> {
    if (!this.webSocketFactory) throw new Error('WebSocket is not available in this environment');

    let lastSequence = options.afterSequence ?? 0;
    let reconnectAttempt = 0;
    const reconnect = options.reconnect ?? true;
    const maxAttempts = options.maxReconnectAttempts ?? 8;
    const signal = options.signal;

    while (!signal?.aborted) {
      options.onConnectionState?.(reconnectAttempt === 0 ? 'stale' : 'reconnecting');
      const queue = new AsyncEventQueue<ManagedAgentEvent>(500, 4_000_000);
      let socket: WebSocket | undefined;
      let receivedSequence = lastSequence;
      let closedUnexpectedly = false;
      let demonstratedHealth = false;
      const abort = () => {
        queue.end();
        socket?.close();
      };
      const onOpen = () => {
        options.onConnectionState?.('connected');
      };
      signal?.addEventListener('abort', abort, { once: true });

      let failure: Error | undefined;
      try {
        const params = new URLSearchParams({ afterSequence: String(lastSequence) });
        const ticket = await this.websocketTicket(signal);
        if (signal?.aborted) return;
        socket = new this.webSocketFactory(this.websocketUrl(path, params, ticket));
        socket.onopen = onOpen;
        socket.onmessage = (event) => {
          try {
            const encoded = typeof event.data === 'string' ? event.data : String(event.data);
            const payload = ManagedAgentEventSchema.parse(JSON.parse(encoded) as unknown);
            if (payload.sequence <= receivedSequence) return;
            if (options.detectGaps !== false && payload.sequence > receivedSequence + 1) {
              queue.fail(
                new Error(
                  `Supervisor event sequence gap: expected ${receivedSequence + 1}, received ${payload.sequence}`,
                ),
              );
              socket?.close();
              return;
            }
            if (!queue.push(payload, encoded.length)) {
              socket?.close();
              return;
            }
            receivedSequence = payload.sequence;
            if (!demonstratedHealth) {
              demonstratedHealth = true;
              reconnectAttempt = 0;
              options.onConnectionState?.('connected');
            }
          } catch (reason) {
            queue.fail(reason instanceof Error ? reason : new Error('Invalid Supervisor event'));
            socket?.close();
          }
        };
        socket.onerror = () => queue.fail(new Error('Supervisor event WebSocket failed'));
        socket.onclose = () => {
          closedUnexpectedly = !signal?.aborted;
          queue.end();
        };
        let reading = true;
        while (reading) {
          const result = await queue.next();
          if (result.done) {
            reading = false;
          } else {
            lastSequence = result.value.sequence;
            yield result.value;
          }
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Supervisor event stream failed');
      } finally {
        signal?.removeEventListener('abort', abort);
        if (socket) {
          socket.onopen = null;
          socket.onmessage = null;
          socket.onerror = null;
          socket.onclose = null;
          socket.close();
        }
      }
      if (signal?.aborted) return;
      if (!reconnect) {
        options.onConnectionState?.('failed');
        throw failure ?? new Error('Supervisor event WebSocket closed unexpectedly');
      }
      if (failure?.message.includes('sequence gap')) {
        options.onConnectionState?.('failed');
        throw failure;
      }
      if (!closedUnexpectedly && !failure) {
        // A mock or browser implementation may end without a close callback;
        // it is still an unexpected disconnect from the caller's perspective.
      }
      reconnectAttempt += 1;
      if (reconnectAttempt > maxAttempts) {
        options.onConnectionState?.('failed');
        throw failure ?? new Error('Supervisor event WebSocket reconnect limit exceeded');
      }
      options.onConnectionState?.('reconnecting');
      await delayWithSignal(reconnectDelay(reconnectAttempt), signal);
    }
  }

  private websocketUrl(path: string, params: URLSearchParams, ticket?: string): string {
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
    const url = new URL(`${this.baseUrl}/agents${path}`, origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    params.forEach((value, key) => {
      url.searchParams.set(key, value);
    });
    if (ticket) url.searchParams.set('ticket', ticket);
    return url.toString();
  }

  private async websocketTicket(signal?: AbortSignal): Promise<string | undefined> {
    // Unit-test WebSocket doubles cannot make the ticket HTTP request. Real
    // browser sockets always use a short-lived ticket; service tokens never
    // enter the URL.
    if (this.webSocketFactory !== globalThis.WebSocket && !this.serviceToken) return undefined;
    const response = await this.request('/v1/ws-tickets', WebSocketTicketSchema, {
      method: 'POST',
      signal,
    });
    return response.ticket;
  }

  private runCommand(
    runId: string,
    command: 'steer' | 'follow-up',
    body: AgentMessageRequest,
  ): Promise<ManagedAgentRunResponse> {
    return this.request(
      `/v1/runs/${encodeURIComponent(runId)}/${command}`,
      ManagedAgentRunResponseSchema,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  private async request<T>(
    path: string,
    schema: RuntimeSchema<T>,
    init: RequestInit & { requestTimeoutMs?: number } = {},
  ): Promise<T> {
    const { requestTimeoutMs = this.requestTimeoutMs, ...fetchInit } = init;
    const method = (fetchInit.method ?? 'GET').toUpperCase();
    const attempts = method === 'GET' || method === 'HEAD' ? this.maxRequestAttempts : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = globalThis.setTimeout(
        () => controller.abort(new DOMException('Supervisor request timed out', 'TimeoutError')),
        requestTimeoutMs,
      );
      const abort = () => controller.abort(fetchInit.signal?.reason);
      fetchInit.signal?.addEventListener('abort', abort, { once: true });
      if (fetchInit.signal?.aborted) abort();
      try {
        let response: Response;
        try {
          response = await this.fetcher(`${this.baseUrl}/agents${path}`, {
            ...fetchInit,
            signal: controller.signal,
            headers: {
              ...this.headers('application/json'),
              ...(fetchInit.body ? { 'Content-Type': 'application/json' } : {}),
              ...fetchInit.headers,
            },
          });
        } catch (reason) {
          if (
            attempt + 1 < attempts &&
            !fetchInit.signal?.aborted &&
            !controller.signal.aborted &&
            isRetryableReadFailure(reason)
          ) {
            await delayWithSignal(requestRetryDelay(attempt), fetchInit.signal ?? undefined);
            continue;
          }
          throw reason;
        }

        if (!response.ok) {
          const error = await responseError(response);
          if (attempt + 1 < attempts && isRetryableReadStatus(response.status)) {
            await delayWithSignal(requestRetryDelay(attempt), fetchInit.signal ?? undefined);
            continue;
          }
          throw error;
        }
        if (response.status === 204) return schema.parse({});
        return schema.parse(await response.json());
      } finally {
        globalThis.clearTimeout(timeout);
        fetchInit.signal?.removeEventListener('abort', abort);
      }
    }

    throw new Error('Supervisor request attempts exhausted');
  }

  private headers(accept: string): Record<string, string> {
    return {
      Accept: accept,
      ...(this.serviceToken ? { Authorization: `Bearer ${this.serviceToken}` } : {}),
    };
  }
}

class AsyncEventQueue<T> {
  private readonly values: Array<{ value: T; bytes: number }> = [];
  private readonly waiters: Array<{
    resolve(result: IteratorResult<T>): void;
    reject(error: Error): void;
  }> = [];
  private readonly maxCount: number;
  private readonly maxBytes: number;
  private bufferedBytes = 0;
  private ended = false;
  private failure: Error | undefined;

  constructor(maxCount = Number.POSITIVE_INFINITY, maxBytes = Number.POSITIVE_INFINITY) {
    this.maxCount = maxCount;
    this.maxBytes = maxBytes;
  }

  push(value: T, bytes = 1): boolean {
    if (this.ended) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return true;
    }
    if (this.values.length >= this.maxCount || this.bufferedBytes + bytes > this.maxBytes) {
      this.fail(new Error('Supervisor event buffer exceeded its safe limit'));
      return false;
    }
    this.values.push({ value, bytes });
    this.bufferedBytes += bytes;
    return true;
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.failure = error;
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()?.reject(error);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()?.resolve({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<T>> {
    const entry = this.values.shift();
    if (entry !== undefined) {
      this.bufferedBytes -= entry.bytes;
      return Promise.resolve({ done: false, value: entry.value });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

function isRetryableReadFailure(reason: unknown): boolean {
  return !(reason instanceof DOMException && ['AbortError', 'TimeoutError'].includes(reason.name));
}

function isRetryableReadStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function requestRetryDelay(attempt: number): number {
  return Math.min(1_000, 100 * 2 ** attempt);
}

function reconnectDelay(attempt: number): number {
  const capped = Math.min(10_000, 250 * 2 ** Math.max(0, attempt - 1));
  return Math.round(capped * (0.75 + Math.random() * 0.5));
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

async function responseError(response: Response): Promise<ApiError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return new ApiError(
      response.status,
      'internal_error',
      `Supervisor request failed with HTTP ${response.status}`,
    );
  }
  const parsed = ErrorResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return new ApiError(
      response.status,
      'internal_error',
      `Supervisor request failed with HTTP ${response.status}`,
    );
  }
  return new ApiError(
    response.status,
    parsed.data.error.code,
    parsed.data.error.message,
    parsed.data.error.details,
  );
}

export function modelDisplayName(
  model: AgentModel | null | undefined,
  availableModels: ManagedAgentModelsResponse | undefined,
): string {
  if (!model) return availableModels?.defaultModel?.name ?? 'No model configured';

  return (
    availableModels?.models.find(
      (candidate) => candidate.provider === model.provider && candidate.id === model.id,
    )?.name ?? model.id
  );
}

export const supervisorClient = new SupervisorClient({ baseUrl: '' });
