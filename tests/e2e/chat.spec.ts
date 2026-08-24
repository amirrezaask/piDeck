import { mkdirSync } from 'node:fs';

import { expect, type Page, test } from '@playwright/test';

const timestamp = '2026-08-23T20:00:00.000Z';
const agent = {
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
  await page.route('**/supervisor/v1/agents?**', (route) =>
    route.fulfill({ json: { agents: [agent], nextCursor: null } }),
  );
  await page.route('**/supervisor/v1/runs?**', (route) =>
    route.fulfill({ json: { runs: [run], nextCursor: null } }),
  );
  await page.route('**/supervisor/v1/models', (route) =>
    route.fulfill({
      json: {
        models: [{ provider: 'fake', id: 'fake-model', name: 'Fake model' }],
        defaultModel: { provider: 'fake', id: 'fake-model', name: 'Fake model' },
      },
    }),
  );
  await page.route(`**/supervisor/v1/runs/${run.id}/events?**`, (route) =>
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
        ],
      },
    }),
  );
  await page.route(`**/supervisor/v1/runs/${run.id}/stream?**`, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({
        agentId: agent.id,
        runId: run.id,
        sequence: 2,
        type: 'message_update',
        payload: { assistantMessageEvent: { type: 'text_delta', delta: 'Everything checks out.' } },
        createdAt: timestamp,
      })}\n\n`,
    }),
  );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Review the changes.', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('PI started the run')).toBeVisible();
  await expect(page.getByText('Everything checks out.')).toBeVisible();
  await expect(page.getByLabel('Workspace agent conversation')).toBeVisible();
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
});

test('creates an agent and starts a managed run', async ({ page }, testInfo) => {
  const errors = watchBrowserErrors(page);
  let createdAgentBody: unknown;
  let createdRunBody: unknown;
  await page.route('**/supervisor/v1/agents?**', (route) =>
    route.fulfill({ json: { agents: [], nextCursor: null } }),
  );
  await page.route('**/supervisor/v1/agents', async (route) => {
    createdAgentBody = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: agent });
  });
  await page.route('**/supervisor/v1/runs?**', (route) =>
    route.fulfill({ json: { runs: [], nextCursor: null } }),
  );
  await page.route('**/supervisor/v1/models', (route) =>
    route.fulfill({
      json: {
        models: [{ provider: 'fake', id: 'fake-model', name: 'Fake model' }],
        defaultModel: { provider: 'fake', id: 'fake-model', name: 'Fake model' },
      },
    }),
  );
  await page.route('**/supervisor/v1/runs', async (route) => {
    createdRunBody = route.request().postDataJSON();
    await route.fulfill({ status: 202, json: { ...run, status: 'running', completedAt: null } });
  });
  await page.route(`**/supervisor/v1/runs/${run.id}/events?**`, (route) =>
    route.fulfill({ json: { events: [] } }),
  );
  await page.route(`**/supervisor/v1/runs/${run.id}/stream?**`, (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: '' }),
  );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open agent settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'New agent' }).click();
  await page.getByRole('button', { name: 'Create agent' }).click();
  await expect(page.getByRole('dialog', { name: 'New agent' })).toBeHidden();
  const viewport = testInfo.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  mkdirSync('.impeccable/review', { recursive: true });
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
  expect(createdAgentBody).toMatchObject({ name: 'Coding agent' });
  expect(createdRunBody).toEqual({
    agentId: agent.id,
    prompt: 'Review the changes.',
    model: { provider: 'fake', id: 'fake-model' },
    thinkingLevel: 'medium',
    cwd: '/workspace',
  });
  expect(errors).toEqual([]);
});
