import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { SupervisorClient } from '../../packages/agents-client/protocol';
import { expect, test } from '@playwright/test';

test('unified agent client talks to the Rust host over HTTP and renders persisted Pi events', async ({
  page,
  request,
}) => {
  const browserErrors: string[] = [];
  const agentRequests: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (failedRequest) =>
    browserErrors.push(
      `requestfailed: ${failedRequest.url()} ${failedRequest.failure()?.errorText ?? ''}`,
    ),
  );
  page.on('request', (outgoingRequest) => {
    if (new URL(outgoingRequest.url()).pathname.startsWith('/agents/')) {
      agentRequests.push(outgoingRequest.url());
    }
  });

  const suffix = `${test.info().project.name}-${test.info().workerIndex}`;
  const projectPath = resolve('.tmp/agents-e2e/workspaces', suffix);
  mkdirSync(projectPath, { recursive: true });
  const agentResponse = await request.post('/agents/v1/agents', {
    data: {
      name: `Live agent ${suffix}`,
      systemPrompt: 'Answer through the real unified host.',
      cwd: process.cwd(),
      model: { provider: 'fake', id: 'fake-model' },
    },
  });
  expect(agentResponse.status()).toBe(201);
  const agent = (await agentResponse.json()) as { id: string };

  const runRequest = {
    agentId: agent.id,
    prompt: `Live transport check ${suffix}`,
    idempotencyKey: `live-run-${suffix}`,
    attachments: [
      {
        name: 'pixel.png',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      },
    ],
  };
  const runResponse = await request.post('/agents/v1/runs', { data: runRequest });
  expect(runResponse.status()).toBe(202);
  const run = (await runResponse.json()) as { id: string; acknowledgementId?: string };
  expect(run.acknowledgementId).toBeTruthy();

  const replayResponse = await request.post('/agents/v1/runs', { data: runRequest });
  expect(replayResponse.status()).toBe(202);
  await expect(replayResponse.json()).resolves.toMatchObject({
    id: run.id,
    acknowledgementId: run.acknowledgementId,
  });

  await expect
    .poll(async () => {
      const response = await request.get(`/agents/v1/runs/${run.id}`);
      return ((await response.json()) as { status: string }).status;
    })
    .toBe('completed');

  // Exercise the actual browser-client decoders against the Rust server. A raw
  // HTTP 200 is insufficient: every response must satisfy the shared contract.
  const client = new SupervisorClient({ baseUrl: 'http://127.0.0.1:4173' });
  await expect(client.getAgent(agent.id)).resolves.toMatchObject({ id: agent.id });
  await expect(
    client.renameAgent(agent.id, { systemPromptMode: 'replace', tools: ['read', 'write'] }),
  ).resolves.toMatchObject({
    id: agent.id,
    systemPromptMode: 'replace',
    tools: ['read', 'write'],
  });
  await expect(client.listAgents({ limit: 100 })).resolves.toMatchObject({
    agents: expect.arrayContaining([expect.objectContaining({ id: agent.id })]),
  });
  await expect(client.listRuns({ limit: 100 })).resolves.toMatchObject({
    runs: expect.arrayContaining([expect.objectContaining({ id: run.id })]),
  });
  await expect(client.getRun(run.id)).resolves.toMatchObject({ id: run.id, status: 'completed' });
  await expect(client.listRunAttachments(run.id)).resolves.toMatchObject({
    attachments: [expect.objectContaining({ name: 'pixel.png' })],
  });
  await expect(
    client.listRunEventPage(run.id, { beforeSequence: Number.MAX_SAFE_INTEGER, limit: 100 }),
  ).resolves.toMatchObject({ hasMore: false });
  await expect(client.getRunDebugLog(run.id)).resolves.toMatchObject({ runId: run.id });
  await expect(client.getRunChanges(run.id, 'working_tree')).resolves.toMatchObject({
    runId: run.id,
    scope: 'working_tree',
  });
  await expect(client.getFleet()).resolves.toMatchObject({
    counts: { total: expect.any(Number) },
  });
  await expect(client.listModels()).resolves.toMatchObject({
    defaultModel: { provider: 'fake', id: 'fake-model' },
  });
  await expect(client.listExtensions()).resolves.toMatchObject({ extensions: [] });
  await expect(
    client.listComposerSuggestions({ cwd: process.cwd(), kind: 'file', prefix: 'package' }),
  ).resolves.toMatchObject({ cwd: process.cwd() });
  const project = await client.createProject({ path: projectPath, name: `Project ${suffix}` });
  await expect(
    client.updateProject(project.id, { name: `Renamed project ${suffix}` }),
  ).resolves.toMatchObject({ id: project.id, name: `Renamed project ${suffix}` });
  await expect(client.listProjects({ limit: 100 })).resolves.toMatchObject({
    projects: expect.arrayContaining([expect.objectContaining({ id: project.id })]),
  });
  await expect(client.deleteProject(project.id)).resolves.toMatchObject({ id: project.id });
  await expect(client.listInbox()).resolves.toEqual({ items: [] });
  await expect(client.searchSessions(`Live transport check ${suffix}`)).resolves.toMatchObject({
    results: [expect.objectContaining({ runId: run.id })],
  });
  await expect(client.getCommandReceipt(`live-run-${suffix}`)).resolves.toMatchObject({
    command: 'run_create',
    result: expect.objectContaining({ id: run.id }),
  });
  await expect(
    client.steerRun(run.id, { message: 'Steer exactly once.', idempotencyKey: `steer-${suffix}` }),
  ).resolves.toMatchObject({ id: run.id, acknowledgementId: expect.any(String) });
  await expect(
    client.followUpRun(run.id, {
      message: 'Follow up exactly once.',
      idempotencyKey: `follow-up-${suffix}`,
    }),
  ).resolves.toMatchObject({ id: run.id, acknowledgementId: expect.any(String) });
  await expect(client.cancelRun(run.id, `cancel-${suffix}`)).rejects.toMatchObject({
    code: 'run_not_cancellable',
    status: 409,
  });

  const routeResponse = await page.goto(`/agents/servers/local/sessions/${run.id}`, {
    waitUntil: 'domcontentloaded',
  });
  expect(routeResponse?.status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: `Live transport check ${suffix}`, exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Live unified server reply.', { exact: true })).toBeVisible();
  await expect(page.getByLabel(`Live agent ${suffix} conversation`)).toBeVisible();
  await expect(page.getByRole('group', { name: 'Prompt attachments' })).toBeVisible();

  expect(agentRequests.length).toBeGreaterThan(0);
  expect(
    agentRequests.every((url) => !new URL(url).pathname.startsWith('/agents/agents/')),
  ).toBe(true);
  expect(browserErrors).toEqual([]);
});
