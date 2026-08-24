import {
  type AgentMessageRequest,
  AgentMessageRequestSchema,
  type AgentModel,
  type CreateManagedAgentRequest,
  CreateManagedAgentRequestSchema,
  type CreateManagedAgentRunRequest,
  CreateManagedAgentRunRequestSchema,
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
}

export interface StreamAgentEventsOptions {
  readonly afterSequence?: number;
  readonly signal?: AbortSignal;
}

export class SupervisorClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: SupervisorClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '/supervisor-api').replace(/\/$/, '');
    this.serviceToken = options.serviceToken;
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
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
    const params = new URLSearchParams({
      afterSequence: String(options.afterSequence ?? 0),
    });
    const response = await this.fetcher(`${this.baseUrl}${path}?${params.toString()}`, {
      method: 'GET',
      ...(options.signal ? { signal: options.signal } : {}),
      headers: this.headers('text/event-stream'),
    });
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw new Error('Supervisor event stream returned no response body');

    for await (const payload of parseServerSentEvents(response.body)) {
      yield ManagedAgentEventSchema.parse(payload);
    }
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

export async function* parseServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  const parseBlock = (): unknown | undefined => {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join('\n');
    dataLines = [];
    return JSON.parse(data) as unknown;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          const payload = parseBlock();
          if (payload !== undefined) yield payload;
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        newlineIndex = buffer.indexOf('\n');
      }

      if (done) break;
    }

    if (buffer.length > 0) {
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const payload = parseBlock();
    if (payload !== undefined) yield payload;
  } finally {
    reader.releaseLock();
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
