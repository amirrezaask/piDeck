import { randomUUID } from 'node:crypto';

import {
  type AgentEvent,
  AgentEventSchema,
  type AgentExecutionRequest,
  type AgentFactory,
  type AgentInstance,
  type CreateAgentRequest,
} from '@nextflow/agent-runtime';
import { type JsonValue, JsonValueSchema } from '@nextflow/contracts';
import { z } from 'zod';

export const EchoConfigSchema = z.object({});

export const DelayedConfigSchema = z.object({
  messages: z.array(z.string()).default([]),
  delayMs: z.number().int().min(0).default(0),
  output: JsonValueSchema.optional(),
});

export const FailingConfigSchema = z.object({
  code: z.string().min(1).default('mock_failure'),
  message: z.string().min(1).default('The mock agent failed'),
});

export const ScriptedConfigSchema = z.object({
  events: z.array(AgentEventSchema).min(1),
});

abstract class MockAgent implements AgentInstance {
  readonly id = randomUUID();
  private disposed = false;

  protected assertUsable(): void {
    if (this.disposed) {
      throw new Error('agent_already_disposed');
    }
  }

  protected markDisposed(): void {
    this.disposed = true;
  }

  async dispose(): Promise<void> {
    this.markDisposed();
  }

  abstract execute(request: AgentExecutionRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

export class EchoAgent extends MockAgent {
  async *execute(request: AgentExecutionRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.assertUsable();
    throwIfAborted(signal);
    yield { type: 'started' };
    throwIfAborted(signal);
    yield { type: 'output', output: request.input };
    throwIfAborted(signal);
    yield { type: 'completed' };
  }
}

export class DelayedAgent extends MockAgent {
  async *execute(request: AgentExecutionRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.assertUsable();
    const config = DelayedConfigSchema.parse(request.config);
    yield { type: 'started' };

    for (const message of config.messages) {
      await delay(config.delayMs, signal);
      yield { type: 'message', message };
    }

    await delay(config.delayMs, signal);
    yield { type: 'output', output: config.output ?? request.input };
    yield { type: 'completed' };
  }
}

export class FailingAgent extends MockAgent {
  async *execute(request: AgentExecutionRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.assertUsable();
    const config = FailingConfigSchema.parse(request.config);
    throwIfAborted(signal);
    yield { type: 'started' };
    throwIfAborted(signal);
    yield { type: 'failed', code: config.code, message: config.message };
  }
}

export class HangingAgent extends MockAgent {
  async *execute(_request: AgentExecutionRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.assertUsable();
    throwIfAborted(signal);
    yield { type: 'started' };
    await waitForAbort(signal);
    throw abortError();
  }
}

export class ScriptedAgent extends MockAgent {
  async *execute(_request: AgentExecutionRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.assertUsable();
    const config = ScriptedConfigSchema.parse(_request.config);
    for (const event of config.events) {
      throwIfAborted(signal);
      yield event;
    }
  }
}

export interface TestAgentFactoryOptions {
  additionalAgents?: ReadonlyMap<string, (request: CreateAgentRequest) => AgentInstance>;
}

export function createTestAgentFactory(options: TestAgentFactoryOptions = {}): AgentFactory {
  const builders = new Map<string, (request: CreateAgentRequest) => AgentInstance>([
    ['echo', () => new EchoAgent()],
    ['delayed', () => new DelayedAgent()],
    ['failing', () => new FailingAgent()],
    ['hanging', () => new HangingAgent()],
    ['scripted', () => new ScriptedAgent()],
    ...(options.additionalAgents ? [...options.additionalAgents.entries()] : []),
  ]);

  return {
    async create(request) {
      const builder = builders.get(request.agentType);
      if (!builder) {
        throw new Error(`unknown_agent_type:${request.agentType}`);
      }
      return builder(request);
    },
  };
}

export const mockAgentTypes = ['echo', 'delayed', 'failing', 'hanging', 'scripted'] as const;
export type MockAgentType = (typeof mockAgentTypes)[number];

export const testAgentConfigSchemas = {
  echo: EchoConfigSchema,
  delayed: DelayedConfigSchema,
  failing: FailingConfigSchema,
  hanging: EchoConfigSchema,
  scripted: ScriptedConfigSchema,
};

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

function abortError(): Error {
  return new Error('agent_aborted');
}

async function delay(durationMs: number, signal: AbortSignal): Promise<void> {
  if (durationMs === 0) {
    throwIfAborted(signal);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export function asJsonValue(value: unknown): JsonValue {
  return JsonValueSchema.parse(value);
}
