import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  type ChangeScope,
  type CreateInboxItemRequestSchema,
  type CreateTerminalSessionRequest,
  type CreateWorktreeRequest,
  decodeJson,
  encodeJson,
  type FleetOverviewResponse,
  FleetOverviewResponseSchema,
  type FleetRun,
  type InboxItemResponse,
  InboxItemResponseSchema,
  type RunChangesResponse,
  RunChangesResponseSchema,
  type SessionSearchResponse,
  SessionSearchResponseSchema,
  type TerminalSessionResponse,
  TerminalSessionResponseSchema,
  type WorktreeResponse,
  WorktreeResponseSchema,
} from '@nextflow/contracts';
import { createId, nowIso, type SupervisorDatabase } from '@nextflow/database';
import { type Kysely, type Selectable, sql } from 'kysely';
import type { PiExtensionUI, PiExtensionUIRequest } from './pi-session.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 2_000_000;

type InboxInput = typeof CreateInboxItemRequestSchema._type;

export class WorkspaceCapabilityError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_state_transition' | 'validation_failed',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceCapabilityError';
  }
}

export class WorkspaceService {
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly processCompletions = new Map<string, Promise<void>>();
  private readonly pendingInboxResponses = new Map<
    string,
    (response: string | undefined) => void
  >();
  private closing = false;
  constructor(private readonly db: Kysely<SupervisorDatabase>) {}

