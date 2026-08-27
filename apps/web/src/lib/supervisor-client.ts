import {
  type AgentMessageRequest,
  AgentMessageRequestSchema,
  type AgentModel,
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
  ErrorResponseSchema,
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
  type UpdateManagedAgentRequest,
  UpdateManagedAgentRequestSchema,
  UpdateManagedExtensionsRequestSchema,
  type UpdateManagedProjectRequest,
  UpdateManagedProjectRequestSchema,
  type ChangeScope,
  type CreateTerminalSessionRequest,
  CreateTerminalSessionRequestSchema,
  type CreateWorktreeRequest,
  CreateWorktreeRequestSchema,
  type FleetOverviewResponse,
  FleetOverviewResponseSchema,
  type InboxItemResponse,
  InboxItemResponseSchema,
  InboxListResponseSchema,
  type RunChangesResponse,
  RunChangesResponseSchema,
  type SessionSearchResponse,
  SessionSearchResponseSchema,
  type TerminalSessionResponse,
  TerminalSessionListResponseSchema,
  TerminalSessionResponseSchema,
  type WorktreeResponse,
  WorktreeListResponseSchema,
  WorktreeResponseSchema,
} from '@nextflow/contracts';
import { ApiError } from './api-error';

interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

interface WebSocketTicket {
  readonly ticket: string;
  readonly expiresAt: string;
}

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

  constructor(options: SupervisorClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '/supervisor-api').replace(/\/$/, '');
    this.serviceToken = options.serviceToken;
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.webSocketFactory = options.webSocketFactory ?? globalThis.WebSocket;
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 30_000);
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
      if (hasMore) cursor = page.nextSequence;
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
      const queue = new AsyncEventQueue<ManagedAgentEvent>();
      let socket: WebSocket | undefined;
      let closedUnexpectedly = false;
      let demonstratedHealth = false;
      const abort = () => {
        queue.end();
        socket?.close();
      };
      const onOpen = () => {
        options.onConnectionState?.('stale');
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
            const payload = ManagedAgentEventSchema.parse(
              JSON.parse(
                typeof event.data === 'string' ? event.data : String(event.data),
              ) as unknown,
            );
            if (payload.sequence <= lastSequence) return;
            if (options.detectGaps !== false && payload.sequence > lastSequence + 1) {
              queue.fail(
                new Error(
                  `Supervisor event sequence gap: expected ${lastSequence + 1}, received ${payload.sequence}`,
                ),
              );
              socket?.close();
              return;
            }
            lastSequence = payload.sequence;
            if (!demonstratedHealth) {
              demonstratedHealth = true;
              reconnectAttempt = 0;
              options.onConnectionState?.('connected');
            }
            queue.push(payload);
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
    const url = new URL(`${this.baseUrl}${path}`, origin);
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
    init: RequestInit = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(
      () => controller.abort(new DOMException('Supervisor request timed out', 'TimeoutError')),
      this.requestTimeoutMs,
    );
    const abort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) abort();
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...this.headers('application/json'),
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
      if (!response.ok) {
        throw await responseError(response);
      }
      return schema.parse(await response.json());
    } finally {
      globalThis.clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abort);
    }
  }

  private headers(accept: string): Record<string, string> {
    return {
      Accept: accept,
      ...(this.serviceToken ? { Authorization: `Bearer ${this.serviceToken}` } : {}),
    };
  }
}

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve(result: IteratorResult<T>): void;
    reject(error: Error): void;
  }> = [];
  private ended = false;
  private failure: Error | undefined;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
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
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
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
