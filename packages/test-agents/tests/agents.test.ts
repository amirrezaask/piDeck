import type { AgentExecutionRequest } from '@nextflow/agent-runtime';
import { describe, expect, it } from 'vitest';

import { createTestAgentFactory, EchoAgent, FailingAgent } from '../src';

const request: AgentExecutionRequest = {
  executionId: '018bcfe4-7a4b-7000-8000-000000000001',
  agentType: 'echo',
  input: { value: 'hello' },
  config: {},
};

describe('test agents', () => {
  it('executes EchoAgent through the shared interface', async () => {
    const agent = new EchoAgent();
    const events: unknown[] = [];

    for await (const event of agent.execute(request, new AbortController().signal)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'started' },
      { type: 'output', output: { value: 'hello' } },
      { type: 'completed' },
    ]);
    await agent.dispose();
  });

  it('creates registered agents without class-specific Supervisor logic', async () => {
    const factory = createTestAgentFactory();
    const agent = await factory.create({ ...request, agentType: 'failing' });

    expect(agent).toBeInstanceOf(FailingAgent);
    await agent.dispose();
  });
});