  async start(): Promise<void> {
    await this.db
      .updateTable('supervisor_terminal_sessions')
      .set({
        status: 'failed',
        output: sql<string>`output || ${'\nTerminal interrupted by Supervisor restart.'}`,
        completed_at: nowIso(),
      })
      .where('status', '=', 'running')
      .execute();
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const resolveResponse of this.pendingInboxResponses.values()) resolveResponse(undefined);
    this.pendingInboxResponses.clear();
    for (const child of this.processes.values()) child.kill('SIGTERM');
    const completions = [...this.processCompletions.values()];
    if (completions.length > 0) {
      await Promise.race([
        Promise.allSettled(completions),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      for (const child of this.processes.values()) child.kill('SIGKILL');
      await Promise.allSettled([...this.processCompletions.values()]);
      await this.db
        .updateTable('supervisor_terminal_sessions')
        .set({ status: 'failed', completed_at: nowIso() })
        .where('status', '=', 'running')
        .execute();
    }
    this.processes.clear();
    this.processCompletions.clear();
  }

  async fleet(): Promise<FleetOverviewResponse> {
    const [runs, agents] = await Promise.all([
      this.db
        .selectFrom('supervisor_agent_runs')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(500)
        .execute(),
      this.db.selectFrom('supervisor_agents').select(['id', 'name']).execute(),
    ]);
    const names = new Map(agents.map((agent) => [agent.id, agent.name]));
    const nodes = new Map<string, FleetRun>(
      runs.map((run) => [
        run.id,
        {
          id: run.id,
          parentRunId: run.parent_run_id,
          agentId: run.agent_id,
          agentName: names.get(run.agent_id) ?? 'Agent',
          prompt: run.prompt,
          cwd: run.cwd,
          status: run.status as FleetRun['status'],
          executionMode: run.execution_mode as FleetRun['executionMode'],
          worktreeId: run.worktree_id,
          createdAt: run.created_at,
          startedAt: run.started_at,
          completedAt: run.completed_at,
          children: [],
        },
      ]),
    );
    const roots: FleetRun[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentRunId ? nodes.get(node.parentRunId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const priority = (status: string) =>
      status === 'failed'
        ? 0
        : status === 'running'
          ? 1
          : status === 'queued'
            ? 2
            : status === 'cancelled'
              ? 3
              : 4;
    roots.sort(
      (a, b) => priority(a.status) - priority(b.status) || b.createdAt.localeCompare(a.createdAt),
    );
    return FleetOverviewResponseSchema.parse({
      health: {
        status: this.closing ? 'degraded' : 'healthy',
        database: 'connected',
        runtime: this.closing ? 'stopping' : 'ready',
        checkedAt: nowIso(),
      },
      runs: roots,
      counts: {
        active: runs.filter((run) => run.status === 'running' || run.status === 'queued').length,
        attention: runs.filter((run) => run.status === 'failed').length,
        total: runs.length,
      },
      complete: runs.length < 500,
    });
  }

  async changes(
    runId: string,
    scope: ChangeScope,
    baseRef = 'HEAD~1',
  ): Promise<RunChangesResponse> {
    const run = await this.db
      .selectFrom('supervisor_agent_runs')
      .select(['id', 'cwd'])
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!run) throw new WorkspaceCapabilityError('not_found', 'Run not found');
    if (scope === 'last_turn')
      return RunChangesResponseSchema.parse({
        runId,
        scope,
        available: false,
        unavailableReason: 'The supervisor did not capture a turn boundary for this run.',
        baseRef: null,
        files: [],
        patch: '',
        truncated: false,
      });
    const cwd = await this.authorizeCwd(run.cwd);
    await this.git(cwd, ['rev-parse', '--show-toplevel']);
    const args =
      scope === 'staged'
        ? ['diff', '--cached']
        : scope === 'branch'
          ? ['diff', `${baseRef}...HEAD`]
          : ['diff'];
    let patch = await this.git(cwd, args);
    const truncated = Buffer.byteLength(patch) > MAX_GIT_OUTPUT;
    if (truncated) patch = Buffer.from(patch).subarray(0, MAX_GIT_OUTPUT).toString('utf8');
    const names = await this.git(cwd, [...args, '--name-status']);
    const files = names.trim()
      ? names
          .trim()
          .split('\n')
          .map((line) => {
            const [status = 'M', ...parts] = line.split('\t');
            return { path: parts.at(-1) ?? '', status, additions: null, deletions: null };
          })
          .filter((file) => file.path)
      : [];
    return RunChangesResponseSchema.parse({
      runId,
      scope,
      available: true,
      unavailableReason: null,
      baseRef: scope === 'branch' ? baseRef : null,
      files,
      patch,
      truncated,
    });
  }

  async createWorktree(input: CreateWorktreeRequest): Promise<WorktreeResponse> {
    const project = await this.db
      .selectFrom('supervisor_projects')
      .selectAll()
      .where('id', '=', input.projectId)
      .executeTakeFirst();
    if (!project) throw new WorkspaceCapabilityError('not_found', 'Project not found');
    const projectPath = await realpath(project.path);
    await this.git(projectPath, ['rev-parse', '--show-toplevel']);
    const id = createId();
    const managedRoot = resolve(dirname(projectPath), '.pideck-worktrees');
    await mkdir(managedRoot, { recursive: true });
    const path = resolve(managedRoot, id);
    this.assertWithin(managedRoot, path);
    const now = nowIso();
    await this.db
      .insertInto('supervisor_worktrees')
      .values({
        id,
        project_id: project.id,
        path,
        branch: input.branch,
        base_ref: input.baseRef,
        status: 'creating',
        error: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    try {
      await this.git(projectPath, ['worktree', 'add', '-b', input.branch, path, input.baseRef]);
      await this.db
        .updateTable('supervisor_worktrees')
        .set({ status: 'ready', updated_at: nowIso() })
        .where('id', '=', id)
        .execute();
    } catch (error) {
      await this.db
        .updateTable('supervisor_worktrees')
        .set({
          status: 'failed',
          error: error instanceof Error ? error.message : 'Worktree creation failed',
          updated_at: nowIso(),
        })
        .where('id', '=', id)
        .execute();
      throw error;
    }
    return this.requireWorktree(id);
  }

  async getWorktree(id: string): Promise<WorktreeResponse> {
    return this.requireWorktree(id);
  }

  async listWorktrees(): Promise<WorktreeResponse[]> {
    const rows = await this.db
      .selectFrom('supervisor_worktrees')
      .selectAll()
      .where('status', '!=', 'deleted')
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((row) => this.toWorktree(row));
  }

  async releaseWorktree(id: string, force = false): Promise<WorktreeResponse> {
    const row = await this.db
      .selectFrom('supervisor_worktrees')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new WorkspaceCapabilityError('not_found', 'Worktree not found');
    if (!['ready', 'failed'].includes(row.status))
      throw new WorkspaceCapabilityError(
        'invalid_state_transition',
        'Worktree cannot be released in its current state',
      );
    const activeRun = await this.db
      .selectFrom('supervisor_agent_runs')
      .select('id')
      .where('worktree_id', '=', id)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    if (activeRun) {
      throw new WorkspaceCapabilityError(
        'invalid_state_transition',
        'Worktree cannot be released while a run is active',
      );
    }
    const project = await this.db
      .selectFrom('supervisor_projects')
      .selectAll()
      .where('id', '=', row.project_id)
      .executeTakeFirstOrThrow();
    const managedRoot = resolve(dirname(await realpath(project.path)), '.pideck-worktrees');
    this.assertWithin(managedRoot, row.path);
    const dirty = (await this.git(row.path, ['status', '--porcelain'])).trim().length > 0;
    if (dirty && !force) {
      throw new WorkspaceCapabilityError(
        'invalid_state_transition',
        'Worktree has uncommitted changes; confirm destructive cleanup to release it',
      );
    }
    await this.db
      .updateTable('supervisor_worktrees')
      .set({ status: 'releasing', updated_at: nowIso() })
      .where('id', '=', id)
      .execute();
    try {
      await this.git(project.path, [
        'worktree',
        'remove',
        ...(dirty && force ? ['--force'] : []),
        row.path,
      ]);
      await this.db
        .updateTable('supervisor_worktrees')
        .set({ status: 'deleted', updated_at: nowIso() })
        .where('id', '=', id)
        .execute();
    } catch (error) {
      await this.db
        .updateTable('supervisor_worktrees')
        .set({
          status: 'failed',
          error: error instanceof Error ? error.message : 'Worktree release failed',
          updated_at: nowIso(),
        })
        .where('id', '=', id)
        .execute();
      throw error;
    }
    return this.requireWorktree(id);
  }

  async createTerminal(input: CreateTerminalSessionRequest): Promise<TerminalSessionResponse> {
    const cwd = await this.authorizeCwd(input.cwd);
    const id = createId();
    const createdAt = nowIso();
    await this.db
      .insertInto('supervisor_terminal_sessions')
      .values({
        id,
        cwd,
        command: input.command,
        args_json: encodeJson(input.args),
        status: 'running',
        exit_code: null,
        output: '',
        truncated: 0,
        created_at: createdAt,
        completed_at: null,
      })
      .execute();
    const child = spawn(input.command, input.args, {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.processes.set(id, child);
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolvePromise) => {
      resolveCompletion = resolvePromise;
    });
    this.processCompletions.set(id, completion);
    let output = '';
    let bytes = 0;
    let limited = false;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void this.db
          .updateTable('supervisor_terminal_sessions')
          .set({ output, truncated: limited ? 1 : 0 })
          .where('id', '=', id)
          .where('status', '=', 'running')
          .execute();
      }, 100);
    };
    const append = (chunk: Buffer) => {
      if (limited) return;
      const remaining = input.maxOutputBytes - bytes;
      if (chunk.byteLength > remaining) limited = true;
      const accepted = chunk.subarray(0, Math.max(0, remaining));
      bytes += accepted.byteLength;
      output += accepted.toString('utf8');
      scheduleFlush();
      if (limited) child.kill('SIGTERM');
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => child.kill('SIGTERM'), input.timeoutMs);
    child.once('error', (error) => {
      output += `\n${error.message}`;
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (flushTimer) clearTimeout(flushTimer);
      this.processes.delete(id);
      const timedOut = signal === 'SIGTERM' && !limited && !this.closing;
      const status = this.closing
        ? 'cancelled'
        : limited
          ? 'output_limited'
          : timedOut
            ? 'timed_out'
            : code === 0
              ? 'completed'
              : 'failed';
      void this.db
        .updateTable('supervisor_terminal_sessions')
        .set({
          status,
          exit_code: code,
          output,
          truncated: limited ? 1 : 0,
          completed_at: nowIso(),
        })
        .where('id', '=', id)
        .where('status', '=', 'running')
        .execute()
        .finally(() => {
          this.processCompletions.delete(id);
          resolveCompletion();
        });
    });
    return this.requireTerminal(id);
  }

  async listTerminals(): Promise<TerminalSessionResponse[]> {
    const rows = await this.db
      .selectFrom('supervisor_terminal_sessions')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    return rows.map((row) => this.toTerminal(row));
  }

  async getTerminal(id: string): Promise<TerminalSessionResponse> {
    return this.requireTerminal(id);
  }
  async writeTerminal(id: string, data: string): Promise<TerminalSessionResponse> {
    const child = this.processes.get(id);
    if (!child)
      throw new WorkspaceCapabilityError(
        'invalid_state_transition',
        'Terminal session is not running',
      );
    child.stdin.write(data);
    return this.requireTerminal(id);
  }
  async cancelTerminal(id: string): Promise<TerminalSessionResponse> {
    const child = this.processes.get(id);
    if (child) child.kill('SIGTERM');
    await this.db
      .updateTable('supervisor_terminal_sessions')
      .set({ status: 'cancelled', completed_at: nowIso() })
      .where('id', '=', id)
      .where('status', '=', 'running')
      .execute();
    return this.requireTerminal(id);
  }

  extensionUI(runId: string): PiExtensionUI {
    return {
      request: (input) => this.requestExtensionInput(runId, input),
      notify: () => undefined,
    };
  }

  async cancelExtensionRequests(runId: string): Promise<void> {
    const pending = await this.db
      .selectFrom('supervisor_inbox_items')
      .select('id')
      .where('run_id', '=', runId)
      .where('status', '=', 'pending')
      .execute();
    if (pending.length === 0) return;
    await this.db
      .updateTable('supervisor_inbox_items')
      .set({ status: 'cancelled', resolved_at: nowIso() })
      .where(
        'id',
        'in',
        pending.map((item) => item.id),
      )
      .execute();
    for (const item of pending) this.settleInboxResponse(item.id, undefined);
  }

  private async requestExtensionInput(
    runId: string,
    input: PiExtensionUIRequest,
  ): Promise<string | undefined> {
    const item = await this.createInbox({
      kind: input.kind,
      runId,
      title: input.title,
      body: input.body,
      options: input.options,
    });
    return new Promise<string | undefined>((resolveResponse) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (response: string | undefined) => {
        if (timer) clearTimeout(timer);
        this.pendingInboxResponses.delete(item.id);
        resolveResponse(response);
      };
      this.pendingInboxResponses.set(item.id, settle);
      if (input.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          void this.cancelInbox(item.id).catch(() => settle(undefined));
        }, input.timeoutMs);
      }
      void this.requireInbox(item.id).then((current) => {
        if (current.status !== 'pending') settle(current.response ?? undefined);
      });
    });
  }

  private settleInboxResponse(id: string, response: string | undefined): void {
    this.pendingInboxResponses.get(id)?.(response);
  }

  async createInbox(input: InboxInput): Promise<InboxItemResponse> {
    const id = createId();
    const createdAt = nowIso();
    await this.db
      .insertInto('supervisor_inbox_items')
      .values({
        id,
        kind: input.kind,
        run_id: input.runId ?? null,
        title: input.title,
        body: input.body,
        options_json: encodeJson(input.options),
        status: 'pending',
        response: null,
        created_at: createdAt,
        resolved_at: null,
      })
      .execute();
    return this.requireInbox(id);
  }
  async listInbox(): Promise<InboxItemResponse[]> {
    const rows = await this.db
      .selectFrom('supervisor_inbox_items')
      .selectAll()
      .orderBy('status', 'asc')
      .orderBy('created_at', 'desc')
      .limit(200)
      .execute();
    return rows.map((row) => this.toInbox(row));
  }
  async resolveInbox(id: string, response: string): Promise<InboxItemResponse> {
    const result = await this.db
      .updateTable('supervisor_inbox_items')
      .set({ status: 'resolved', response, resolved_at: nowIso() })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1)
      throw new WorkspaceCapabilityError(
        'invalid_state_transition',
        'Inbox item is no longer pending',
      );
    const item = await this.requireInbox(id);
    this.settleInboxResponse(id, response);
    return item;
  }
  async cancelInbox(id: string): Promise<InboxItemResponse> {
    const result = await this.db
      .updateTable('supervisor_inbox_items')
      .set({ status: 'cancelled', resolved_at: nowIso() })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1)
      throw new WorkspaceCapabilityError(
        'invalid_state_transition',
        'Inbox item is no longer pending',
      );
    const item = await this.requireInbox(id);
    this.settleInboxResponse(id, undefined);
    return item;
  }

  async search(q: string, limit: number): Promise<SessionSearchResponse> {
    const escaped = q.replace(/[\\%_]/g, (value) => `\\${value}`);
    const rows = await this.db
      .selectFrom('supervisor_agent_runs')
      .select(['id', 'agent_id', 'prompt', 'cwd', 'status', 'created_at'])
      .where((eb) =>
        eb.or([eb('prompt', 'like', `%${escaped}%`), eb('cwd', 'like', `%${escaped}%`)]),
      )
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
    return SessionSearchResponseSchema.parse({
      results: rows.map((row) => ({
        runId: row.id,
        agentId: row.agent_id,
        title: row.prompt.split('\n', 1)[0]?.slice(0, 120) || 'Untitled session',
        cwd: row.cwd,
        status: row.status,
        createdAt: row.created_at,
      })),
    });
  }

  private async authorizeCwd(cwd: string): Promise<string> {
    const canonical = await realpath(cwd);
    const [projects, worktrees] = await Promise.all([
      this.db.selectFrom('supervisor_projects').select('path').execute(),
      this.db.selectFrom('supervisor_worktrees').select(['path', 'status']).execute(),
    ]);
    for (const candidate of [
      ...projects.map((row) => row.path),
      ...worktrees.filter((row) => row.status === 'ready').map((row) => row.path),
    ]) {
      let root: string;
      try {
        root = await realpath(candidate);
      } catch {
        continue;
      }
      if (
        canonical === root ||
        (!relative(root, canonical).startsWith('..') && !relative(root, canonical).startsWith('/'))
      )
        return canonical;
    }
    throw new WorkspaceCapabilityError(
      'validation_failed',
      'Working directory is outside a managed project or worktree',
    );
  }
  private assertWithin(root: string, path: string) {
    const rel = relative(resolve(root), resolve(path));
    if (!rel || rel.startsWith('..') || rel.startsWith('/'))
      throw new WorkspaceCapabilityError('validation_failed', 'Managed path escapes its root');
  }
  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: MAX_GIT_OUTPUT * 2,
      timeout: 30_000,
      encoding: 'utf8',
    });
    return stdout;
  }
  private async requireWorktree(id: string) {
    const row = await this.db
      .selectFrom('supervisor_worktrees')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new WorkspaceCapabilityError('not_found', 'Worktree not found');
    return this.toWorktree(row);
  }
  private toWorktree(row: Selectable<SupervisorDatabase['supervisor_worktrees']>) {
    return WorktreeResponseSchema.parse({
      id: row.id,
      projectId: row.project_id,
      path: row.path,
      branch: row.branch,
      baseRef: row.base_ref,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  private async requireTerminal(id: string) {
    const row = await this.db
      .selectFrom('supervisor_terminal_sessions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new WorkspaceCapabilityError('not_found', 'Terminal session not found');
    return this.toTerminal(row);
  }
  private toTerminal(row: Selectable<SupervisorDatabase['supervisor_terminal_sessions']>) {
    return TerminalSessionResponseSchema.parse({
      id: row.id,
      cwd: row.cwd,
      command: row.command,
      args: decodeJson(row.args_json),
      status: row.status,
      exitCode: row.exit_code,
      output: row.output,
      truncated: row.truncated === 1,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    });
  }
  private async requireInbox(id: string) {
    const row = await this.db
      .selectFrom('supervisor_inbox_items')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new WorkspaceCapabilityError('not_found', 'Inbox item not found');
    return this.toInbox(row);
  }
  private toInbox(row: Selectable<SupervisorDatabase['supervisor_inbox_items']>) {
    return InboxItemResponseSchema.parse({
      id: row.id,
      kind: row.kind,
      runId: row.run_id,
      title: row.title,
      body: row.body,
      options: decodeJson(row.options_json),
      status: row.status,
      response: row.response,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    });
  }
}
