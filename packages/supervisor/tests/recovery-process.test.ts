import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { createSupervisorDatabase } from '@nextflow/database';
import { describe, expect, it } from 'vitest';

import type { SupervisorLifecyclePhase } from '../src/agent-service';

const fixture = join(__dirname, 'fixtures/recovery-supervisor.mts');
const children = new Set<ChildProcess>();

function runFixture(
  mode: 'run' | 'inspect',
  databasePath: string,
  sessionDirectory: string,
  phase?: SupervisorLifecyclePhase,
): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fixture, mode, databasePath, sessionDirectory, ...(phase ? [phase] : [])],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: sessionDirectory },
    },
  );
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function nextJsonLine(
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolveLine, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`fixture_timeout: ${stderr}`));
    }, timeoutMs);
    const onStdout = (chunk: Buffer) => {
      stdout += String(chunk);
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      const line = stdout.slice(0, newline);
      cleanup();
      resolveLine(JSON.parse(line) as Record<string, unknown>);
    };
    const onStderr = (chunk: Buffer) => {
      stderr += String(chunk);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`fixture_exited_${String(code)}: ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
  });
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture_exit_timeout')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

const phases: SupervisorLifecyclePhase[] = [
  'before_run_insert',
  'after_queued_commit',
  'after_session_identity_commit',
  'after_prompt_preflight',
  'after_running_commit',
  'during_event_write',
  'after_provider_completion',
  'during_graceful_shutdown',
];

describe.sequential('supervisor process crash recovery', () => {
  for (const phase of phases) {
    it(`recovers without replay after SIGKILL at ${phase}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'pideck-supervisor-recovery-'));
      const databasePath = join(directory, 'recovery.sqlite');
      const sessionDirectory = join(directory, 'pi sessions');
      let crashed: ChildProcess | undefined;
      let inspector: ChildProcess | undefined;
      try {
        crashed = runFixture('run', databasePath, sessionDirectory, phase);
        const reached = await nextJsonLine(crashed);
        expect(reached.phase).toBe(phase);
        if (phase === 'during_event_write') expect(reached.runId).toEqual(expect.any(String));
        crashed.kill('SIGKILL');
        await waitForExit(crashed);

        const promptMarker = join(sessionDirectory, 'prompt-count.log');
        const promptsBeforeRestart = existsSync(promptMarker)
          ? readFileSync(promptMarker, 'utf8').trim().split('\n').filter(Boolean).length
          : 0;
        const promptStarted = ![
          'before_run_insert',
          'after_queued_commit',
          'after_session_identity_commit',
        ].includes(phase);
        expect(promptsBeforeRestart).toBe(promptStarted ? 1 : 0);

        inspector = runFixture('inspect', databasePath, sessionDirectory);
        const summary = await nextJsonLine(inspector);
        await waitForExit(inspector);
        const runs = summary.runs as Array<{
          id: string;
          status: string;
          error?: { code?: string };
          piSessionId?: string;
        }>;

        if (phase === 'before_run_insert') {
          expect(runs).toEqual([]);
        } else {
          expect(runs).toHaveLength(1);
          expect(runs[0]?.status).toBe('failed');
          expect(runs[0]?.error?.code).toBe(
            phase === 'after_queued_commit' ? 'supervisor_restarted' : 'run_interrupted',
          );
          const sequences =
            (summary.eventSequences as Record<string, number[]>)[runs[0]?.id ?? ''] ?? [];
          expect(
            sequences.every(
              (sequence, index) => index === 0 || sequence === sequences[index - 1]! + 1,
            ),
          ).toBe(true);
        }

        const promptsAfterRestart = existsSync(promptMarker)
          ? readFileSync(promptMarker, 'utf8').trim().split('\n').filter(Boolean).length
          : 0;
        expect(promptsAfterRestart).toBe(promptsBeforeRestart);

        const reopened = createSupervisorDatabase(databasePath);
        try {
          expect(reopened.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
          expect(reopened.sqlite.pragma('foreign_key_check')).toEqual([]);
          const owners = reopened.sqlite
            .prepare(
              'SELECT pi_session_id, COUNT(*) AS owners FROM supervisor_agent_runs WHERE pi_session_id IS NOT NULL GROUP BY pi_session_id',
            )
            .all() as Array<{ pi_session_id: string; owners: number }>;
          expect(owners.every((owner) => owner.owners === 1)).toBe(true);
        } finally {
          await reopened.close();
        }
      } finally {
        for (const child of [crashed, inspector]) {
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await waitForExit(child).catch(() => undefined);
          }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    }, 20_000);
  }
});
