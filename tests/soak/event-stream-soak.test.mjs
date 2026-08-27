import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { LruCache } from '../../apps/web/src/lib/lru.ts';
import { RendererSoakProbe } from '../../apps/web/src/lib/renderer-soak.tsx';
import { SupervisorClient } from '../../apps/web/src/lib/supervisor-client.ts';
import { mergeTranscriptEvents } from '../../apps/web/src/lib/transcript.ts';
import supervisorPackage from '../../packages/supervisor/index.ts';

const { buildSupervisorApp } = supervisorPackage;

const root = resolve(import.meta.dirname, '../..');
const budgets = JSON.parse(await readFile(new URL('./budgets.json', import.meta.url), 'utf8'));
const token = 'soak-fixture-token';

class SoakSession {
  model = { provider: 'fake', id: 'soak-model' };
  thinkingLevel = 'off';
  isStreaming = false;
  messageCount = 0;
  pendingMessageCount = 0;
  abortCount = 0;
  listeners = new Set();
  #resolvePrompt;

  constructor(sessionId, sessionFile) {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
  }

  async prompt(_prompt, options) {
    options?.preflightResult?.(true);
    this.isStreaming = true;
    this.messageCount += 1;
    this.emit({ type: 'agent_start' });
    await new Promise((resolve) => {
      this.#resolvePrompt = resolve;
    });
  }

  async steer() {}
  async followUp() {}
  async abort() {
    this.abortCount += 1;
    this.settle();
  }
  async dispose() {
    this.listeners.clear();
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
  settle() {
    if (!this.isStreaming) return;
    this.isStreaming = false;
    this.messageCount += 1;
    this.emit({ type: 'agent_settled' });
    this.#resolvePrompt?.();
    this.#resolvePrompt = undefined;
  }
}

class SoakSessionFactory {
  sessions = [];

  constructor(sessionDirectory) {
    this.sessionDirectory = sessionDirectory;
  }

  async listModels() {
    return { models: [], defaultModel: null };
  }

  async create() {
    const sessionId = `soak-session-${this.sessions.length + 1}`;
    const sessionFile = join(this.sessionDirectory, `${sessionId}.jsonl`);
    await writeFile(sessionFile, `${JSON.stringify({ sessionId })}\n`, { mode: 0o600 });
    const session = new SoakSession(sessionId, sessionFile);
    this.sessions.push(session);
    return session;
  }

