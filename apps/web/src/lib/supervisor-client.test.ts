import type { ManagedAgentResponse } from '@nextflow/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import { modelDisplayName, parseServerSentEvents, SupervisorClient } from './supervisor-client';

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

describe('SupervisorClient', () => {
  afterEach(() => vi.restoreAllMocks());

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

  it('streams fragmented SSE frames and ignores comments and event metadata', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': keep-alive\r\nid: 1\r\nevent: agent_start\r\nda'));
        controller.enqueue(
          encoder.encode(
            `ta: ${JSON.stringify({
              agentId,
              runId: null,
              sequence: 1,
              type: 'agent_start',
              payload: {},
              createdAt: timestamp,
            })}\r\n\r\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              agentId,
              runId: null,
              sequence: 2,
              type: 'message_update',
              payload: { delta: 'hello' },
              createdAt: timestamp,
            })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      );
    const client = new SupervisorClient({ fetcher });

    const events = [];
    for await (const event of client.streamEvents(agentId, { afterSequence: 0 })) {
      events.push(event);
    }

    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [1, 'agent_start'],
      [2, 'message_update'],
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      `/supervisor-api/v1/agents/${agentId}/stream?afterSequence=0`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Accept: 'text/event-stream' }),
      }),
    );
  });
});

describe('parseServerSentEvents', () => {
  it('joins multiple data lines and flushes a final frame without a blank line', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"value":\ndata: 42}'));
        controller.close();
      },
    });
    const values = [];
    for await (const value of parseServerSentEvents(stream)) values.push(value);
    expect(values).toEqual([{ value: 42 }]);
  });
});
