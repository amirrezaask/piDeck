import type {
  ManagedAgentEvent,
  ManagedAgentResponse,
  ManagedAgentRunResponse,
  ManagedProjectResponse,
} from '@nextflow/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
const project: ManagedProjectResponse = {
  id: '018bcfe4-7a4b-7000-8000-000000000333',
  name: 'workspace',
  path: '/workspace',
  createdAt: timestamp,
  updatedAt: timestamp,
  lastUsedAt: timestamp,
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

afterEach(() => {
  document.documentElement.classList.remove('dark');
  document.documentElement.style.colorScheme = '';
  window.localStorage.removeItem('pideck-theme');
  window.localStorage.removeItem('pideck-sidebar-collapsed');
});

function createClient(overrides: Partial<SupervisorClientApi> = {}): SupervisorClientApi {
  return {
    listAgents: vi.fn().mockResolvedValue({ agents: [], nextCursor: null }),
    listModels: vi.fn().mockResolvedValue({
      models: [{ provider: 'fake', id: 'fake-model', name: 'Fake model' }],
      defaultModel: { provider: 'fake', id: 'fake-model', name: 'Fake model' },
    }),
    listRuns: vi.fn().mockResolvedValue({ runs: [], nextCursor: null }),
    listProjects: vi.fn().mockResolvedValue({ projects: [project], nextCursor: null }),
    listRunEvents: vi.fn().mockResolvedValue({ events: [] }),
    streamRunEvents: vi.fn().mockImplementation(emptyStream),
    getRun: vi.fn().mockResolvedValue(run),
    createAgent: vi.fn().mockResolvedValue(agent),
    renameAgent: vi.fn().mockResolvedValue(agent),
    deleteAgent: vi.fn().mockResolvedValue(agent),
    createRun: vi.fn().mockResolvedValue({ ...run, status: 'running', completedAt: null }),
    createProject: vi.fn().mockResolvedValue(project),
    deleteProject: vi.fn().mockResolvedValue(project),
    cancelRun: vi.fn().mockResolvedValue({ ...run, status: 'cancelled' }),
    followUpRun: vi.fn().mockResolvedValue({ ...run, status: 'running', completedAt: null }),
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

  it('shows available skills and installed extension update status in settings', async () => {
    const user = userEvent.setup();
    render(<App client={createClient()} />);

    expect(await screen.findByText('Create an agent profile first')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open agent settings' }));

    await user.click(screen.getByRole('button', { name: /^Skills/ }));
    expect(screen.getByRole('heading', { name: 'Skills' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Available skills' })).toBeVisible();
    expect(screen.getByText('Web app verification')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Code review/ }));
    const skillDialog = screen.getByRole('dialog', { name: 'Code review' });
    expect(skillDialog).toBeVisible();
    expect(within(skillDialog).getByRole('button', { name: 'SKILL.md' })).toBeVisible();
    expect(within(skillDialog).getByRole('article')).toHaveTextContent(
      'Two-axis review of the diff',
    );
    await user.click(within(skillDialog).getByRole('button', { name: 'agents/openai.yaml' }));
    expect(within(skillDialog).getByText(/display_name: "Code Review"/)).toBeVisible();
    await user.click(within(skillDialog).getByRole('button', { name: 'Close' }));

    await user.click(screen.getByRole('button', { name: /^Extensions/ }));
    expect(screen.getByRole('heading', { name: 'Extensions' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Installed extensions' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Update' }));
    expect(screen.getAllByText('Up to date')).toHaveLength(3);
  });

  it('switches to dark mode and persists the preference', async () => {
    const user = userEvent.setup();
    render(<App client={createClient()} />);

    expect(await screen.findByText('Create an agent profile first')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open agent settings' }));
    await user.click(screen.getByRole('button', { name: 'Appearance' }));

    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeVisible();
    expect(screen.getByRole('radio', { name: /Dark/ })).toHaveAttribute('aria-checked', 'false');

    await user.click(screen.getByRole('radio', { name: /Dark/ }));

    expect(document.documentElement).toHaveClass('dark');
    expect(window.localStorage.getItem('pideck-theme')).toBe('dark');
    expect(screen.getByRole('radio', { name: /Dark/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('collapses the sidebar and remembers the preference', async () => {
    const user = userEvent.setup();
    render(<App client={createClient()} />);

    const collapseButton = await screen.findByRole('button', { name: 'Collapse sidebar' });
    expect(collapseButton).toHaveAttribute('aria-expanded', 'true');

    await user.click(collapseButton);

    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('pideck-sidebar-collapsed')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));

    expect(screen.getByText('Sessions')).toBeVisible();
    expect(window.localStorage.getItem('pideck-sidebar-collapsed')).toBe('false');
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
    expect(
      within(screen.getByRole('navigation', { name: 'Sessions' })).getByText('Fake model'),
    ).toBeVisible();
    const thinkingMarker = await screen.findByText('Thinking...');
    expect(thinkingMarker).toBeVisible();
    expect(thinkingMarker).toHaveClass('shimmer');
    expect(await screen.findByText('Looks good.')).toBeVisible();
    expect(screen.getByLabelText('Workspace agent conversation')).toBeInTheDocument();
  });

  it('expands tool calls to show their arguments', async () => {
    const user = userEvent.setup();
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
        type: 'tool_execution_start',
        payload: { toolName: 'bash', args: { command: 'pwd' } },
        createdAt: timestamp,
      },
    ];
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
      listRunEvents: vi.fn().mockResolvedValue({ events }),
    });
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: /2 events/ }));
    const toolCall = screen.getByRole('button', { name: 'Running bash' });
    expect(toolCall).toHaveAttribute('aria-expanded', 'false');
    await user.click(toolCall);

    expect(screen.getByLabelText('Tool call arguments')).toHaveTextContent('"command": "pwd"');
  });

  it('merges WebSocket events that arrive before persisted event replay completes', async () => {
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

    resolveReplay({ events: [persistedEvent] });
    await waitFor(() => expect(streamRunEvents).toHaveBeenCalled());

    expect(await screen.findByText('Thinking...')).toBeVisible();
    expect(screen.getByText('Streamed first.')).toBeVisible();
  });

  it('continues a completed run through the chat composer', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
    });
    render(<App client={client} />);

    const composer = await screen.findByRole('textbox', { name: 'Message agent' });
    await user.type(composer, 'Keep going.');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(client.followUpRun).toHaveBeenCalledWith(run.id, { message: 'Keep going.' }),
    );
  });

  it('accepts dropped images and other files above the composer', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
    });
    render(<App client={client} />);

    const chatArea = await screen.findByRole('region', { name: 'Chat area' });
    const image = new File(['image bytes'], 'screen.png', { type: 'image/png' });
    const document = new File(['notes'], 'notes.txt', { type: 'text/plain' });

    fireEvent.dragOver(chatArea, {
      dataTransfer: { types: ['Files'], files: [image, document], dropEffect: 'none' },
    });
    expect(screen.getByText('Drop files to attach')).toBeVisible();

    fireEvent.drop(chatArea, {
      dataTransfer: { types: ['Files'], files: [image, document], dropEffect: 'copy' },
    });

    expect(await screen.findByText('screen.png')).toBeVisible();
    expect(screen.getByText('notes.txt')).toBeVisible();
    expect(screen.getByText(/PNG/)).toBeVisible();
    expect(screen.getByText(/TXT/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Remove screen.png' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Remove screen.png' }));
    expect(screen.queryByText('screen.png')).not.toBeInTheDocument();
    expect(screen.getByText('notes.txt')).toBeVisible();
  });

  it('chooses a saved project or stages a new project from the composer', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
    });
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'Choose project' }));
    const picker = screen.getByRole('dialog', { name: 'Choose project' });
    expect(within(picker).getByRole('option', { name: /workspace/ })).toBeVisible();
    await user.click(within(picker).getByRole('button', { name: 'New project' }));
    await user.type(within(picker).getByLabelText('Working directory'), '/tmp/new-project');
    await user.click(within(picker).getByRole('button', { name: 'Use project' }));

    expect(screen.getByRole('button', { name: 'Choose project' })).toHaveTextContent('new-project');
    await user.type(
      screen.getByRole('textbox', { name: 'Session task' }),
      'Inspect the new project.',
    );
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    await waitFor(() =>
      expect(client.createProject).toHaveBeenCalledWith({ path: '/tmp/new-project' }),
    );
  });

  it('deletes a saved project without touching files on disk', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
    });
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'Choose project' }));
    const picker = screen.getByRole('dialog', { name: 'Choose project' });
    await user.click(within(picker).getByRole('button', { name: 'Delete project workspace' }));

    const confirmation = screen.getByRole('dialog', { name: 'Delete saved project?' });
    expect(confirmation).toHaveTextContent('Files on disk will not be changed.');
    await user.click(within(confirmation).getByRole('button', { name: 'Delete project' }));

    await waitFor(() => expect(client.deleteProject).toHaveBeenCalledWith(project.id));
    expect(
      screen.queryByRole('button', { name: 'Delete project workspace' }),
    ).not.toBeInTheDocument();
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
