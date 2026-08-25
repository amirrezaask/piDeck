import type { ManagedAgentResponse } from '@nextflow/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import { modelDisplayName, SupervisorClient } from './supervisor-client';

const agentId = '018bcfe4-7a4b-7000-8000-000000000111';
const timestamp = '2026-08-23T20:00:00.000Z';
const agent: ManagedAgentResponse = {
  id: agentId,
  name: 'Release reviewer',
  systemPrompt: 'You are a careful software engineering agent.',
  model: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
  thinkingLevel: 'high',
  cwd: '/workspace',
  tools: ['read', 'bash'],
  createdAt: timestamp,
  updatedAt: timestamp,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class FakeWebSocket {
  static last: FakeWebSocket | undefined;
  readonly url: string;
  readonly readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
    queueMicrotask(() =>
      this.onmessage?.({
        data: JSON.stringify({
          agentId,
          runId: null,
          sequence: 8,
          type: 'agent_start',
          payload: {},
          createdAt: timestamp,
        }),
      }),
    );
  }

  close(): void {
    this.onclose?.();
  }
}

class ScriptedWebSocket {
  static scripts: Array<(socket: ScriptedWebSocket) => void> = [];
  static created = 0;
  readonly url: string;
  readonly readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    const script = ScriptedWebSocket.scripts[ScriptedWebSocket.created++];
    queueMicrotask(() => {
      this.onopen?.();
      script?.(this);
    });
  }

  emit(sequence: number): void {
    this.onmessage?.({
      data: JSON.stringify({
        agentId,
        runId: null,
        sequence,
        type: 'agent_start',
        payload: {},
        createdAt: timestamp,
      }),
    });
  }

  close(): void {
    this.onclose?.();
  }
}