  async resume(options) {
    const session = new SoakSession(options.sessionId, options.sessionFile);
    this.sessions.push(session);
    return session;
  }
}

async function waitUntil(predicate, diagnostic, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${diagnostic}`);
}

async function listen(app) {
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.server.address();
  if (!address || typeof address === 'string') throw new Error('soak_listener_missing');
  return `http://127.0.0.1:${address.port}`;
}

async function ticket(baseUrl, authorization = token) {
  const response = await fetch(`${baseUrl}/v1/ws-tickets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authorization}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`ticket_${response.status}`);
  return (await response.json()).ticket;
}

class TrackingWebSocket extends WebSocket {
  static instances = new Set();

  constructor(url) {
    super(url);
    TrackingWebSocket.instances.add(this);
    this.once('close', () => TrackingWebSocket.instances.delete(this));
  }
}

function forceDisconnect(runId) {
  for (const socket of TrackingWebSocket.instances) {
    if (socket.url.includes(encodeURIComponent(runId)) || socket.url.includes(runId))
      socket.terminate();
  }
}

function connectStream(client, runId, state) {
  const controller = new AbortController();
  const started = performance.now();
  let reconnectingAt = started;
  const task = (async () => {
    try {
      for await (const event of client.streamRunEvents(runId, {
        afterSequence: state.cursor,
        signal: controller.signal,
        onConnectionState(connectionState) {
          if (connectionState === 'reconnecting') reconnectingAt = performance.now();
          if (connectionState !== 'connected') return;
          state.reconnects += 1;
          const elapsed =
            state.reconnects === 1
              ? performance.now() - started
              : performance.now() - reconnectingAt;
          state.maxReconnectMs = Math.max(state.maxReconnectMs, elapsed);
        },
      })) {
        if (event.sequence <= state.cursor) {
          state.duplicates += 1;
          continue;
        }
        if (event.sequence !== state.cursor + 1) state.gaps += 1;
        state.cursor = event.sequence;
        state.received += 1;
        state.retained = mergeTranscriptEvents(state.retained, [event]);
      }
    } catch (error) {
      state.streamError = String(error);
    }
  })();
  return {
    close() {
      controller.abort();
    },
    task,
  };
}

async function closeStream(stream) {
  if (!stream) return;
  stream.close();
  await stream.task;
}

function syntheticCount(app) {
  const [row] = app.database.sqlite
    .prepare(
      "SELECT COUNT(*) AS count FROM supervisor_agent_events WHERE event_type = 'soak.event'",
    )
    .all();
  return Number(row?.count ?? 0);
}

function maxSequence(app, agentId) {
  const [row] = app.database.sqlite
    .prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM supervisor_agent_events WHERE agent_id = ?',
    )
    .all([agentId]);
  return Number(row?.sequence ?? 0);
}

async function closeApp(app) {
  if (!app) return;
  await app.server.close();
}

test('100k-event/25-agent SupervisorClient and React renderer soak stays lossless across reconnect and restart', {
  timeout: budgets.maxDurationMs,
}, async () => {
  const started = performance.now();
  const initialHeap = process.memoryUsage().heapUsed;
  const initialHandles = process._getActiveHandles().length;
  const directory = await mkdtemp(join(tmpdir(), 'pideck-event-soak-'));
  const databasePath = join(directory, 'soak.sqlite');
  const sessionDirectory = join(directory, 'pi-sessions');
  await mkdir(sessionDirectory, { recursive: true });
  const factory = new SoakSessionFactory(sessionDirectory);
  let app;
  let streams = [];
  let rendererRoot;
  let rendererDom;
  try {
    app = buildSupervisorApp({
      databasePath,
      serviceToken: token,
      piSessionFactory: factory,
      agentDefaultCwd: directory,
      piSessionDirectory: sessionDirectory,
      websocketMaxQueuedBytes: 1024 * 1024,
      websocketMaxConnectionsPerCredential: budgets.agents + 5,
    });
    let baseUrl = await listen(app);
    await assert.rejects(() => ticket(baseUrl, 'wrong-token'), /ticket_401/);
    const realFetch = globalThis.fetch.bind(globalThis);
    let ticketFailures = 0;
    const client = new SupervisorClient({
      baseUrl,
      serviceToken: token,
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/v1/ws-tickets') && ticketFailures < budgets.agents) {
          ticketFailures += 1;
          return new Response(JSON.stringify({ error: { code: 'temporary', message: 'retry' } }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return realFetch(input, init);
      },
      webSocketFactory: TrackingWebSocket,
    });

    const agents = [];
    for (let index = 0; index < budgets.agents; index += 1) {
      const agent = await app.agents.createAgent({
        name: `Soak agent ${index + 1}`,
        systemPrompt: 'Deterministic soak fixture',
      });
      const run = await app.agents.createRun({ agentId: agent.id, prompt: 'Soak.' });
      const state = {
        cursor: 1,
        duplicates: 0,
        gaps: 0,
        received: 0,
        retained: [],
        reconnects: 0,
        maxReconnectMs: 0,
        streamError: undefined,
      };
      const stream = connectStream(client, run.id, state);
      agents.push({ agent, run, state, session: factory.sessions[index] });
      streams.push(stream);
    }

    const { JSDOM } = await import('../../apps/web/node_modules/jsdom/lib/api.js');
    const React = await import('../../apps/web/node_modules/react/index.js');
    const { createRoot } = await import('../../apps/web/node_modules/react-dom/client.js');
    rendererDom = new JSDOM('<!doctype html><main id="renderer"></main>', {
      url: 'http://renderer.test/',
    });
    globalThis.window = rendererDom.window;
    globalThis.document = rendererDom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: rendererDom.window.navigator,
    });
    const rendererContainer = rendererDom.window.document.querySelector('#renderer');
    if (!rendererContainer) throw new Error('renderer_container_missing');
    rendererRoot = createRoot(rendererContainer);
    const rendererStates = [];
    const onRendererState = (state) => rendererStates.push(state);
    const renderRoute = (runId) => {
      rendererRoot.render(
        React.createElement(RendererSoakProbe, {
          client,
          runId,
          onConnectionState: onRendererState,
        }),
      );
    };
    renderRoute(agents[0].run.id);
    await waitUntil(
      () =>
        rendererContainer.querySelector('output')?.getAttribute('data-run-id') === agents[0].run.id,
      'initial production renderer route',
    );
    const rendererAttachmentCache = new LruCache(24);
    for (const entry of agents) rendererAttachmentCache.set(entry.run.id, entry.run.id);
    assert.equal(rendererAttachmentCache.size, 24);
    assert.equal(rendererAttachmentCache.has(agents[0].run.id), false);

    const eventsPerBatch = budgets.maxQueuedEventsPerAgent;
    let emitted = 0;
    let batch = 0;
    while (emitted < budgets.events) {
      batch += 1;
      const disconnectIndexes =
        batch % 4 === 0 ? [batch % agents.length, (batch + 7) % agents.length] : [];
      for (const index of disconnectIndexes) {
        forceDisconnect(agents[index].run.id);
      }
      if (batch % 5 === 0) {
        const route = agents[batch % agents.length].run.id;
        renderRoute(route);
        await waitUntil(
          () => rendererContainer.querySelector('output')?.getAttribute('data-run-id') === route,
          `production renderer route ${route}`,
        );
      }

      for (let perAgent = 0; perAgent < eventsPerBatch && emitted < budgets.events; perAgent += 1) {
        for (const entry of agents) {
          if (emitted >= budgets.events) break;
          entry.session.emit({
            type: 'soak.event',
            ordinal: emitted,
            kind: emitted === 0 ? 'large' : emitted % 29 === 0 ? 'tool' : 'text',
            ...(emitted === 0 ? { content: 'x'.repeat(240_000) } : {}),
          });
          emitted += 1;
        }
      }

      await waitUntil(() => syntheticCount(app) === emitted, `durable event ${emitted}`, 30_000);
      await waitUntil(
        () => agents.every((entry) => entry.state.cursor === maxSequence(app, entry.agent.id)),
        `stream convergence after batch ${batch}: ${JSON.stringify(
          agents.map((entry) => ({
            agentId: entry.agent.id,
            cursor: entry.state.cursor,
            durable: maxSequence(app, entry.agent.id),
          })),
        )}`,
        15_000,
      );
    }

    assert.ok(ticketFailures > 0);
    assert.ok(rendererStates.includes('connected'));
    assert.ok(agents.every((entry) => entry.state.streamError === undefined));
    const historyPage = await client.listRunEventPage(agents[0].run.id, {
      beforeSequence: maxSequence(app, agents[0].agent.id),
      limit: 10,
    });
    assert.equal(historyPage.events.length, 10);
    assert.equal(historyPage.events.at(-1).sequence < maxSequence(app, agents[0].agent.id), true);

    const interventionStarted = performance.now();
    for (let index = 0; index < 5; index += 1) factory.sessions[index].settle();
    for (let index = 5; index < 10; index += 1) {
      const idempotencyKey = `soak-cancel-${index}`;
      await app.agents.cancelRun(agents[index].run.id, idempotencyKey);
      await app.agents.cancelRun(agents[index].run.id, idempotencyKey);
      assert.equal(factory.sessions[index].abortCount, 1);
    }
    await waitUntil(async () => {
      const statuses = await Promise.all(
        agents
          .slice(0, 10)
          .map((entry) => app.agents.getRun(entry.run.id).then((run) => run?.status)),
      );
      return (
        statuses.slice(0, 5).every((status) => status === 'completed') &&
        statuses.slice(5).every((status) => status === 'cancelled')
      );
    }, 'completed and cancelled terminal states');
    const interventionLatencyMs = performance.now() - interventionStarted;

    rendererRoot.unmount();
    rendererRoot = undefined;
    rendererDom.window.close();
    rendererDom = undefined;
    await Promise.all(streams.map(closeStream));
    streams = [];
    await closeApp(app);
    app = undefined;

    const restartFactory = new SoakSessionFactory(sessionDirectory);
    app = buildSupervisorApp({
      databasePath,
      serviceToken: token,
      piSessionFactory: restartFactory,
      agentDefaultCwd: directory,
      piSessionDirectory: sessionDirectory,
    });
    baseUrl = await listen(app);
    const statusesAfterRestart = await Promise.all(
      agents.map((entry) => app.agents.getRun(entry.run.id).then((run) => run?.status)),
    );
    assert.deepEqual(statusesAfterRestart.slice(0, 5), Array(5).fill('completed'));
    assert.deepEqual(statusesAfterRestart.slice(5, 10), Array(5).fill('cancelled'));
    assert.ok(statusesAfterRestart.slice(10).every((status) => status === 'failed'));
    assert.equal(syntheticCount(app), budgets.events);

    let pagedSyntheticEvents = 0;
    for (const entry of agents) {
      let afterSequence = 0;
      for (;;) {
        const page = await app.agents.listRunEvents(entry.run.id, {
          afterSequence,
          limit: 1_000,
        });
        if (page.length === 0) break;
        pagedSyntheticEvents += page.filter((event) => event.type === 'soak.event').length;
        afterSequence = page.at(-1).sequence;
      }
    }
    assert.equal(pagedSyntheticEvents, budgets.events);

    await closeApp(app);
    app = undefined;
    globalThis.gc?.();
    await waitUntil(
      () => process._getActiveHandles().length - initialHandles <= budgets.maxOpenHandleGrowth,
      'open handles to return to the post-warmup budget',
    );

    const summary = {
      agents: agents.length,
      events: budgets.events,
      missing: budgets.events - pagedSyntheticEvents,
      duplicates: agents.reduce((sum, entry) => sum + entry.state.duplicates, 0),
      orderingGaps: agents.reduce((sum, entry) => sum + entry.state.gaps, 0),
      maxRetainedEvents: Math.max(...agents.map((entry) => entry.state.retained.length)),
      reconnects: agents.reduce((sum, entry) => sum + entry.state.reconnects, 0),
      maxReconnectMs: Math.ceil(Math.max(...agents.map((entry) => entry.state.maxReconnectMs))),
      interventionLatencyMs: Math.ceil(interventionLatencyMs),
      heapGrowthBytes: Math.max(0, process.memoryUsage().heapUsed - initialHeap),
      openHandleGrowth: Math.max(0, process._getActiveHandles().length - initialHandles),
      durationMs: Math.ceil(performance.now() - started),
    };
    assert.equal(summary.missing, 0, JSON.stringify(summary));
    assert.equal(summary.duplicates, 0, JSON.stringify(summary));
    assert.equal(summary.orderingGaps, 0, JSON.stringify(summary));
    assert.ok(
      summary.maxRetainedEvents <= budgets.rendererRetainedPerAgent,
      JSON.stringify(summary),
    );
    assert.ok(summary.maxReconnectMs <= budgets.maxReconnectMs, JSON.stringify(summary));
    assert.ok(
      summary.interventionLatencyMs <= budgets.maxInterventionLatencyMs,
      JSON.stringify(summary),
    );
    assert.ok(summary.heapGrowthBytes <= budgets.maxHeapGrowthBytes, JSON.stringify(summary));
    assert.ok(summary.openHandleGrowth <= budgets.maxOpenHandleGrowth, JSON.stringify(summary));
    assert.ok(summary.durationMs <= budgets.maxDurationMs, JSON.stringify(summary));
    await mkdir(join(root, 'test-results'), { recursive: true });
    await writeFile(
      join(root, 'test-results', 'soak-summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  } finally {
    rendererRoot?.unmount();
    rendererRoot = undefined;
    rendererDom?.window.close();
    rendererDom = undefined;
    await Promise.all(streams.map(closeStream));
    await closeApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});
