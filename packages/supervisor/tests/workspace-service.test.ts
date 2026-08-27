import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createId,
  createMigrationDatabase,
  createSupervisorDatabase,
  migrateToLatest,
  nowIso,
} from '@nextflow/database';
import { describe, expect, it } from 'vitest';
import { ProjectService } from '../project-service';
import { WorkspaceService } from '../workspace-service';

async function context() {
  const directory = mkdtempSync(join(tmpdir(), 'pideck-workspace-'));
  const filename = join(directory, 'db.sqlite');
  const migration = createMigrationDatabase(filename);
  await migrateToLatest(migration.db);
  await migration.close();
  const connection = createSupervisorDatabase(filename);
  const projects = new ProjectService({ db: connection.db });
  const workspace = join(directory, 'repo');
  mkdirSync(workspace);
  execFileSync('git', ['init'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workspace });
  writeFileSync(join(workspace, 'README.md'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: workspace });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: workspace });
  const project = await projects.createProject({ path: workspace, name: 'Repo' });
  return {
    directory,
    connection,
    workspace,
    project,
    service: new WorkspaceService(connection.db),
    async close() {
      await connection.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function insertRun(value: Awaited<ReturnType<typeof context>>) {
  const now = nowIso();
  const agentId = createId();
  const runId = createId();
  await value.connection.db
    .insertInto('supervisor_agents')
    .values({
      id: agentId,
      name: 'Agent',
      system_prompt: 'Test',
      cwd: value.workspace,
      tools_json: null,
      requested_model_provider: null,
      requested_model_id: null,
      thinking_level: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
    .execute();
  await value.connection.db
    .insertInto('supervisor_agent_runs')
    .values({
      id: runId,
      agent_id: agentId,
      prompt: 'Review README',
      model_provider: null,
      model_id: null,
      thinking_level: null,
      cwd: value.workspace,
      execution_mode: 'local',
      worktree_id: null,
      parent_run_id: null,
      status: 'completed',
      error_code: null,
      error_message: null,
      created_at: now,
      started_at: now,
      completed_at: now,
    })
    .execute();
  return runId;
}

describe('WorkspaceService', () => {
  it('returns nested attention-ordered fleet state and bounded search', async () => {
    const value = await context();
    try {
      const runId = await insertRun(value);
      const fleet = await value.service.fleet();
      expect(fleet.counts.total).toBe(1);
      expect(fleet.runs[0]?.id).toBe(runId);
      const search = await value.service.search('README', 10);
      expect(search.results[0]?.runId).toBe(runId);
    } finally {
      await value.close();
    }
  });
  it('reads truthful git scopes and reports unavailable last-turn state', async () => {
    const value = await context();
    try {
      const runId = await insertRun(value);
      writeFileSync(join(value.workspace, 'README.md'), 'changed\n');
      const changes = await value.service.changes(runId, 'working_tree');
      expect(changes.available).toBe(true);
      expect(changes.files[0]?.path).toBe('README.md');
      expect((await value.service.changes(runId, 'last_turn')).available).toBe(false);
    } finally {
      await value.close();
    }
  });
  it('creates and safely releases a recorded git worktree', async () => {
    const value = await context();
    try {
      const worktree = await value.service.createWorktree({
        projectId: value.project.id,
        branch: 'pideck/test',
        baseRef: 'HEAD',
      });
      expect(worktree.status).toBe('ready');
      expect((await value.service.releaseWorktree(worktree.id)).status).toBe('deleted');
    } finally {
      await value.close();
    }
  });
  it('refuses dirty or active worktrees unless cleanup is explicitly confirmed', async () => {
    const value = await context();
    try {
      const worktree = await value.service.createWorktree({
        projectId: value.project.id,
        branch: 'pideck/safe-release',
        baseRef: 'HEAD',
      });
      writeFileSync(join(worktree.path, 'README.md'), 'uncommitted\n');
      await expect(value.service.releaseWorktree(worktree.id)).rejects.toThrow(
        'uncommitted changes',
      );

      const runId = await insertRun(value);
      await value.connection.db
        .updateTable('supervisor_agent_runs')
        .set({ status: 'running', completed_at: null, worktree_id: worktree.id })
        .where('id', '=', runId)
        .execute();
      await expect(value.service.releaseWorktree(worktree.id, true)).rejects.toThrow(
        'run is active',
      );
      await value.connection.db
        .updateTable('supervisor_agent_runs')
        .set({ status: 'cancelled', completed_at: nowIso() })
        .where('id', '=', runId)
        .execute();
      expect((await value.service.releaseWorktree(worktree.id, true)).status).toBe('deleted');
    } finally {
      await value.close();
    }
  });

  it('recovers terminal rows interrupted by a Supervisor restart', async () => {
    const value = await context();
    try {
      const id = createId();
      await value.connection.db
        .insertInto('supervisor_terminal_sessions')
        .values({
          id,
          cwd: value.workspace,
          command: 'node',
          args_json: '[]',
          status: 'running',
          exit_code: null,
          output: 'partial',
          truncated: 0,
          created_at: nowIso(),
          completed_at: null,
        })
        .execute();
      await value.service.start();
      expect(await value.service.getTerminal(id)).toMatchObject({
        status: 'failed',
        output: expect.stringContaining('Supervisor restart'),
      });
    } finally {
      await value.close();
    }
  });

  it('runs bounded argv terminal processes and resolves inbox items once', async () => {
    const value = await context();
    try {
      const terminal = await value.service.createTerminal({
        cwd: value.workspace,
        command: process.execPath,
        args: ['-e', 'process.stdout.write("ok")'],
        timeoutMs: 5000,
        maxOutputBytes: 4096,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const complete = await value.service.getTerminal(terminal.id);
      expect(complete.output).toBe('ok');
      expect(complete.status).toBe('completed');
      const item = await value.service.createInbox({
        kind: 'approval',
        title: 'Apply change?',
        body: 'Review',
        options: ['Approve', 'Reject'],
      });
      expect((await value.service.resolveInbox(item.id, 'Approve')).status).toBe('resolved');
      await expect(value.service.resolveInbox(item.id, 'Reject')).rejects.toThrow(
        'no longer pending',
      );
    } finally {
      await value.close();
    }
  });
});