describe('SupervisorClient', () => {
  afterEach(() => {
    ScriptedWebSocket.scripts = [];
    ScriptedWebSocket.created = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses the configured model name when an agent inherits the default', () => {
    const models = {
      models: [{ provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
      defaultModel: { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    };

    expect(modelDisplayName(null, models)).toBe('GPT-5.6 Sol');
    expect(modelDisplayName({ provider: 'openai-codex', id: 'gpt-5.6-sol' }, models)).toBe(
      'GPT-5.6 Sol',
    );
  });

  it('creates an agent with validated input and service authentication', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(agent, 201));
    const client = new SupervisorClient({
      baseUrl: 'http://supervisor.test/',
      serviceToken: 'service-secret',
      fetcher,
    });

    await expect(
      client.createAgent({
        systemPrompt: 'You are a CI agent.',
        tools: ['read', 'bash'],
      }),
    ).resolves.toEqual(agent);
    expect(fetcher).toHaveBeenCalledWith(
      'http://supervisor.test/v1/agents',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer service-secret',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          systemPrompt: 'You are a CI agent.',
          tools: ['read', 'bash'],
        }),
      }),
    );
  });

  it('creates and lists projects with validated paths', async () => {
    const project = {
      id: '018bcfe4-7a4b-7000-8000-000000000333',
      name: 'workspace',
      path: '/workspace',
      createdAt: timestamp,
      updatedAt: timestamp,
      lastUsedAt: timestamp,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(project, 201))
      .mockResolvedValueOnce(jsonResponse({ projects: [project], nextCursor: null }));
    const client = new SupervisorClient({ baseUrl: '/supervisor-api', fetcher });

    await expect(client.createProject({ path: '/workspace' })).resolves.toEqual(project);
    await expect(client.listProjects({ limit: 12 })).resolves.toEqual({
      projects: [project],
      nextCursor: null,
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/supervisor-api/v1/projects',
      '/supervisor-api/v1/projects?limit=12',
    ]);
  });

  it('loads persisted run attachments', async () => {
    const response = {
      attachments: [
        {
          name: 'screen.png',
          mimeType: 'image/png',
          data: 'aW1hZ2UgYnl0ZXM=',
        },
      ],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(response));
    const client = new SupervisorClient({ baseUrl: '/supervisor-api', fetcher });

    await expect(client.listRunAttachments('run-123')).resolves.toEqual(response);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/supervisor-api/v1/runs/run-123/attachments');
  });

  it('updates a project by id', async () => {
    const project = {
      id: '018bcfe4-7a4b-7000-8000-000000000333',
      name: 'Renamed workspace',
      path: '/workspace-renamed',
      createdAt: timestamp,
      updatedAt: timestamp,
      lastUsedAt: timestamp,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(project));
    const client = new SupervisorClient({ baseUrl: '/supervisor-api', fetcher });

    await expect(
      client.updateProject(project.id, { name: project.name, path: project.path }),
    ).resolves.toEqual(project);
    expect(fetcher).toHaveBeenCalledWith(
      `/supervisor-api/v1/projects/${project.id}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: project.name, path: project.path }),
      }),
    );
  });

  it('deletes a project by id', async () => {
    const project = {
      id: '018bcfe4-7a4b-7000-8000-000000000333',
      name: 'workspace',
      path: '/workspace',
      createdAt: timestamp,
      updatedAt: timestamp,
      lastUsedAt: timestamp,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(project));
    const client = new SupervisorClient({ baseUrl: '/supervisor-api', fetcher });

    await expect(client.deleteProject(project.id)).resolves.toEqual(project);
    expect(fetcher).toHaveBeenCalledWith(
      `/supervisor-api/v1/projects/${project.id}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('lists configured models before agent creation', async () => {
    const response = {
      models: [{ provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
      defaultModel: { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(response));
    const client = new SupervisorClient({ baseUrl: '/supervisor-api', fetcher });

    await expect(client.listModels()).resolves.toEqual(response);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/supervisor-api/v1/models');
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' }),
      }),
    );
  });

  it('lists extensions and updates one configured package', async () => {
    const response = {
      extensions: [
        {
          id: 'npm:pi-tools:/pi-tools/index.ts',
          name: 'pi-tools',
          description: 'Useful Pi tools.',
          path: '/pi-tools/index.ts',
          relativePath: 'index.ts',
          source: 'npm:pi-tools',
          packageName: 'pi-tools',
          scope: 'user',
          origin: 'package',
          enabled: true,
          version: '1.0.0',
          status: 'up_to_date',
        },
      ],
      cwd: '/workspace',
      checkedAt: timestamp,
      updateCheckError: null,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(response))
      .mockResolvedValueOnce(jsonResponse(response));
    const client = new SupervisorClient({ baseUrl: '/supervisor-api', fetcher });

    await expect(client.listExtensions()).resolves.toEqual(response);
    await expect(client.updateExtensions('npm:pi-tools')).resolves.toEqual(response);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/supervisor-api/v1/extensions');
    expect(fetcher.mock.calls[1]?.[0]).toBe('/supervisor-api/v1/extensions/update');
    expect(fetcher.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ source: 'npm:pi-tools' }),
      }),
    );
  });

  it('renames an agent with a validated PATCH request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(agent));
    const client = new SupervisorClient({ baseUrl: '/supervisor-api', fetcher });

    await expect(
      client.renameAgent(agentId, { name: 'Release owner', systemPrompt: 'Review releases.' }),
    ).resolves.toEqual(agent);
    expect(fetcher).toHaveBeenCalledWith(
      `/supervisor-api/v1/agents/${agentId}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: 'Release owner', systemPrompt: 'Review releases.' }),
      }),
    );
  });

  it('lists and reads agents with encoded query parameters', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ agents: [agent], nextCursor: 'next' }))
      .mockResolvedValueOnce(jsonResponse(agent));
    const client = new SupervisorClient({ baseUrl: '/supervisor-api', fetcher });

    await expect(client.listAgents({ limit: 12, cursor: 'a/b' })).resolves.toEqual({
      agents: [agent],
      nextCursor: 'next',
    });
    await expect(client.getAgent(agentId)).resolves.toEqual(agent);

    expect(fetcher.mock.calls[0]?.[0]).toBe('/supervisor-api/v1/agents?limit=12&cursor=a%2Fb');
    expect(fetcher.mock.calls[1]?.[0]).toBe(`/supervisor-api/v1/agents/${agentId}`);
  });

  it('sends run controls and deletes definitions through their own resources', async () => {
    const runId = '018bcfe4-7a4b-7000-8000-000000000222';
    const run = {
      id: runId,
      agentId,
      prompt: 'Review this.',
      model: { provider: 'fake', id: 'fake-model' },
      thinkingLevel: 'medium',
      cwd: '/workspace',
      status: 'running',
      error: null,
      createdAt: timestamp,
      startedAt: timestamp,
      completedAt: null,
    };
    const event = {
      agentId,
      runId,
      sequence: 7,
      type: 'agent_settled',
      payload: {},
      createdAt: timestamp,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(run, 202))
      .mockResolvedValueOnce(jsonResponse(run, 202))
      .mockResolvedValueOnce(jsonResponse(agent))
      .mockResolvedValueOnce(jsonResponse({ events: [event] }));
    const client = new SupervisorClient({ fetcher });

    await expect(client.steerRun(runId, { message: 'Change course.' })).resolves.toEqual(run);
    await expect(client.followUpRun(runId, { message: 'Then summarize.' })).resolves.toEqual(run);
    await expect(client.deleteAgent(agentId)).resolves.toEqual(agent);
    await expect(client.listRunEvents(runId, 6)).resolves.toEqual({ events: [event] });

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `/supervisor-api/v1/runs/${runId}/steer`,
      `/supervisor-api/v1/runs/${runId}/follow-up`,
      `/supervisor-api/v1/agents/${agentId}`,
      `/supervisor-api/v1/runs/${runId}/events?afterSequence=6`,
    ]);
  });

  it('preserves structured Supervisor errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: { code: 'agent_busy', message: 'Agent is already running', details: { id: 1 } },
        },
        409,
      ),
    );
    const client = new SupervisorClient({ fetcher });

    const error = await client
      .steerRun('018bcfe4-7a4b-7000-8000-000000000222', { message: 'Continue.' })
      .catch((reason) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'agent_busy',
      message: 'Agent is already running',
      details: { id: 1 },
    });
  });

  it('rejects malformed successful responses at the contract boundary', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: agentId }));
    const client = new SupervisorClient({ fetcher });

    await expect(client.getAgent(agentId)).rejects.toThrow();
  });

  it('reconnects, deduplicates replay, and resumes from the last delivered sequence', async () => {
    ScriptedWebSocket.scripts = [
      (socket) => {
        socket.emit(1);
        socket.onclose?.();
      },
      (socket) => {
        socket.emit(1);
        socket.emit(2);
      },
    ];
    const states: string[] = [];
    const events: number[] = [];
    const controller = new AbortController();
    const client = new SupervisorClient({
      webSocketFactory: ScriptedWebSocket as unknown as typeof WebSocket,
    });
    for await (const event of client.streamEvents(agentId, {
      signal: controller.signal,
      onConnectionState: (state) => states.push(state),
    })) {
      events.push(event.sequence);
      if (events.length === 2) controller.abort();
    }
    expect(events).toEqual([1, 2]);
    expect(states).toContain('reconnecting');
    expect(states).toContain('connected');
  });

  it('surfaces missing sequences instead of hiding a replay gap', async () => {
    ScriptedWebSocket.scripts = [
      (socket) => {
        socket.emit(1);
        socket.emit(3);
      },
    ];
    const client = new SupervisorClient({
      webSocketFactory: ScriptedWebSocket as unknown as typeof WebSocket,
    });
    const consume = async () => {
      for await (const _event of client.streamEvents(agentId, { maxReconnectAttempts: 0 })) {
        // The second frame must reject the stream.
      }
    };
    await expect(consume()).rejects.toThrow(/sequence gap/);
  });

  it('fails after capped reconnect attempts and supports cancellation while backing off', async () => {
    ScriptedWebSocket.scripts = [(socket) => socket.onclose?.(), (socket) => socket.onclose?.()];
    const client = new SupervisorClient({
      webSocketFactory: ScriptedWebSocket as unknown as typeof WebSocket,
    });
    const iterator = client.streamEvents(agentId, { maxReconnectAttempts: 1 });
    await expect(iterator.next()).rejects.toThrow(/reconnect limit/);
  });

  it('streams JSON event frames over WebSocket after the requested sequence', async () => {
    const client = new SupervisorClient({
      baseUrl: '/supervisor-api',
      webSocketFactory: FakeWebSocket as unknown as typeof WebSocket,
    });

    const events = [];
    const controller = new AbortController();
    for await (const event of client.streamEvents(agentId, {
      afterSequence: 7,
      reconnect: false,
      signal: controller.signal,
    })) {
      events.push(event);
      controller.abort();
    }

    expect(events.map((event) => [event.sequence, event.type])).toEqual([[8, 'agent_start']]);
    expect(FakeWebSocket.last?.url).toBe(
      `ws://localhost:3000/supervisor-api/v1/agents/${agentId}/stream?afterSequence=7`,
    );
  });
});
