import type {
  ManagedAgentEvent,
  ManagedAgentExtensionsResponse,
  ManagedAgentResponse,
  ManagedAgentRunResponse,
  ManagedProjectResponse,
} from '@nextflow/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  document.documentElement.classList.remove('dark');
  document.documentElement.style.colorScheme = '';
  window.localStorage.removeItem('pideck-theme');
  window.localStorage.removeItem('pideck-layout');
  window.localStorage.removeItem('pideck-sidebar-collapsed');
  window.localStorage.removeItem('pideck-archived-runs');
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
    createWorktree: vi.fn(),
    listWorktrees: vi.fn().mockResolvedValue({ worktrees: [] }),
    releaseWorktree: vi.fn(),
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

  it('loads additional history without duplicating active runs', async () => {
    const olderRun = {
      ...run,
      id: '018bcfe4-7a4b-7000-8000-000000000223',
      prompt: 'Older history.',
      createdAt: '2026-08-22T20:00:00.000Z',
    };
    const listRuns = vi
      .fn()
      .mockResolvedValueOnce({ runs: [run], nextCursor: 'next-page' })
      .mockResolvedValueOnce({ runs: [olderRun, run], nextCursor: null });
    const client = createClient({ listRuns });
    render(<App client={client} />);

    const loadMore = await screen.findByRole('button', { name: 'Load more history' });
    await userEvent.click(loadMore);
    expect(await screen.findByText('Older history.')).toBeVisible();
    expect(
      within(screen.getByRole('navigation', { name: 'Sessions' })).getAllByText(
        'Review the changes.',
      ),
    ).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load more history' })).not.toBeInTheDocument();
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

  it('shows searchable skills and extension update status in settings', async () => {
    const user = userEvent.setup();
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

  it('completes Pi slash commands in the new-session composer', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
    });
    render(<App client={client} />);

    const composer = await screen.findByRole('textbox', { name: 'Session task' });
    await user.type(composer, '/mod');

    const command = await screen.findByRole('option', { name: /\/model/ });
    expect(command).toHaveTextContent('Select model');
    await user.click(command);

    expect(composer).toHaveValue('/model ');
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

  it('switches to the tab workspace layout and persists the preference', async () => {
    const user = userEvent.setup();
    const secondRun = {
      ...run,
      id: '018bcfe4-7a4b-7000-8000-000000000777',
      prompt: 'Fix the failing tests.',
    };
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run, secondRun], nextCursor: null }),
    });
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    await user.click(screen.getByRole('radio', { name: /Tabs/ }));
    await user.keyboard('{Escape}');

    expect(window.localStorage.getItem('pideck-layout')).toBe('tabs');
    const firstTab = screen.getByRole('tab', { name: /Review the changes\./ });
    expect(firstTab).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).not.toBeInTheDocument();

    firstTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(window.location.pathname).toBe(`/sessions/${secondRun.id}`);
  });

  it('collapses the sidebar and remembers the preference', async () => {
    const user = userEvent.setup();
    render(<App client={createClient()} />);

    const collapseButton = await screen.findByRole('button', { name: 'Collapse sidebar' });
    const newSessionButton = screen.getByRole('button', { name: 'New session' });
    expect(collapseButton).toHaveAttribute('aria-expanded', 'true');
    expect(newSessionButton).toHaveAttribute('data-size', 'icon');
    expect(newSessionButton).toHaveAttribute('title', 'New session');
    expect(newSessionButton.querySelector('svg')).not.toBeNull();

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

  it('updates the URL when selecting a session', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/new');
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
    });

    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: /Review the changes\./ }));
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
    expect(
      within(screen.getByRole('navigation', { name: 'Sessions' })).getByRole('button', {
        name: /Review the changes\./,
      }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('archives a session from its context menu', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
    });

    render(<App client={client} />);

    const sessionButton = await screen.findByRole('button', {
      name: /Review the changes\./,
    });
    fireEvent.contextMenu(sessionButton);

    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));

    expect(screen.queryByRole('button', { name: /Review the changes\./ })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/new');
    expect(window.localStorage.getItem('pideck-archived-runs')).toContain(run.id);
  });

  it('archives a session from the hover action', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
    });

    render(<App client={client} />);

    const sessionButton = await screen.findByRole('button', {
      name: /Review the changes\./,
    });
    await user.hover(sessionButton);
    await user.click(screen.getByRole('button', { name: 'Archive session' }));

    expect(screen.queryByRole('button', { name: /Review the changes\./ })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/new');
    expect(window.localStorage.getItem('pideck-archived-runs')).toContain(run.id);
  });

  it('renders the prompt, model avatar, and lifecycle markers', async () => {
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
    render(<App client={client} />);

    expect(await screen.findByRole('heading', { name: 'Review the changes.' })).toBeVisible();
    const sessionButton = within(screen.getByRole('navigation', { name: 'Sessions' })).getByRole(
      'button',
      { name: /Review the changes\./ },
    );
    expect(sessionButton).toHaveAttribute(
      'title',
      'Review the changes. · workspace · working tree · Fake model · Medium thinking · Completed',
    );
    expect(sessionButton).toHaveTextContent('workspace');
    expect(sessionButton).not.toHaveTextContent('/workspace');
    expect(sessionButton).toHaveTextContent('working tree');
    expect(sessionButton.querySelector('[data-slot="avatar"]')).not.toBeNull();
    await user.hover(sessionButton);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Fake model');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Medium thinking');
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
      listRunEventPages: eventPages(events),
    });
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
    render(<App client={client} />);

    expect(await screen.findByRole('group', { name: 'Prompt attachments' })).toBeVisible();
    expect(screen.getByAltText('screen.png')).toBeVisible();
    expect(client.listRunAttachments).toHaveBeenCalledWith(run.id);
  });

  it('starts a new task from a focused coding prompt', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [], nextCursor: null }),
    });
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'Review current changes' }));

    expect(screen.getByRole('textbox', { name: 'Session task' })).toHaveValue(
      'Review the current changes for correctness, regressions, and missing tests. Report findings before editing.',
    );
  });

  it('accepts dropped images in the initial composer and sends them with the run', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [], nextCursor: null }),
    });
    render(<App client={client} />);

    const composer = await screen.findByRole('form', { name: 'New session composer' });
    const image = new File(['image bytes'], 'screen.png', { type: 'image/png' });

    fireEvent.dragOver(composer, {
      dataTransfer: { types: ['Files'], files: [image], dropEffect: 'none' },
    });
    expect(screen.getByText('Drop files to attach')).toBeVisible();

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

    render(<App connectionManager={manager} />);

    expect(await screen.findByRole('button', { name: /Review the changes\./ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Inspect the remote workspace\./ })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'New session' }));
    const serverSelect = screen.getByRole('combobox', { name: 'Server' });
    fireEvent.keyDown(serverSelect, { key: 'Enter' });
    await user.click(await screen.findByRole('option', { name: 'Build host' }));
    expect(serverSelect).toHaveTextContent('Build host');
    expect(screen.getByRole('combobox', { name: 'Agent profile' })).toHaveTextContent(
      'Remote agent',
    );
  });

  it('opens API-backed changes and terminal inspectors for a session', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
    });
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'Open changes' }));
    expect(await screen.findByRole('dialog', { name: 'Workspace changes' })).toBeVisible();
    expect(await screen.findByText('No changes in this scope.')).toBeVisible();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(await screen.findByRole('dialog', { name: 'Terminal session' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Terminal command' })).toBeVisible();
  });

  it('hides workspace navigation while keeping fleet and inbox in the command palette', async () => {
    const user = userEvent.setup();
    const client = createClient({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], nextCursor: null }),
      listRuns: vi.fn().mockResolvedValue({ runs: [run], nextCursor: null }),
      getFleet: vi.fn().mockResolvedValue({
        health: {
          status: 'healthy',
          database: 'connected',
          runtime: 'ready',
          checkedAt: timestamp,
        },
        runs: [
          {
            ...run,
            parentRunId: null,
            executionMode: 'local',
            worktreeId: null,
            agentName: agent.name,
            children: [],
          },
        ],
        counts: { active: 0, attention: 0, total: 1 },
        complete: true,
      }),
    });
    render(<App client={client} />);

    expect(screen.queryByRole('button', { name: 'Fleet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Inbox' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Worktrees' })).not.toBeInTheDocument();

    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await user.click(screen.getByRole('option', { name: 'Fleet' }));
    expect(await screen.findByRole('heading', { name: 'Fleet overview' })).toBeVisible();
    expect(window.location.pathname).toBe('/fleet');

    await user.keyboard('{Control>}k{/Control}');
    await user.click(screen.getByRole('option', { name: 'Inbox' }));
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeVisible();
    expect(window.location.pathname).toBe('/inbox');
  });

  it('shows actionable supervisor failures', async () => {
    const client = createClient({
      listAgents: vi.fn().mockRejectedValue(new Error('Supervisor is offline')),
    });
    render(<App client={client} />);

    expect(await screen.findByText('Supervisor request failed')).toBeVisible();
    expect(screen.getByText(/Supervisor is offline/)).toBeVisible();
  });
});
