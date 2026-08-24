import type {
  ManagedAgentEvent,
  ManagedAgentResponse,
  ManagedAgentRunResponse,
} from '@nextflow/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import App, { type SupervisorClientApi } from './App';

const timestamp = '2026-08-23T20:00:00.000Z';
const agent: ManagedAgentResponse = {
  id: '018bcfe4-7a4b-7000-8000-000000000111',
  name: 'Workspace agent',
  systemPrompt: 'Be careful.',
  model: null,
  thinkingLevel: null,
  cwd: '/workspace',
  tools: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const run: ManagedAgentRunResponse = {
  id: '018bcfe4-7a4b-7000-8000-000000000222',
  agentId: agent.id,
  prompt: 'Review the changes.',
  model: { provider: 'fake', id: 'fake-model' },
  thinkingLevel: 'medium',
  cwd: '/workspace',
  status: 'completed',
  error: null,
  createdAt: timestamp,
  startedAt: timestamp,
  completedAt: timestamp,
};

function emptyStream(): AsyncGenerator<ManagedAgentEvent> {
  return (async function* () {})();
}

function createClient(overrides: Partial<SupervisorClientApi> = {}): SupervisorClientApi {
  return {
    listAgents: vi.fn().mockResolvedValue({ agents: [], nextCursor: null }),
    listModels: vi.fn().mockResolvedValue({
      models: [{ provider: 'fake', id: 'fake-model', name: 'Fake model' }],
      defaultModel: { provider: 'fake', id: 'fake-model', name: 'Fake model' },
    }),
    listRuns: vi.fn().mockResolvedValue({ runs: [], nextCursor: null }),
    listRunEvents: vi.fn().mockResolvedValue({ events: [] }),
    streamRunEvents: vi.fn().mockImplementation(emptyStream),
    getRun: vi.fn().mockResolvedValue(run),
    createAgent: vi.fn().mockResolvedValue(agent),
    renameAgent: vi.fn().mockResolvedValue(agent),
    deleteAgent: vi.fn().mockResolvedValue(agent),
    createRun: vi.fn().mockResolvedValue({ ...run, status: 'running', completedAt: null }),
    cancelRun: vi.fn().mockResolvedValue({ ...run, status: 'cancelled' }),
    ...overrides,
  };
}

describe('App', () => {
  it('creates the first persisted agent from the empty state', async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<App client={client} />);

    expect(await screen.findByText('Create an agent profile first')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open agent settings' }));
    await user.click(screen.getByRole('button', { name: 'New agent' }));
    await user.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() =>
      expect(client.createAgent).toHaveBeenCalledWith({
        name: 'Coding agent',
        systemPrompt: expect.stringContaining('Inspect the workspace carefully'),
      }),
    );
  });

  it('renders the prompt, coalesced PI response, and lifecycle markers', async () => {
    const events: ManagedAgentEvent[] = [
      {
        agentId: agent.id,
        runId: run.id,
        sequence: 1,
        type: 'agent_start',
        payload: {},
        createdAt: timestamp,
      },
      {
        agentId: agent.id,
        runId: run.id,
        sequence: 2,
        type: 'message_update',
        payload: { assistantMessageEvent: { type: 'text_delta', delta: 'Looks ' } },
        createdAt: timestamp,
      },
      {
        agentId: agent.id,
        runId: run.id,
        sequence: 3,
        type: 'message_update',
        payload: { assistantMessageEvent: { type: 'text_delta', delta: 'good.' } },
        createdAt: timestamp,
      },
    ];
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
      listRunEvents: vi.fn().mockResolvedValue({ events }),
    });
    render(<App client={client} />);

    expect(await screen.findByRole('heading', { name: 'Review the changes.' })).toBeVisible();
    expect(await screen.findByText('PI started the run')).toBeVisible();
    expect(await screen.findByText('Looks good.')).toBeVisible();
    expect(screen.getByLabelText('Workspace agent conversation')).toBeInTheDocument();
  });

  it('merges SSE events that arrive before persisted event replay completes', async () => {
    let resolveReplay!: (value: { events: ManagedAgentEvent[] }) => void;
    const replay = new Promise<{ events: ManagedAgentEvent[] }>((resolve) => {
      resolveReplay = resolve;
    });
    const streamedEvent: ManagedAgentEvent = {
      agentId: agent.id,
      runId: run.id,
      sequence: 2,
      type: 'message_update',
      payload: { assistantMessageEvent: { type: 'text_delta', delta: 'Streamed first.' } },
      createdAt: timestamp,
    };
    const persistedEvent: ManagedAgentEvent = {
      agentId: agent.id,
      runId: run.id,
      sequence: 1,
      type: 'agent_start',
      payload: {},
      createdAt: timestamp,
    };
    const streamRunEvents = vi.fn().mockImplementation(() =>
      (async function* () {
        yield streamedEvent;
      })(),
    );
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
      listRunEvents: vi.fn().mockReturnValue(replay),
      streamRunEvents,
    });
    render(<App client={client} />);

    await waitFor(() => expect(streamRunEvents).toHaveBeenCalled());
    resolveReplay({ events: [persistedEvent] });

    expect(await screen.findByText('PI started the run')).toBeVisible();
    expect(screen.getByText('Streamed first.')).toBeVisible();
  });

  it('starts and cancels a run through the server process manager', async () => {
    const user = userEvent.setup();
    const activeRun = {
      ...run,
      prompt: 'Inspect the workspace',
      status: 'running' as const,
      completedAt: null,
    };
    const cancelledRun = { ...activeRun, status: 'cancelled' as const };
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      createRun: vi.fn().mockResolvedValue(activeRun),
      cancelRun: vi.fn().mockResolvedValue(cancelledRun),
    });
    render(<App client={client} />);

    const composer = await screen.findByRole('textbox', { name: 'Session task' });
    await user.type(composer, 'Inspect the workspace');
    await user.click(screen.getByRole('button', { name: 'Start session' }));

    await waitFor(() =>
      expect(client.createRun).toHaveBeenCalledWith({
        agentId: agent.id,
        prompt: 'Inspect the workspace',
        model: { provider: 'fake', id: 'fake-model' },
        thinkingLevel: 'medium',
        cwd: '/workspace',
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(client.cancelRun).toHaveBeenCalledWith(run.id));
    expect(await screen.findByText('Cancelled')).toBeVisible();
  });

  it('shows actionable supervisor failures', async () => {
    const client = createClient({
      listAgents: vi.fn().mockRejectedValue(new Error('Supervisor is offline')),
    });
    render(<App client={client} />);

    expect(await screen.findByText('Supervisor request failed')).toBeVisible();
    expect(screen.getByText('Supervisor is offline')).toBeVisible();
  });
});
