import type {
  ManagedAgentEvent,
  ManagedAgentExtensionsResponse,
  ManagedAgentResponse,
  ManagedAgentRunResponse,
  ManagedProjectResponse,
} from '@nextflow/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App, { type SupervisorClientApi } from './App';
import type {
  ServerConnectionManager,
  ServerDefinition,
  ServerInput,
} from './lib/server-connections';
import type { SupervisorClient } from './lib/supervisor-client';

const timestamp = '2026-08-23T20:00:00.000Z';
const agent: ManagedAgentResponse = {
  id: '018bcfe4-7a4b-7000-8000-000000000111',
  name: 'Workspace agent',
  systemPrompt: 'Be careful.',
  systemPromptMode: 'append',
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
  executionMode: 'local',
  worktreeId: null,
  parentRunId: null,
  status: 'completed',
  error: null,
  createdAt: timestamp,
  startedAt: timestamp,
  completedAt: timestamp,
};

function emptyStream(): AsyncGenerator<ManagedAgentEvent> {
  return (async function* () {})();
}

function eventPages(events: ManagedAgentEvent[]) {
  return vi.fn().mockImplementation(async function* () {
    yield { events };
  });
}

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  document.documentElement.style.colorScheme = '';
  window.localStorage.removeItem('pideck-theme');
  window.localStorage.removeItem('pideck-layout');
  window.localStorage.removeItem('pideck-sidebar-collapsed');
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});

function createClient(overrides: Partial<SupervisorClientApi> = {}): SupervisorClientApi {
  return {
    listAgents: vi.fn().mockResolvedValue({ agents: [], nextCursor: null }),
    listModels: vi.fn().mockResolvedValue({
      models: [{ provider: 'fake', id: 'fake-model', name: 'Fake model' }],
      defaultModel: { provider: 'fake', id: 'fake-model', name: 'Fake model' },
    }),
    listComposerSuggestions: vi.fn().mockResolvedValue({ suggestions: [] }),
    listExtensions: vi.fn().mockResolvedValue({
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
        {
          id: 'npm:pi-stale:/pi-stale/index.ts',
          name: 'pi-stale',
          description: 'Needs an update.',
          path: '/pi-stale/index.ts',
          relativePath: 'index.ts',
          source: 'npm:pi-stale',
          packageName: 'pi-stale',
          scope: 'user',
          origin: 'package',
          enabled: true,
          version: '1.0.0',
          status: 'update_available',
        },
        {
          id: 'auto:/extensions/local.ts',
          name: 'local',
          description: 'Local Pi extension',
          path: '/extensions/local.ts',
          relativePath: 'local.ts',
          source: 'auto',
          packageName: null,
          scope: 'user',
          origin: 'top-level',
          enabled: true,
          version: null,
          status: 'local',
        },
      ],
      cwd: '/workspace',
      checkedAt: timestamp,
      updateCheckError: null,
    } satisfies ManagedAgentExtensionsResponse),
    updateExtensions: vi.fn().mockResolvedValue({
      extensions: [],
      cwd: '/workspace',
      checkedAt: timestamp,
      updateCheckError: null,
    } satisfies ManagedAgentExtensionsResponse),
    listRuns: vi.fn().mockResolvedValue({ runs: [], nextCursor: null }),
    listAllRuns: vi.fn().mockResolvedValue([]),
    listProjects: vi.fn().mockResolvedValue({ projects: [project], nextCursor: null }),
    listRunAttachments: vi.fn().mockResolvedValue({ attachments: [] }),
    listRunEvents: vi.fn().mockResolvedValue({ events: [] }),
    listRunEventPages: vi.fn().mockImplementation(async function* () {
      yield { events: [] };
    }),
    streamRunEvents: vi.fn().mockImplementation(emptyStream),
    getRun: vi.fn().mockResolvedValue(run),
    createAgent: vi.fn().mockResolvedValue(agent),
    renameAgent: vi.fn().mockResolvedValue(agent),
    deleteAgent: vi.fn().mockResolvedValue(agent),
    createRun: vi.fn().mockResolvedValue({ ...run, status: 'running', completedAt: null }),
    createProject: vi.fn().mockResolvedValue(project),
    updateProject: vi.fn().mockResolvedValue(project),
    deleteProject: vi.fn().mockResolvedValue(project),
    cancelRun: vi.fn().mockResolvedValue({ ...run, status: 'cancelled' }),
    steerRun: vi.fn().mockResolvedValue({ ...run, status: 'running', completedAt: null }),
    followUpRun: vi.fn().mockResolvedValue({ ...run, status: 'running', completedAt: null }),
    getFleet: vi.fn().mockResolvedValue({
      health: {
        status: 'healthy',
        database: 'connected',
        runtime: 'ready',
        checkedAt: timestamp,
      },
      runs: [],
      counts: { active: 0, attention: 0, total: 0 },
      complete: true,
    }),
    getRunChanges: vi.fn().mockResolvedValue({
      runId: run.id,
      scope: 'working_tree',
      available: true,
      unavailableReason: null,
      baseRef: null,
      files: [],
      patch: '',
      truncated: false,
    }),
    getRunDebugLog: vi.fn().mockResolvedValue({
      runId: run.id,
      sessionId: null,
      sessionFile: null,
      available: false,
      unavailableReason: 'No journal',
      content: '',
      bytesRead: 0,
      fileSize: null,
      truncated: false,
      diagnostics: [],
      supervisorEvents: [],
    }),
    createWorktree: vi.fn(),
    listWorktrees: vi.fn().mockResolvedValue({ worktrees: [] }),
    releaseWorktree: vi.fn(),
    listSessionTerminals: vi.fn().mockResolvedValue({ terminals: [] }),
    createSessionTerminal: vi.fn().mockRejectedValue(new Error('PTY unavailable in jsdom')),
    closeSessionTerminal: vi.fn().mockResolvedValue(undefined),
    openSessionTerminalSocket: vi.fn(),
    createTerminalSession: vi.fn(),
    listTerminalSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    getTerminalSession: vi.fn(),
    writeTerminalSession: vi.fn(),
    cancelTerminalSession: vi.fn(),
    listInbox: vi.fn().mockResolvedValue({ items: [] }),
    resolveInbox: vi.fn(),
    cancelInbox: vi.fn(),
    searchSessions: vi.fn().mockResolvedValue({ results: [] }),
    ...overrides,
  };
}

