import {
  type AgentMessageRequest,
  AgentMessageRequestSchema,
  type AgentModel,
  type CreateManagedAgentRequest,
  CreateManagedAgentRequestSchema,
  type CreateManagedAgentRunRequest,
  CreateManagedAgentRunRequestSchema,
  type CreateManagedProjectRequest,
  CreateManagedProjectRequestSchema,
  ErrorResponseSchema,
  type ManagedAgentEvent,
  ManagedAgentEventSchema,
  type ManagedAgentEventsResponse,
  ManagedAgentEventsResponseSchema,
  type ManagedAgentListQuery,
  type ManagedAgentListResponse,
  ManagedAgentListResponseSchema,
  type ManagedAgentModelsResponse,
  ManagedAgentModelsResponseSchema,
  type ManagedAgentResponse,
  ManagedAgentResponseSchema,
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
} from '@nextflow/contracts';
import { ApiError } from './api-error';

interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

export interface SupervisorClientOptions {
  readonly baseUrl?: string;
  readonly serviceToken?: string;
  readonly fetcher?: typeof fetch;
  readonly webSocketFactory?: typeof WebSocket;
}

export interface StreamAgentEventsOptions {
  readonly afterSequence?: number;
  readonly signal?: AbortSignal;
}

export class SupervisorClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly webSocketFactory: typeof WebSocket | undefined;

  constructor(options: SupervisorClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '/supervisor-api').replace(/\/$/, '');
    this.serviceToken = options.serviceToken;
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.webSocketFactory = options.webSocketFactory ?? globalThis.WebSocket;
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
    const params = new URLSearchParams({ limit: String(query.limit ?? 50) });
    if (query.agentId) params.set('agentId', query.agentId);
    if (query.status) params.set('status', query.status);
    if (query.cursor) params.set('cursor', query.cursor);
    return this.request(`/v1/runs?${params.toString()}`, ManagedAgentRunListResponseSchema);
  }

  getRun(runId: string): Promise<ManagedAgentRunResponse> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}`, ManagedAgentRunResponseSchema);
  }

  cancelRun(runId: string): Promise<ManagedAgentRunResponse> {
    return this.request(
      `/v1/runs/${encodeURIComponent(runId)}/cancel`,
      ManagedAgentRunResponseSchema,
      { method: 'POST' },
    );
  }

  steerRun(runId: string, request: AgentMessageRequest): Promise<ManagedAgentRunResponse> {
    return this.runCommand(runId, 'steer', AgentMessageRequestSchema.parse(request));
  }

  followUpRun(runId: string, request: AgentMessageRequest): Promise<ManagedAgentRunResponse> {
    return this.runCommand(runId, 'follow-up', AgentMessageRequestSchema.parse(request));
  }

  listRunEvents(runId: string, afterSequence = 0): Promise<ManagedAgentEventsResponse> {
    const params = new URLSearchParams({ afterSequence: String(afterSequence) });
    return this.request(
      `/v1/runs/${encodeURIComponent(runId)}/events?${params.toString()}`,
      ManagedAgentEventsResponseSchema,
    );
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

  listEvents(agentId: string, afterSequence = 0): Promise<ManagedAgentEventsResponse> {
    const params = new URLSearchParams({ afterSequence: String(afterSequence) });
    return this.request(
      `/v1/agents/${encodeURIComponent(agentId)}/events?${params.toString()}`,
      ManagedAgentEventsResponseSchema,
    );
  }

  streamRunEvents(
    runId: string,
    options: StreamAgentEventsOptions = {},
  ): AsyncGenerator<ManagedAgentEvent> {
    return this.streamResourceEvents(`/v1/runs/${encodeURIComponent(runId)}/stream`, options);
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

    const params = new URLSearchParams({
      afterSequence: String(options.afterSequence ?? 0),
    });
    const socketUrl = this.websocketUrl(path, params);
    const socket = new this.webSocketFactory(socketUrl);
    const queue = new AsyncEventQueue<ManagedAgentEvent>();
    const abort = () => {
      queue.end();
      socket.close();
    };

    socket.onmessage = (event) => {
      try {
        const payload = typeof event.data === 'string' ? event.data : String(event.data);
        queue.push(ManagedAgentEventSchema.parse(JSON.parse(payload) as unknown));
      } catch (reason) {
        queue.fail(reason instanceof Error ? reason : new Error('Invalid Supervisor event'));
        socket.close();
      }
    };
    socket.onerror = () => queue.fail(new Error('Supervisor event WebSocket failed'));
    socket.onclose = () => queue.end();
    options.signal?.addEventListener('abort', abort, { once: true });

    try {
      while (true) {
        const result = await queue.next();
        if (result.done) return;
        yield result.value;
      }
    } finally {
      options.signal?.removeEventListener('abort', abort);
      socket.close();
    }
  }

  private websocketUrl(path: string, params: URLSearchParams): string {
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
    const url = new URL(`${this.baseUrl}${path}`, origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    params.forEach((value, key) => url.searchParams.set(key, value));
    if (this.serviceToken) url.searchParams.set('token', this.serviceToken);
    return url.toString();
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
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
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
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;
  private failure: Error | undefined;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.failure = error;
    this.end();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
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

export const supervisorClient = new SupervisorClient({ baseUrl: '/supervisor' });
