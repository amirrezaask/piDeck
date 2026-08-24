import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentFactory, AgentInstance } from '@nextflow/agent-runtime';
import {
  createMigrationDatabase,
  createSupervisorDatabase,
  migrateToLatest,
  type NextflowDatabase,
  type SupervisorDatabase,
} from '@nextflow/database';
import { createTestAgentFactory } from '@nextflow/test-agents';
import { describe, expect, it } from 'vitest';

import { ExecutionNotCancellableError, SupervisorService } from '../src/service';

async function createService(agentFactory = createTestAgentFactory()): Promise<{
  service: SupervisorService;
  close: () => Promise<void>;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'nextflow-supervisor-'));
  const filename = join(directory, 'test.sqlite');
  const migrationConnection = createMigrationDatabase(filename);
  await migrateToLatest(migrationConnection.db);
  await migrationConnection.close();
  const connection: NextflowDatabase<SupervisorDatabase> = createSupervisorDatabase(filename);
  const service = new SupervisorService({ db: connection.db, agentFactory });
  await service.start();
  return {
    service,
    async close() {
      await service.close();
      await connection.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function waitForTerminal(
  service: SupervisorService,
  executionId: string,
): Promise<NonNullable<Awaited<ReturnType<SupervisorService['getExecution']>>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const execution = await service.getExecution(executionId);
    if (execution && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(execution.status)) {
      return execution;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('execution did not become terminal');
}

describe('SupervisorService', () => {
  it('executes an agent, persists ordered events, and is idempotent', async () => {
    const { service, close } = await createService();
    try {
      const input = {
        idempotencyKey: 'run-1:step-1:1',
        agentType: 'echo',
        input: { value: 'hello' },
        config: {},
        timeoutMs: 1000,
      } as const;
      const first = await service.createExecution(input);
      const duplicate = await service.createExecution(input);
      const execution = await waitForTerminal(service, first.execution.id);
      const events = await service.listEvents(first.execution.id, { afterSequence: 0 });

      expect(first.created).toBe(true);
      expect(duplicate.created).toBe(false);
      expect(duplicate.execution.id).toBe(first.execution.id);
      expect(execution.status).toBe('succeeded');
      expect(execution.output).toEqual({ value: 'hello' });
      expect(events.map((event) => [event.sequence, event.type])).toEqual([
        [1, 'started'],
        [2, 'output'],
        [3, 'completed'],
      ]);
      const replayed: number[] = [];
      const unsubscribe = await service.streamExecution(first.execution.id, 1, (event) => {
        replayed.push(event.sequence);
      });
      unsubscribe();
      expect(replayed).toEqual([2, 3]);
    } finally {
      await close();
    }
  });

  it('cancels a hanging agent and emits a terminal persisted event', async () => {
    const { service, close } = await createService();
    try {
      const created = await service.createExecution({
        idempotencyKey: 'run-2:step-1:1',
        agentType: 'hanging',
        input: null,
        config: {},
        timeoutMs: 10_000,
      });
      await waitForRunning(service, created.execution.id);
      const cancelled = await service.cancelExecution(created.execution.id);
      const events = await service.listEvents(created.execution.id, { afterSequence: 0 });

      expect(cancelled.status).toBe('cancelled');
      expect(events.at(-1)?.payload).toEqual({
        code: 'execution_cancelled',
        message: 'Execution was cancelled',
      });
      await expect(service.cancelExecution(created.execution.id)).rejects.toBeInstanceOf(
        ExecutionNotCancellableError,
      );
    } finally {
      await close();
    }
  });

  it('marks a hanging agent timed out', async () => {
    const { service, close } = await createService();
    try {
      const created = await service.createExecution({
        idempotencyKey: 'run-3:step-1:1',
        agentType: 'hanging',
        input: null,
        config: {},
        timeoutMs: 10,
      });
      const execution = await waitForTerminal(service, created.execution.id);

      expect(execution.status).toBe('timed_out');
      expect(execution.error?.code).toBe('execution_timed_out');
    } finally {
      await close();
    }
  });

  it('disposes a custom agent after a terminal event', async () => {
    let disposeCount = 0;
    const agentFactory: AgentFactory = {
      async create() {
        const agent: AgentInstance = {
          id: 'custom-agent',
          async *execute() {
            yield { type: 'started' };
            yield { type: 'completed' };
          },
          async dispose() {
            disposeCount += 1;
          },
        };
        return agent;
      },
    };
    const { service, close } = await createService(agentFactory);
    try {
      const created = await service.createExecution({
        idempotencyKey: 'run-4:step-1:1',
        agentType: 'custom',
        input: {},
        config: {},
        timeoutMs: 1000,
      });
      expect((await waitForTerminal(service, created.execution.id)).status).toBe('succeeded');
      expect(disposeCount).toBe(1);
    } finally {
      await close();
    }
  });

  it('recovers non-terminal rows as sanitized failures on startup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nextflow-supervisor-recovery-'));
    const filename = join(directory, 'test.sqlite');
    const migrationConnection = createMigrationDatabase(filename);
    await migrateToLatest(migrationConnection.db);
    await migrationConnection.close();
    const connection = createSupervisorDatabase(filename);
    await connection.db
      .insertInto('supervisor_executions')
      .values({
        id: '018bcfe4-7a4b-7000-8000-000000000010',
        idempotency_key: 'recovery-key',
        agent_type: 'echo',
        request_json: '{"input":null,"config":{}}',
        status: 'running',
        timeout_ms: 1000,
        output_json: null,
        error_code: null,
        error_message: null,
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        finished_at: null,
      })
      .execute();

    const service = new SupervisorService({
      db: connection.db,
      agentFactory: createTestAgentFactory(),
    });
    try {
      await service.start();
      const execution = await service.getExecution('018bcfe4-7a4b-7000-8000-000000000010');
      expect(execution?.status).toBe('failed');
      expect(execution?.error?.code).toBe('supervisor_restarted');
    } finally {
      await service.close();
      await connection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function waitForRunning(service: SupervisorService, executionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const execution = await service.getExecution(executionId);
    if (execution?.status === 'running') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('execution did not start');
}