describe('App', () => {
  it('keeps active runs visible when auxiliary model data is degraded', async () => {
    const activeRun = { ...run, status: 'running' as const, completedAt: null };
    const client = createClient({
      listModels: vi.fn().mockRejectedValue(new Error('models offline')),
      listRuns: vi.fn().mockResolvedValue({ runs: [], nextCursor: null }),
      listAllRuns: vi
        .fn()
        .mockImplementation(({ status }) =>
          Promise.resolve(status === 'running' ? [activeRun] : []),
        ),
    });

    render(<App client={client} />);

    expect((await screen.findAllByText('Review the changes.'))[0]).toBeVisible();
    expect(screen.getByText('Server data is degraded')).toBeVisible();
    expect(screen.getByText(/models data is stale or unavailable/i)).toBeVisible();
  });

  it('shows only running and queued work in the overview grid', async () => {
    const runningRun = { ...run, status: 'running' as const, completedAt: null };
    const completedRun = {
      ...run,
      id: '018bcfe4-7a4b-7000-8000-000000000223',
      prompt: 'Older history.',
    };
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [runningRun, completedRun], nextCursor: null }),
    });
    render(<App client={client} />);

    const grid = await screen.findByLabelText('Running agents');
    expect(within(grid).getByText('Review the changes.')).toBeVisible();
    expect(within(grid).queryByText('Older history.')).not.toBeInTheDocument();
  });
  it('restores a routed run that was not present in the initial history page', async () => {
    window.history.replaceState({}, '', `/servers/local/sessions/${run.id}`);
    const client = createClient({
      listRuns: vi.fn().mockResolvedValue({ runs: [], nextCursor: 'more' }),
      getRun: vi.fn().mockResolvedValue(run),
    });
    render(<App client={client} />);
    expect((await screen.findAllByText('Review the changes.'))[0]).toBeVisible();
    expect(client.getRun).toHaveBeenCalledWith(run.id);
  });

  it('creates the first persisted agent from the empty state', async () => {
    const user = userEvent.setup();
    const client = createClient();
    window.history.replaceState({}, '', `/new`);
    render(<App client={client} />);

    expect(await screen.findByText('Create an agent profile first')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open agent settings' }));
    await user.click(screen.getByRole('button', { name: 'New agent' }));
    await user.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() =>
      expect(client.createAgent).toHaveBeenCalledWith({
        name: 'Coding agent',
        systemPrompt: expect.stringContaining('Inspect the workspace carefully'),
        systemPromptMode: 'append',
      }),
    );
  });

  it('creates an agent with a replacement prompt and tool calls disabled', async () => {
    const user = userEvent.setup();
    const client = createClient();
    window.history.replaceState({}, '', `/new`);
    render(<App client={client} />);

    await screen.findByText('Create an agent profile first');
    await user.click(screen.getByRole('button', { name: 'Open agent settings' }));
    await user.click(screen.getByRole('button', { name: 'New agent' }));
    await user.click(screen.getByRole('radio', { name: 'This prompt only' }));
    await user.click(screen.getByRole('switch', { name: 'Allow tool calls' }));
    await user.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() =>
      expect(client.createAgent).toHaveBeenCalledWith({
        name: 'Coding agent',
        systemPrompt: expect.stringContaining('Inspect the workspace carefully'),
        systemPromptMode: 'replace',
        tools: [],
      }),
    );
  });

  it('shows searchable skills and extension update status in settings', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', `/new`);
    render(<App client={createClient()} />);

    expect(await screen.findByText('Create an agent profile first')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open agent settings' }));

    await user.click(screen.getByRole('button', { name: /^Skills/ }));
    expect(screen.getByRole('heading', { name: 'Skills' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Available skills' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Filter skills' })).toBeVisible();
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
    expect(screen.getByText('pi-tools')).toBeVisible();
    expect(screen.getByText('Up to date')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Update pi-stale' })).toBeVisible();
    expect(screen.getAllByText('Local').at(-1)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Update pi-stale' }));
    await waitFor(() => expect(screen.getByText('No extensions found')).toBeVisible());
  });

  it('manages known projects from the settings page', async () => {
    const user = userEvent.setup();
    const updatedProject = { ...project, name: 'Renamed workspace', path: '/renamed-workspace' };
    const client = createClient({
      updateProject: vi.fn().mockResolvedValue(updatedProject),
    });
    window.history.replaceState({}, '', `/new`);
    render(<App client={client} />);

    expect(await screen.findByText('Create an agent profile first')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open agent settings' }));
    await user.click(screen.getByRole('button', { name: /^Projects/ }));

    expect(screen.getByRole('heading', { name: 'Known projects' })).toBeVisible();
    expect(screen.getByText('/workspace')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Add project' }));
    const editor = screen.getByRole('dialog', { name: 'Add known project' });
    await user.type(within(editor).getByLabelText('Display name'), 'PiDeck workspace');
    await user.type(within(editor).getByLabelText('Working directory'), '/workspace');
    await user.click(within(editor).getByRole('button', { name: 'Add project' }));
    await waitFor(() =>
      expect(client.createProject).toHaveBeenCalledWith({
        name: 'PiDeck workspace',
        path: '/workspace',
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Edit project workspace' }));
    const editDialog = screen.getByRole('dialog', { name: 'Edit known project' });
    await user.clear(within(editDialog).getByLabelText('Display name'));
    await user.type(within(editDialog).getByLabelText('Display name'), 'Renamed workspace');
    await user.click(within(editDialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(client.updateProject).toHaveBeenCalledWith(project.id, {
        name: 'Renamed workspace',
        path: '/workspace',
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Delete project Renamed workspace' }));
    const confirmation = screen.getByRole('dialog', { name: 'Remove known project?' });
    await user.click(within(confirmation).getByRole('button', { name: 'Remove project' }));
    await waitFor(() => expect(client.deleteProject).toHaveBeenCalledWith(project.id));
    expect(screen.queryByText('Renamed workspace')).not.toBeInTheDocument();
  });

  it('autocompletes known project paths in the composer and settings', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
    });
    window.history.replaceState({}, '', `/new`);
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'Choose project' }));
    const picker = screen.getByRole('dialog', { name: 'Choose project' });
    await user.click(within(picker).getByRole('button', { name: 'New project' }));
    const composerPath = within(picker).getByLabelText('Working directory');
    await user.type(composerPath, '/work');
    await user.click(screen.getByRole('option', { name: /workspace\/workspace/ }));
    expect(composerPath).toHaveValue('/workspace');
    await user.click(within(picker).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: /^Projects/ }));
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    const settingsDialog = screen.getByRole('dialog', { name: 'Add known project' });
    const settingsPath = within(settingsDialog).getByLabelText('Working directory');
    await user.type(settingsPath, '/work');
    await user.click(screen.getByRole('option', { name: /workspace\/workspace/ }));
    expect(settingsPath).toHaveValue('/workspace');
  });

  it('applies composer slash command choices to new-session state immediately', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
    });
    window.history.replaceState({}, '', `/new`);
    render(<App client={client} />);

    const composer = await screen.findByRole('textbox', { name: 'Session task' });
    await user.type(composer, '/');
    for (const name of ['host', 'project', 'agent', 'model', 'think', 'checkout']) {
      expect(screen.getByRole('option', { name: new RegExp(`^/${name}\\b`) })).toBeVisible();
    }

    await user.clear(composer);
    await user.type(composer, '/think ');
    expect(await screen.findByRole('listbox', { name: 'Thinking level options' })).toBeVisible();
    await user.click(screen.getByRole('option', { name: 'High' }));

    expect(composer).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Thinking level' })).toHaveTextContent('High');
    expect(screen.getByRole('status')).toHaveTextContent('Thinking level set to High');
  });

  it('completes @ file references from the active supervisor', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listComposerSuggestions: vi.fn().mockResolvedValue({
        suggestions: [
          {
            value: '@src/App.tsx',
            label: 'App.tsx',
            description: '/workspace/src/App.tsx',
            kind: 'file',
          },
        ],
      }),
    });
    window.history.replaceState({}, '', `/new`);
    render(<App client={client} />);

    const composer = await screen.findByRole('textbox', { name: 'Session task' });
    await user.type(composer, '@App');

    const file = await screen.findByRole('option', { name: /App\.tsx/ });
    await user.click(file);

    expect(composer).toHaveValue('@src/App.tsx ');
    expect(client.listComposerSuggestions).toHaveBeenCalledWith({
      cwd: '/workspace',
      kind: 'file',
      prefix: '@App',
    });
  });

  it('switches to dark mode and persists the preference', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', `/new`);
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

  it('removes the in-app tab bar and exposes active runs as browser links', async () => {
    const secondRun = {
      ...run,
      id: '018bcfe4-7a4b-7000-8000-000000000777',
      prompt: 'Fix the failing tests.',
      status: 'running' as const,
      completedAt: null,
    };
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({
        runs: [{ ...run, status: 'running', completedAt: null }, secondRun],
        nextCursor: null,
      }),
    });
    render(<App client={client} />);

    expect(await screen.findByRole('heading', { name: 'Running agents' })).toBeVisible();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Review the changes/ })).toHaveAttribute(
      'href',
      expect.stringContaining(`/sessions/${run.id}`),
    );
    expect(screen.getByRole('link', { name: /Open Fix the failing tests/ })).toBeVisible();
  });
  it('opens the new-session composer from the overview', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
    });
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'Start a session' }));
    expect(screen.getByRole('textbox', { name: 'Session task' })).toBeVisible();
    expect(window.location.pathname).toBe('/new');
  });
  it('shows unchecked activity on running agent cards and clears it when opened', async () => {
    const user = userEvent.setup();
    const activeRun = {
      ...run,
      status: 'running' as const,
      completedAt: null,
      latestEventSequence: 8,
    };
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [activeRun], nextCursor: null }),
    });
    render(<App client={client} />);

    const grid = await screen.findByLabelText('Running agents');
    expect(within(grid).getByText('8 new events')).toBeVisible();
    await user.click(within(grid).getByRole('link', { name: /Open Review the changes/ }));
    expect(screen.getByRole('heading', { name: 'Review the changes.' })).toBeVisible();
  });
  it('updates the URL when opening a running agent', async () => {
    const user = userEvent.setup();
    const activeRun = { ...run, status: 'running' as const, completedAt: null };
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [activeRun], nextCursor: null }),
    });
    render(<App client={client} />);

    await user.click(await screen.findByRole('link', { name: /Open Review the changes/ }));
    expect(window.location.pathname).toBe(`/sessions/${run.id}`);
  });
  it('restores the session selected by the URL', async () => {
    window.history.replaceState({}, '', `/sessions/${run.id}`);
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
    });

    render(<App client={client} />);

    expect(await screen.findByRole('heading', { name: 'Review the changes.' })).toBeVisible();
    expect(window.location.pathname).toBe(`/sessions/${run.id}`);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('does not render archive controls or an archived bar', async () => {
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
    });
    render(<App client={client} />);

    await screen.findByRole('heading', { name: 'Running agents' });
    expect(screen.queryByText('Archived:')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restore/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Close Review/ })).not.toBeInTheDocument();
  });
  it('returns to the overview from the app toolbar', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', `/sessions/${run.id}`);
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
    });
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'piDeck overview' }));
    expect(screen.getByRole('heading', { name: 'Running agents' })).toBeVisible();
    expect(window.location.pathname).toBe('/');
  });
  it('renders the prompt, model avatar, and lifecycle markers', async () => {
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
      listRunEventPages: eventPages(events),
    });
    window.history.replaceState({}, '', `/sessions/${run.id}`);
    render(<App client={client} />);

    expect(await screen.findByRole('heading', { name: 'Review the changes.' })).toBeVisible();
    expect(await screen.findByText('Agent started')).toBeVisible();
    expect(await screen.findByText('Looks good.')).toBeVisible();
    expect(screen.getByLabelText('Workspace agent conversation')).toBeInTheDocument();
  });

  it('loads older transcript pages on demand', async () => {
    const user = userEvent.setup();
    const event = (sequence: number, type: string): ManagedAgentEvent => ({
      agentId: agent.id,
      runId: run.id,
      sequence,
      type,
      payload: {},
      createdAt: timestamp,
    });
    const listRunEventPage = vi
      .fn()
      .mockResolvedValueOnce({
        events: [event(2, 'agent_start'), event(3, 'agent_end')],
        previousSequence: 2,
        nextSequence: null,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        events: [event(1, 'turn_start')],
        previousSequence: null,
        nextSequence: null,
        hasMore: false,
      });
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
      listRunEventPage,
    });
    window.history.replaceState({}, '', `/sessions/${run.id}`);
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'Load older activity' }));
    expect(listRunEventPage).toHaveBeenNthCalledWith(2, run.id, {
      beforeSequence: 2,
      limit: 500,
    });
    expect(screen.queryByRole('button', { name: 'Load older activity' })).not.toBeInTheDocument();
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
      listRunEventPages: eventPages(events),
    });
    window.history.replaceState({}, '', `/sessions/${run.id}`);
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: /Running bash/ }));
    const toolCall = screen.getByRole('button', { name: 'Running bash' });
    expect(toolCall).toHaveAttribute('aria-expanded', 'false');
    await user.click(toolCall);

    expect(screen.getByLabelText('Tool call arguments')).toHaveTextContent('"command": "pwd"');
  });

  it('renders file tool arguments as shadcn badges in events', async () => {
    const events: ManagedAgentEvent[] = [
      {
        agentId: agent.id,
        runId: run.id,
        sequence: 1,
        type: 'tool_execution_start',
        payload: { toolName: 'read', args: { path: '/workspace/src/App.tsx' } },
        createdAt: timestamp,
      },
    ];
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
      listRunEventPages: eventPages(events),
    });
    window.history.replaceState({}, '', `/sessions/${run.id}`);
    render(<App client={client} />);

    const fileBadge = await screen.findByText('App.tsx');
    expect(fileBadge).toHaveAttribute('data-slot', 'badge');
    expect(fileBadge).toHaveAttribute('title', '/workspace/src/App.tsx');
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
      listRunEventPages: vi.fn().mockImplementation(async function* () {
        yield await replay;
      }),
      streamRunEvents,
    });
    window.history.replaceState({}, '', `/sessions/${run.id}`);
    render(<App client={client} />);

    resolveReplay({ events: [persistedEvent] });
    await waitFor(() => expect(streamRunEvents).toHaveBeenCalled());

    expect(await screen.findByText('Agent started')).toBeVisible();
    expect(await screen.findByText('Streamed first.')).toBeVisible();
  });

  it('continues a completed run through the chat composer', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
    });
    window.history.replaceState({}, '', `/sessions/${run.id}`);
    render(<App client={client} />);

    const composer = await screen.findByRole('textbox', { name: 'Message agent' });
    await user.type(composer, 'Keep going.');
    await user.click(screen.getByRole('button', { name: 'Send follow-up' }));

    await waitFor(() =>
      expect(client.followUpRun).toHaveBeenCalledWith(
        run.id,
        expect.objectContaining({
          message: 'Keep going.',
          idempotencyKey: expect.any(String),
        }),
      ),
    );
  });

  it('loads persisted prompt attachments when reopening a run', async () => {
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
      listRunAttachments: vi.fn().mockResolvedValue({
        attachments: [
          {
            name: 'screen.png',
            mimeType: 'image/png',
            data: 'aW1hZ2UgYnl0ZXM=',
          },
        ],
      }),
    });
    window.history.replaceState({}, '', `/sessions/${run.id}`);
    render(<App client={client} />);

    expect(await screen.findByRole('group', { name: 'Prompt attachments' })).toBeVisible();
    expect(screen.getByAltText('screen.png')).toBeVisible();
    expect(client.listRunAttachments).toHaveBeenCalledWith(run.id);
  });

  it('starts a new task without suggested prompts', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [], nextCursor: null }),
    });
    window.history.replaceState({}, '', `/new`);
    render(<App client={client} />);

    const composer = await screen.findByRole('textbox', { name: 'Session task' });
    expect(screen.queryByRole('region', { name: 'Task starters' })).not.toBeInTheDocument();
    await user.type(composer, 'Review the current changes.');

    expect(composer).toHaveValue('Review the current changes.');
  });

  it('accepts dropped images in the initial composer and sends them with the run', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [], nextCursor: null }),
    });
    window.history.replaceState({}, '', `/new`);
    render(<App client={client} />);

    const composer = await screen.findByRole('form', { name: 'New session composer' });
    const image = new File(['image bytes'], 'screen.png', { type: 'image/png' });

    fireEvent.dragOver(composer, {
      dataTransfer: { types: ['Files'], files: [image], dropEffect: 'none' },
    });
    expect(screen.getByText('Drop images to attach')).toBeVisible();

    fireEvent.drop(composer, {
      dataTransfer: { types: ['Files'], files: [image], dropEffect: 'copy' },
    });

    expect(await screen.findByText('screen.png')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Session task' }), 'Inspect this image.');
    await user.click(screen.getByRole('button', { name: 'Start session' }));

    await waitFor(() =>
      expect(client.createRun).toHaveBeenCalledWith({
        agentId: agent.id,
        prompt: 'Inspect this image.',
        model: { provider: 'fake', id: 'fake-model' },
        thinkingLevel: 'medium',
        cwd: '/workspace',
        idempotencyKey: expect.any(String),
        attachments: [
          {
            name: 'screen.png',
            mimeType: 'image/png',
            data: 'aW1hZ2UgYnl0ZXM=',
          },
        ],
      }),
    );
    expect(await screen.findByRole('group', { name: 'Prompt attachments' })).toBeVisible();
    expect(screen.getByAltText('screen.png')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Open screen.png' }));
    const preview = screen.getByRole('dialog', { name: 'screen.png' });
    expect(preview).toBeVisible();
    expect(within(preview).getByAltText('screen.png')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'screen.png' })).not.toBeInTheDocument();
  });

  it('rejects unsupported dropped files before they reach Pi', async () => {
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
    });
    window.history.replaceState({}, '', `/sessions/${run.id}`);
    render(<App client={client} />);

    const chatArea = await screen.findByRole('region', { name: 'Chat area' });
    const image = new File(['image bytes'], 'screen.png', { type: 'image/png' });
    const document = new File(['notes'], 'notes.txt', { type: 'text/plain' });

    fireEvent.dragOver(chatArea, {
      dataTransfer: { types: ['Files'], files: [image, document], dropEffect: 'none' },
    });
    expect(screen.getByText('Drop images to attach')).toBeVisible();

    fireEvent.drop(chatArea, {
      dataTransfer: { types: ['Files'], files: [image, document], dropEffect: 'copy' },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Pi accepts PNG, JPEG, GIF, and WebP images only.',
    );
    expect(screen.queryByText('screen.png')).not.toBeInTheDocument();
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();

    fireEvent.drop(chatArea, {
      dataTransfer: { types: ['Files'], files: [image], dropEffect: 'copy' },
    });
    expect(await screen.findByText('screen.png')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Remove screen.png' })).toBeVisible();
  });

  it('chooses a saved project or stages a new project from the composer', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
    });
    window.history.replaceState({}, '', `/new`);
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
    window.history.replaceState({}, '', `/new`);
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
    window.history.replaceState({}, '', `/new`);
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
        idempotencyKey: expect.any(String),
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(client.cancelRun).toHaveBeenCalledWith(run.id, expect.any(String)));
    expect(await screen.findByText('Cancelled')).toBeVisible();
  });

  it('aggregates sessions from multiple servers and lets the composer choose one', async () => {
    const user = userEvent.setup();
    const remoteAgent = {
      ...agent,
      id: '018bcfe4-7a4b-7000-8000-000000000444',
      name: 'Remote agent',
      cwd: '/remote-workspace',
    };
    const remoteRun = {
      ...run,
      id: '018bcfe4-7a4b-7000-8000-000000000555',
      agentId: remoteAgent.id,
      prompt: 'Inspect the remote workspace.',
      cwd: '/remote-workspace',
    };
    const localClient = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
    });
    const remoteClient = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [remoteAgent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [remoteRun], nextCursor: null }),
      listProjects: vi.fn().mockResolvedValue({ projects: [], nextCursor: null }),
    });
    const configuredServers: ServerDefinition[] = [
      { id: 'local', name: 'Laptop', address: 'http://127.0.0.1:4101', hasToken: true },
      { id: 'remote', name: 'Build host', address: 'https://agents.example.com', hasToken: true },
    ];
    const clients = new Map<string, SupervisorClientApi>([
      ['local', localClient],
      ['remote', remoteClient],
    ]);
    const manager: ServerConnectionManager = {
      list: vi.fn().mockResolvedValue(configuredServers),
      save: vi.fn(async (input: ServerInput) => ({
        id: input.id ?? 'new-server',
        name: input.name,
        address: input.address,
        hasToken: Boolean(input.token),
      })),
      remove: vi.fn().mockResolvedValue(undefined),
      client: vi.fn(
        (server: ServerDefinition) => clients.get(server.id) as unknown as SupervisorClient,
      ),
    };

    window.history.replaceState({}, '', `/new`);
    render(<App connectionManager={manager} />);

    expect(await screen.findByRole('textbox', { name: 'Session task' })).toBeVisible();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();

    const serverSelect = screen.getByRole('combobox', { name: 'Remote host' });
    fireEvent.keyDown(serverSelect, { key: 'Enter' });
    await user.click(await screen.findByRole('option', { name: 'Build host' }));
    expect(screen.getByRole('combobox', { name: 'Remote host' })).toHaveTextContent('Build host');
    expect(screen.getByRole('combobox', { name: 'Agent profile' })).toHaveTextContent(
      'Remote agent',
    );
  });

  it('opens resizable changes and terminal splits without closing terminal processes', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
      getRunChanges: vi.fn().mockResolvedValue({
        runId: run.id,
        scope: 'working_tree',
        available: true,
        unavailableReason: null,
        baseRef: null,
        files: [
          {
            path: 'src/example.ts',
            status: 'M',
            additions: null,
            deletions: null,
          },
        ],
        patch:
          'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n',
        truncated: false,
      }),
    });
    window.history.replaceState({}, '', `/sessions/${run.id}`);
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'Open changes' }));
    expect(await screen.findByRole('region', { name: 'Workspace changes' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Workspace changes' })).not.toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize workspace and changes' })).toBeVisible();
    expect(await screen.findByLabelText('Changed file tree')).toBeVisible();
    await waitFor(() => {
      expect(document.querySelector('file-tree-container')).not.toBeNull();
      expect(document.querySelector('diffs-container')).not.toBeNull();
    });

    await user.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(await screen.findByRole('region', { name: 'Session terminals' })).toBeVisible();
    expect(screen.getByRole('separator', { name: 'Resize chat and terminal' })).toBeVisible();
    expect(await screen.findByText('PTY unavailable in jsdom')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Close terminal panel' }));
    expect(screen.queryByRole('region', { name: 'Session terminals' })).not.toBeInTheDocument();
    expect(client.closeSessionTerminal).not.toHaveBeenCalled();
  });

  it('asks extension approval questions globally while a new run is still being admitted', async () => {
    window.history.replaceState({}, '', '/new');
    const user = userEvent.setup();
    const request = {
      id: '018bcfe4-7a4b-7000-8000-000000000778',
      kind: 'approval' as const,
      runId: run.id,
      title: 'Expensive model consent',
      body: 'Send this prompt to openai-codex/GPT-5.6 Sol?',
      options: ['Confirm', 'Cancel'],
      status: 'pending' as const,
      response: null,
      createdAt: timestamp,
      resolvedAt: null,
    };
    const resolveInbox = vi.fn().mockResolvedValue({
      ...request,
      status: 'resolved',
      response: 'Confirm',
      resolvedAt: timestamp,
    });
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
      listInbox: vi.fn().mockResolvedValue({ items: [request] }),
      resolveInbox,
    });
    render(<App client={client} />);

    const dialog = await screen.findByRole('dialog', { name: 'Expensive model consent' });
    expect(within(dialog).getByText(/GPT-5\.6 Sol/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(resolveInbox).toHaveBeenCalledWith(request.id, 'Confirm'));
    window.history.replaceState({}, '', '/');
  });

  it('shows the raw PI journal and supervisor lifecycle in the debug drawer', async () => {
    const user = userEvent.setup();
    const getRunDebugLog = vi.fn().mockResolvedValue({
      runId: run.id,
      sessionId: '018bcfe4-7a4b-7000-8000-000000000777',
      sessionFile: '/tmp/pi-session.jsonl',
      available: true,
      unavailableReason: null,
      content: '{"type":"message","message":{"role":"user","content":"hello"}}\n',
      bytesRead: 64,
      fileSize: 64,
      truncated: false,
      diagnostics: [],
      supervisorEvents: [
        {
          agentId: agent.id,
          runId: run.id,
          sequence: 4,
          type: 'supervisor.prompt_accepted',
          payload: {},
          createdAt: timestamp,
        },
      ],
    });
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
      getRunDebugLog,
    });
    window.history.replaceState({}, '', `/sessions/${run.id}`);
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'Open debug log' }));
    expect(await screen.findByRole('region', { name: 'Run debug log' })).toBeVisible();
    expect(screen.getByRole('separator', { name: 'Resize workspace and debug log' })).toBeVisible();
    expect(await screen.findByText(/"role":"user"/)).toBeVisible();
    await user.click(screen.getByRole('tab', { name: /Lifecycle/ }));
    expect(screen.getByText(/supervisor\.prompt_accepted/)).toBeVisible();
    expect(getRunDebugLog).toHaveBeenCalledWith(run.id);
  });

  it('keeps command-k focused exclusively on switching sessions', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
      searchSessions: vi.fn().mockResolvedValue({
        results: [
          {
            runId: run.id,
            agentId: agent.id,
            title: run.prompt,
            cwd: run.cwd,
            status: run.status,
            createdAt: run.createdAt,
          },
        ],
      }),
    });
    render(<App client={client} />);

    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Switch session' });
    await user.type(within(palette).getByPlaceholderText('Switch to a session…'), 'Review');
    expect(
      await within(palette).findByRole('option', { name: /Review the changes/ }),
    ).toBeVisible();
    expect(within(palette).queryByText(/Fleet|Inbox|Worktrees|Settings/)).not.toBeInTheDocument();
  });

  it('surfaces agent requests inline and resolves them without a separate inbox', async () => {
    const user = userEvent.setup();
    const pendingRequest = {
      id: '018bcfe4-7a4b-7000-8000-000000000999',
      kind: 'approval' as const,
      runId: run.id,
      title: 'Allow command?',
      body: 'pnpm test',
      options: ['Approve', 'Reject'],
      status: 'pending' as const,
      response: null,
      createdAt: timestamp,
      resolvedAt: null,
    };
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({
        runs: [{ ...run, latestEventSequence: 12 }],
        nextCursor: null,
      }),
      listInbox: vi.fn().mockResolvedValue({ items: [pendingRequest] }),
      resolveInbox: vi.fn().mockResolvedValue({
        ...pendingRequest,
        status: 'resolved',
        response: 'Approve',
        resolvedAt: timestamp,
      }),
    });
    render(<App client={client} />);

    expect(await screen.findByText('Allow command?')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(client.resolveInbox).toHaveBeenCalledWith(pendingRequest.id, 'Approve'),
    );
    expect(screen.queryByText('Allow command?')).not.toBeInTheDocument();
  });

  it('shows actionable supervisor failures', async () => {
    const client = createClient({
      listAgents: vi.fn().mockRejectedValue(new Error('Supervisor is offline')),
    });
    render(<App client={client} />);

    expect(await screen.findByText('Request not completed')).toBeVisible();
    expect(screen.getByText(/Supervisor is offline/)).toBeVisible();
  });
});
