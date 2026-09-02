import { mkdirSync } from 'node:fs';

import { expect, type Page, test } from '@playwright/test';

const timestamp = '2026-08-23T20:00:00.000Z';
const agent = {
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
const project = {
  id: '018bcfe4-7a4b-7000-8000-000000000333',
  name: 'workspace',
  path: '/workspace',
  createdAt: timestamp,
  updatedAt: timestamp,
  lastUsedAt: timestamp,
};
const run = {
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

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/ws-tickets**', (route) =>
    route.fulfill({
      json: { ticket: 'test-ticket', expiresAt: new Date(Date.now() + 30_000).toISOString() },
    }),
  );
  await page.route(`**/v1/runs/${run.id}`, (route) => route.fulfill({ json: run }));
  await page.route(`**/v1/runs/${run.id}/attachments`, (route) =>
    route.fulfill({ json: { attachments: [] } }),
  );
  await page.route('**/v1/projects?**', (route) =>
    route.fulfill({ json: { projects: [project], nextCursor: null } }),
  );
  await page.route('**/v1/projects', (route) => route.fulfill({ status: 201, json: project }));
  await page.route('**/v1/inbox', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/v1/worktrees', (route) => route.fulfill({ json: { worktrees: [] } }));
  await page.route('**/v1/projects/*', async (route) => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ status: 200, json: project });
      return;
    }
    await route.continue();
  });
});

function watchBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) =>
    errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`),
  );
  return errors;
}

test('renders persisted and streamed PI events with chat primitives', async ({
  page,
}, testInfo) => {
  const errors = watchBrowserErrors(page);
  const activeRun = { ...run, status: 'running', completedAt: null };
  await page.route('**/v1/agents?**', (route) =>
    route.fulfill({ json: { agents: [agent], nextCursor: null } }),
  );
  await page.route('**/v1/runs?**', (route) =>
    route.fulfill({ json: { runs: [activeRun], nextCursor: null } }),
  );
  await page.route('**/v1/models', (route) =>
    route.fulfill({
      json: {
        models: [{ provider: 'fake', id: 'fake-model', name: 'Fake model' }],
        defaultModel: { provider: 'fake', id: 'fake-model', name: 'Fake model' },
      },
    }),
  );
  await page.route(`**/v1/runs/${run.id}/attachments`, (route) =>
    route.fulfill({
      json: {
        attachments: [
          {
            name: 'screen.png',
            mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          },
        ],
      },
    }),
  );
  await page.route(`**/v1/runs/${run.id}/events?**`, (route) =>
    route.fulfill({
      json: {
        events: [
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
            type: 'message_start',
            payload: {},
            createdAt: timestamp,
          },
          {
            agentId: agent.id,
            runId: run.id,
            sequence: 3,
            type: 'message_end',
            payload: {},
            createdAt: timestamp,
          },
          {
            agentId: agent.id,
            runId: run.id,
            sequence: 4,
            type: 'turn_start',
            payload: {},
            createdAt: timestamp,
          },
          {
            agentId: agent.id,
            runId: run.id,
            sequence: 5,
            type: 'tool_execution_start',
            payload: { toolName: 'bash', args: { command: 'pwd' } },
            createdAt: timestamp,
          },
        ],
      },
    }),
  );
  await page.routeWebSocket(`**/v1/runs/${run.id}/stream?**`, (socket) => {
    socket.send(
      JSON.stringify({
        agentId: agent.id,
        runId: run.id,
        sequence: 6,
        type: 'tool_execution_end',
        payload: { toolName: 'bash', isError: false },
        createdAt: timestamp,
      }),
    );
    socket.send(
      JSON.stringify({
        agentId: agent.id,
        runId: run.id,
        sequence: 7,
        type: 'message_update',
        payload: {
          assistantMessageEvent: {
            type: 'text_delta',
            delta:
              'Everything checks out. [Docs](https://example.com/docs) [Unsafe](//evil.example/path) <script>globalThis.markdownXss = true</script>\n\n```ts\nconst answer: number = 42;\n```',
          },
        },
        createdAt: timestamp,
      }),
    );
  });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('link', { name: 'Open Review the changes.' }).click();
  await expect(
    page.getByRole('heading', { name: 'Review the changes.', exact: true }),
  ).toBeVisible();
  const activity = page.getByRole('button', { name: /5 events/ });
  await expect(activity).toBeVisible();
  await activity.click();
  await expect(page.getByText('Agent started', { exact: true })).toBeVisible();
  await expect(page.getByText('Response started', { exact: true })).toBeVisible();
  await expect(page.getByText('Response finished', { exact: true })).toBeVisible();
  await expect(page.getByText('Turn started', { exact: true })).toBeVisible();
  const toolCall = page.getByRole('button', { name: 'Ran bash', exact: true });
  await expect(toolCall).toBeVisible();
  await toolCall.click();
  await expect(page.getByLabel('Tool call arguments')).toContainText('"command": "pwd"');
  await expect(
    page.locator('[data-slot="marker-content"]').filter({ hasText: 'bash finished' }),
  ).toHaveCount(0);
  await expect(page.getByText(/Everything checks out\./)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Docs' })).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('link', { name: 'Docs' })).toHaveAttribute('rel', 'noreferrer');
  await expect(page.getByRole('link', { name: 'Unsafe' })).toHaveCount(0);
  await expect(page.locator('[aria-label="Workspace agent conversation"] script')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as { markdownXss?: boolean }).markdownXss)).toBe(
    undefined,
  );
  await expect(page.locator('[data-slot="code-highlight"] .shiki')).toContainText(
    'const answer: number = 42;',
  );
  await expect(page.getByRole('button', { name: 'Copy code' })).toBeVisible();
  await expect(page.getByLabel('Workspace agent conversation')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Prompt attachments' })).toBeVisible();
  await page.getByRole('button', { name: 'Open screen.png' }).click();
  const attachmentPreview = page.getByRole('dialog', { name: 'screen.png' });
  await expect(attachmentPreview).toBeVisible();
  await expect(attachmentPreview.getByRole('img', { name: 'screen.png' })).toBeVisible();
  await page.screenshot({
    path: `.impeccable/review/attachment-preview-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'screen.png' })).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-scroll-locked');
  const bubbleBox = await page.locator('[data-slot="bubble-content"]').first().boundingBox();
  expect(bubbleBox).not.toBeNull();
  expect(bubbleBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((bubbleBox?.x ?? 0) + (bubbleBox?.width ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0,
  );
  expect(errors).toEqual([]);

  mkdirSync('.impeccable/review', { recursive: true });
  const viewport = testInfo.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  await page.screenshot({
    path: `.impeccable/review/conversation-${viewport}.png`,
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.classList.add('dark');
    localStorage.setItem('pideck-theme', 'dark');
  });
  await expect
    .poll(() =>
      page
        .locator('form[aria-label="Chat with agent"] .bg-card')
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toMatch(/oklch\(0\.205|rgb\((?:[0-6]?\d),/);
  await page.screenshot({
    path: `.impeccable/review/conversation-dark-${viewport}.png`,
    fullPage: true,
  });
});

test('shows running agents in the overview and opens each run as a tab', async ({
  page,
}, testInfo) => {
  const errors = watchBrowserErrors(page);
  const activeRun = { ...run, status: 'running', completedAt: null };
  await page.route('**/v1/agents?**', (route) =>
    route.fulfill({ json: { agents: [agent], nextCursor: null } }),
  );
  await page.route('**/v1/runs?**', (route) =>
    route.fulfill({ json: { runs: [activeRun], nextCursor: null } }),
  );
  await page.route('**/v1/models', (route) =>
    route.fulfill({
      json: {
        models: [{ provider: 'fake', id: 'fake-model', name: 'Fake model' }],
        defaultModel: { provider: 'fake', id: 'fake-model', name: 'Fake model' },
      },
    }),
  );
  await page.route(`**/v1/runs/${run.id}/events?**`, (route) =>
    route.fulfill({ json: { events: [] } }),
  );
  await page.routeWebSocket(`**/v1/runs/${run.id}/stream?**`, () => undefined);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Running agents' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Running agents' })).toContainText(
    'Review the changes.',
  );
  await expect(page.getByRole('tablist')).toHaveCount(0);
  const runLink = page.getByRole('link', { name: 'Open Review the changes.' });
  await expect(runLink).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

  mkdirSync('.impeccable/review', { recursive: true });
  const viewport = testInfo.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  await page.screenshot({
    path: `.impeccable/review/overview-${viewport}.png`,
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({
    path: `.impeccable/review/overview-dark-${viewport}.png`,
    fullPage: true,
  });

  await runLink.click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${run.id}$`));
  await expect(page.getByRole('tablist')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('accepts dropped images in the chat composer', async ({ page }, testInfo) => {
  const errors = watchBrowserErrors(page);
  const activeRun = { ...run, status: 'running', completedAt: null };
  await page.route('**/v1/agents?**', (route) =>
    route.fulfill({ json: { agents: [agent], nextCursor: null } }),
  );
  await page.route('**/v1/runs?**', (route) =>
    route.fulfill({ json: { runs: [activeRun], nextCursor: null } }),
  );
  await page.route('**/v1/models', (route) =>
    route.fulfill({
      json: {
        models: [{ provider: 'fake', id: 'fake-model', name: 'Fake model' }],
        defaultModel: { provider: 'fake', id: 'fake-model', name: 'Fake model' },
      },
    }),
  );
  await page.route(`**/v1/runs/${run.id}/events?**`, (route) =>
    route.fulfill({ json: { events: [] } }),
  );
  await page.routeWebSocket(`**/v1/runs/${run.id}/stream?**`, () => undefined);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('link', { name: 'Open Review the changes.' }).click();
  await expect(page.getByRole('textbox', { name: 'Message agent' })).toBeVisible();

  await page.evaluate(() => {
    const chatArea = document.querySelector<HTMLElement>('[aria-label="Chat area"]');
    if (!chatArea) throw new Error('Chat area not found');
    const transfer = new DataTransfer();
    const imageBytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      ),
      (character) => character.charCodeAt(0),
    );
    transfer.items.add(new File([imageBytes], 'screen.png', { type: 'image/png' }));
    chatArea.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });

  await expect(page.getByRole('img', { name: 'screen.png' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove screen.png' })).toBeVisible();
  expect(errors).toEqual([]);

  mkdirSync('.impeccable/review', { recursive: true });
  const viewport = testInfo.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  await page.screenshot({
    path: `.impeccable/review/conversation-attachments-${viewport}.png`,
    fullPage: true,
  });
});

test('navigates skills and reports extension availability honestly', async ({ page }, testInfo) => {
  const errors = watchBrowserErrors(page);
  await page.route('**/v1/agents?**', (route) =>
    route.fulfill({ json: { agents: [], nextCursor: null } }),
  );
  await page.route('**/v1/runs?**', (route) =>
    route.fulfill({ json: { runs: [], nextCursor: null } }),
  );
  await page.route('**/v1/models', (route) =>
    route.fulfill({
      json: {
        models: [{ provider: 'fake', id: 'fake-model', name: 'Fake model' }],
        defaultModel: { provider: 'fake', id: 'fake-model', name: 'Fake model' },
      },
    }),
  );
  await page.route('**/v1/extensions', (route) =>
    route.fulfill({
      json: {
        extensions: [],
        cwd: '/workspace',
        checkedAt: '2026-08-23T20:00:00.000Z',
        updateCheckError: null,
      },
    }),
  );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/new');
  await page.getByRole('button', { name: 'Open agent settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();

  await settings.getByRole('button', { name: 'Appearance' }).click();
  await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await settings.getByRole('radio', { name: /Dark/ }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await page.evaluate(() => localStorage.getItem('pideck-theme'))).toBe('dark');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const element = [
          ...document.querySelectorAll<HTMLElement>('[data-variant="secondary"]'),
        ].at(-1);
        return element ? getComputedStyle(element).backgroundColor : '';
      }),
    )
    .toMatch(/okl(ch|ab)|rgb|hsl/);
  await page.mouse.move(5, 5);
  mkdirSync('.impeccable/review', { recursive: true });
  await page.screenshot({
    path: '.impeccable/review/settings-appearance-dark.png',
    fullPage: true,
  });
  await settings.getByRole('radio', { name: /Light/ }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);

  await settings.getByRole('button', { name: /^Skills/ }).click();
  await expect(settings.getByRole('heading', { name: 'Skills' })).toBeVisible();
  await expect(settings.getByRole('list', { name: 'Available skills' })).toBeVisible();
  const skillFilter = settings.getByRole('textbox', { name: 'Filter skills' });
  await skillFilter.fill('verification');
  await expect(settings.getByRole('button', { name: /Web app verification/ })).toBeVisible();
  await skillFilter.fill('');
  await settings.getByRole('button', { name: /Code review/ }).click();
  const skillViewer = page.getByRole('dialog', { name: 'Code review' });
  await expect(skillViewer).toBeVisible();
  await expect(skillViewer.getByRole('button', { name: 'SKILL.md' })).toBeVisible();
  await expect(skillViewer.getByText('Two-axis review of the diff')).toBeVisible();
  await skillViewer.getByRole('button', { name: 'agents/openai.yaml' }).click();
  await expect(skillViewer.getByText(/display_name: "Code Review"/)).toBeVisible();
  mkdirSync('.impeccable/review', { recursive: true });
  const viewport = testInfo.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  await page.screenshot({
    path: `.impeccable/review/settings-skills-${viewport}.png`,
    fullPage: true,
  });
  await skillViewer.getByRole('button', { name: 'Close' }).click();

  await settings.getByRole('button', { name: /^Extensions/ }).click();
  await expect(settings.getByRole('heading', { name: 'Extensions' })).toBeVisible();
  await expect(settings.getByText('No extensions found')).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Update' })).toHaveCount(0);
  expect(errors).toEqual([]);
  mkdirSync('.impeccable/review', { recursive: true });
  await page.screenshot({
    path: `.impeccable/review/settings-extensions-${viewport}.png`,
    fullPage: true,
  });
});

test('chooses a saved project or prepares a new workspace', async ({ page }, testInfo) => {
  const errors = watchBrowserErrors(page);
  await page.route('**/v1/agents?**', (route) =>
    route.fulfill({ json: { agents: [agent], nextCursor: null } }),
  );
  await page.route('**/v1/runs?**', (route) =>
    route.fulfill({ json: { runs: [], nextCursor: null } }),
  );
  await page.route('**/v1/models', (route) =>
    route.fulfill({
      json: {
        models: [{ provider: 'fake', id: 'fake-model', name: 'Fake model' }],
        defaultModel: { provider: 'fake', id: 'fake-model', name: 'Fake model' },
      },
    }),
  );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/new');
  await page.getByRole('button', { name: 'Choose project' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose project' });
  await expect(picker.getByRole('option', { name: /workspace/ })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Delete project workspace' })).toBeVisible();
  await expect(picker.getByPlaceholder('Search projects')).toBeVisible();
  await expect(picker).toHaveCSS('opacity', '1');
  const composerBox = await page.getByRole('form', { name: 'New session composer' }).boundingBox();
  const pickerBox = await picker.boundingBox();
  expect(composerBox).not.toBeNull();
  expect(pickerBox).not.toBeNull();
  expect(pickerBox?.top ?? 0).toBeGreaterThanOrEqual(composerBox?.bottom ?? 0);
  mkdirSync('.impeccable/review', { recursive: true });
  const viewport = testInfo.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  await page.screenshot({
    path: `.impeccable/review/project-picker-list-${viewport}.png`,
    fullPage: true,
  });
  await picker.getByRole('button', { name: 'Delete project workspace' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete saved project?' });
  await expect(confirmation).toContainText('Files on disk will not be changed.');
  await confirmation.getByRole('button', { name: 'Delete project' }).click();
  await expect(picker.getByRole('button', { name: 'Delete project workspace' })).toBeHidden();
  await picker.getByRole('button', { name: 'New project' }).click();
  await picker.getByLabel('Working directory').fill('/tmp/new-project');
  await picker.getByRole('button', { name: 'Use project' }).click();
  await expect(page.getByRole('button', { name: 'Choose project' })).toContainText('new-project');
  expect(errors).toEqual([]);

  await page.screenshot({
    path: `.impeccable/review/project-picker-${viewport}.png`,
    fullPage: true,
  });
});

test('adds a server and selects it in the composer', async ({ page }, testInfo) => {
  const errors = watchBrowserErrors(page);
  await page.route('**/v1/agents?**', (route) =>
    route.fulfill({ json: { agents: [agent], nextCursor: null } }),
  );
  await page.route('**/v1/runs?**', (route) =>
    route.fulfill({ json: { runs: [], nextCursor: null } }),
  );
  await page.route('**/v1/projects?**', (route) =>
    route.fulfill({ json: { projects: [project], nextCursor: null } }),
  );
  await page.route('**/v1/models', (route) =>
    route.fulfill({
      json: {
        models: [{ provider: 'fake', id: 'fake-model', name: 'Fake model' }],
        defaultModel: { provider: 'fake', id: 'fake-model', name: 'Fake model' },
      },
    }),
  );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/new');
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: /^Servers/ }).click();
  await settings.getByRole('button', { name: 'Add server' }).click();
  const editor = page.getByRole('dialog', { name: 'Add server' });
  await editor.getByLabel('Name').fill('Build host');
  await editor.getByLabel('Server address').fill('https://agents.example.com');
  await editor.getByLabel('Access token').fill('test-token');
  await editor.getByRole('button', { name: 'Add server' }).click();

  await expect(settings.getByRole('list', { name: 'Configured servers' })).toContainText(
    'Build host',
  );
  mkdirSync('.impeccable/review', { recursive: true });
  const viewport = testInfo.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  await page.screenshot({
    path: `.impeccable/review/settings-servers-${viewport}.png`,
    fullPage: true,
  });

  await settings.getByRole('button', { name: 'Close' }).click();
  const serverSelect = page.getByRole('combobox', { name: 'Remote host' });
  await serverSelect.click();
  await page.getByRole('option', { name: 'Build host' }).click();
  await expect(serverSelect).toContainText('Build host');
  expect(errors).toEqual([]);
});

test('applies composer commands and completes @ file references in a new session', async ({
  page,
}, testInfo) => {
  const errors = watchBrowserErrors(page);
  await page.route('**/v1/agents?**', (route) =>
    route.fulfill({ json: { agents: [agent], nextCursor: null } }),
  );
  await page.route('**/v1/runs?**', (route) =>
    route.fulfill({ json: { runs: [], nextCursor: null } }),
  );
  await page.route('**/v1/models', (route) =>
    route.fulfill({
      json: {
        models: [{ provider: 'fake', id: 'fake-model', name: 'Fake model' }],
        defaultModel: { provider: 'fake', id: 'fake-model', name: 'Fake model' },
      },
    }),
  );
  await page.route('**/v1/composer/suggestions?**', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('kind') === 'command') {
      await route.fulfill({
        json: {
          cwd: '/workspace',
          suggestions: [
            {
              value: 'model',
              label: '/model',
              description: '<provider/model> — Select model',
              kind: 'command',
            },
          ],
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        cwd: '/workspace',
        suggestions: [
          {
            value: '@src/App.tsx',
            label: 'App.tsx',
            description: '/workspace/src/App.tsx',
            kind: 'file',
          },
        ],
      },
    });
  });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/new');
  const composer = page.getByRole('textbox', { name: 'Session task' });
  const composerForm = page.getByRole('form', { name: 'New session composer' });
  const sessionSettings = page.getByRole('group', { name: 'Session settings' });
  await expect(sessionSettings).toBeVisible();
  await expect
    .poll(() => composerForm.evaluate((element) => getComputedStyle(element).opacity))
    .toBe('1');
  await expect
    .poll(() => sessionSettings.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  await expect
    .poll(() =>
      sessionSettings.evaluate(
        (element) =>
          new Set(
            [...element.children].map((child) => Math.round(child.getBoundingClientRect().top)),
          ).size,
      ),
    )
    .toBeGreaterThan(1);

  mkdirSync('.impeccable/review', { recursive: true });
  await page.screenshot({
    path: `.impeccable/review/composer-wrapped-settings-${testInfo.project.name}.png`,
    fullPage: true,
  });

  await composer.fill('/think ');
  await expect(page.getByRole('listbox', { name: 'Thinking level options' })).toBeVisible();
  await page.screenshot({
    path: `.impeccable/review/composer-autocomplete-${testInfo.project.name}.png`,
    fullPage: true,
  });
  for (let index = 0; index < 4; index += 1) await composer.press('ArrowDown');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('combobox', { name: 'Thinking level' })).toContainText('High');

  await composer.fill('@App');
  await expect(page.getByRole('option', { name: /App\.tsx/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(composer).toHaveValue('@src/App.tsx ');
  expect(errors).toEqual([]);
});

test('switches sessions from the global command palette', async ({ page }, testInfo) => {
  const errors = watchBrowserErrors(page);
  await page.route('**/v1/agents?**', (route) =>
    route.fulfill({ json: { agents: [agent], nextCursor: null } }),
  );
  await page.route('**/v1/runs?**', (route) =>
    route.fulfill({ json: { runs: [run], nextCursor: null } }),
  );
  await page.route('**/v1/models', (route) =>
    route.fulfill({ json: { models: [], defaultModel: null } }),
  );
  await page.route(`**/v1/runs/${run.id}/events?**`, (route) =>
    route.fulfill({ json: { events: [] } }),
  );
  await page.routeWebSocket(`**/v1/runs/${run.id}/stream?**`, () => undefined);
  await page.route('**/v1/sessions/search?**', (route) =>
    route.fulfill({
      json: {
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
      },
    }),
  );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Switch session' });
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder('Switch to a session…').fill('Review');
  const result = palette.getByRole('option', { name: /Review the changes/ });
  await expect(result).toBeVisible();
  await expect(
    palette.getByRole('option', { name: /Fleet|Inbox|Settings|New session/ }),
  ).toHaveCount(0);
  await result.click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${run.id}$`));
  await expect(page.getByRole('heading', { name: 'Review the changes.' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Chat with agent' })).toHaveCSS('opacity', '1');
  expect(errors).toEqual([]);
  mkdirSync('.impeccable/review', { recursive: true });
  const viewport = testInfo.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  await page.screenshot({
    path: `.impeccable/review/session-switcher-${viewport}.png`,
    fullPage: true,
  });
});

test('creates an agent and starts a managed run', async ({ page }, testInfo) => {
  const errors = watchBrowserErrors(page);
  let createdAgentBody: unknown;
  let createdRunBody: unknown;
  await page.route('**/v1/agents?**', (route) =>
    route.fulfill({ json: { agents: [], nextCursor: null } }),
  );
  await page.route('**/v1/agents', async (route) => {
    createdAgentBody = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: agent });
  });
  await page.route('**/v1/runs?**', (route) =>
    route.fulfill({ json: { runs: [], nextCursor: null } }),
  );
  await page.route('**/v1/models', (route) =>
    route.fulfill({
      json: {
        models: [{ provider: 'fake', id: 'fake-model', name: 'Fake model' }],
        defaultModel: { provider: 'fake', id: 'fake-model', name: 'Fake model' },
      },
    }),
  );
  await page.route('**/v1/runs', async (route) => {
    createdRunBody = route.request().postDataJSON();
    await route.fulfill({ status: 202, json: { ...run, status: 'running', completedAt: null } });
  });
  await page.route(`**/v1/runs/${run.id}/events?**`, (route) =>
    route.fulfill({ json: { events: [] } }),
  );
  await page.routeWebSocket(`**/v1/runs/${run.id}/stream?**`, () => undefined);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/new');
  await page.getByRole('button', { name: 'Open agent settings' }).click();
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDialog).toBeVisible();
  await page.getByRole('button', { name: 'New agent' }).click();
  let agentEditor = page.getByRole('dialog', { name: 'New agent' });
  await agentEditor.getByRole('radio', { name: 'This prompt only' }).click();
  await agentEditor.getByRole('switch', { name: 'Allow tool calls' }).click();
  await expect(agentEditor.getByText(/becomes the complete system prompt/)).toBeVisible();
  await expect(agentEditor.locator('form')).toHaveCSS('opacity', '1');
  await expect(agentEditor.getByRole('group', { name: 'Tools' }).locator('..')).toHaveCSS(
    'opacity',
    '1',
  );
  const viewport = testInfo.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  mkdirSync('.impeccable/review', { recursive: true });
  await page.screenshot({
    path: `.impeccable/review/agent-editor-${viewport}.png`,
    fullPage: true,
  });
  await agentEditor.getByRole('button', { name: 'Close' }).click();
  await settingsDialog.getByRole('button', { name: 'Appearance' }).click();
  await settingsDialog.getByRole('radio', { name: /Dark/ }).click();
  await settingsDialog.getByRole('button', { name: /^Agents/ }).click();
  await settingsDialog.getByRole('button', { name: 'New agent' }).click();
  agentEditor = page.getByRole('dialog', { name: 'New agent' });
  const replacementPrompt = agentEditor.getByRole('radio', { name: 'This prompt only' });
  if ((await replacementPrompt.getAttribute('aria-checked')) !== 'true') {
    await replacementPrompt.click();
  }
  const toolCalls = agentEditor.getByRole('switch', { name: 'Allow tool calls' });
  if ((await toolCalls.getAttribute('aria-checked')) !== 'false') await toolCalls.click();
  await expect(agentEditor.getByRole('group', { name: 'Tools' }).locator('..')).toHaveCSS(
    'opacity',
    '1',
  );
  await page.screenshot({
    path: `.impeccable/review/agent-editor-dark-${viewport}.png`,
    fullPage: true,
  });
  await agentEditor.getByRole('button', { name: 'Create agent' }).click();
  await expect(agentEditor).toBeHidden();
  await page.screenshot({
    path: `.impeccable/review/settings-${viewport}.png`,
    fullPage: true,
  });
  await page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: 'Close' })
    .click();
  await expect(page.getByRole('textbox', { name: 'Session task' })).toBeVisible();
  await page.screenshot({ path: `.impeccable/review/${viewport}.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  await page.getByRole('textbox', { name: 'Session task' }).fill('Review the changes.');
  await page.getByRole('button', { name: 'Start session' }).click();

  await expect(
    page.getByRole('heading', { name: 'Review the changes.', exact: true }),
  ).toBeVisible();
  expect(createdAgentBody).toMatchObject({
    name: 'Coding agent',
    systemPromptMode: 'replace',
    tools: [],
  });
  expect(createdRunBody).toEqual({
    agentId: agent.id,
    prompt: 'Review the changes.',
    model: { provider: 'fake', id: 'fake-model' },
    thinkingLevel: 'medium',
    cwd: '/workspace',
    idempotencyKey: expect.any(String),
  });
  expect(errors).toEqual([]);
});
