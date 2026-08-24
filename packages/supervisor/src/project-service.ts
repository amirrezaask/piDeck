import { basename } from 'node:path';

import {
  type CreateManagedProjectRequest,
  CreateManagedProjectRequestSchema,
  type ManagedProjectListQuery,
  type ManagedProjectResponse,
  ManagedProjectResponseSchema,
} from '@nextflow/contracts';
import {
  createId,
  nowIso,
  type SupervisorDatabase,
  type SupervisorProjectsTable,
} from '@nextflow/database';
import type { Kysely, Selectable } from 'kysely';
import { assertWorkingDirectory, resolveWorkingDirectory } from './working-directory.js';

export interface ProjectServiceOptions {
  readonly db: Kysely<SupervisorDatabase>;
  readonly now?: () => string;
  readonly idFactory?: () => string;
}

type ProjectRow = Selectable<SupervisorProjectsTable>;

/** Persists the operator's reusable working directories independently of agents. */
export class ProjectService {
  private readonly db: Kysely<SupervisorDatabase>;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(options: ProjectServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? nowIso;
    this.idFactory = options.idFactory ?? createId;
  }

  async createProject(input: CreateManagedProjectRequest): Promise<ManagedProjectResponse> {
    const request = CreateManagedProjectRequestSchema.parse(input);
    const path = normalizePath(request.path);
    await assertWorkingDirectory(path);
    return this.upsertProject(path, request.name);
  }

  async touchPath(path: string): Promise<ManagedProjectResponse> {
    const normalizedPath = normalizePath(path);
    await assertWorkingDirectory(normalizedPath);
    return this.upsertProject(normalizedPath);
  }

  async deleteProject(projectId: string): Promise<ManagedProjectResponse | null> {
    const existing = await this.db
      .selectFrom('supervisor_projects')
      .selectAll()
      .where('id', '=', projectId)
      .executeTakeFirst();
    if (!existing) return null;

    await this.db.deleteFrom('supervisor_projects').where('id', '=', projectId).execute();
    return this.toResponse(existing);
  }

  async listProjects(options: ManagedProjectListQuery): Promise<{
    projects: ManagedProjectResponse[];
    nextCursor: string | null;
  }> {
    await this.importLegacyPaths();

    let query = this.db.selectFrom('supervisor_projects').selectAll();
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      if (cursor) {
        query = query.where((expression) =>
          expression.or([
            expression('last_used_at', '<', cursor.lastUsedAt),
            expression.and([
              expression('last_used_at', '=', cursor.lastUsedAt),
              expression('id', '<', cursor.id),
            ]),
          ]),
        );
      }
    }

    const rows = await query
      .orderBy('last_used_at', 'desc')
      .orderBy('id', 'desc')
      .limit(options.limit + 1)
      .execute();
    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;

    return {
      projects: page.map((row) => this.toResponse(row)),
      nextCursor: hasMore
        ? encodeCursor(page.at(-1)?.last_used_at ?? '', page.at(-1)?.id ?? '')
        : null,
    };
  }

  private async upsertProject(
    path: string,
    requestedName?: string,
  ): Promise<ManagedProjectResponse> {
    const existing = await this.db
      .selectFrom('supervisor_projects')
      .selectAll()
      .where('path', '=', path)
      .executeTakeFirst();
    const now = this.now();

    if (existing) {
      await this.db
        .updateTable('supervisor_projects')
        .set({
          ...(requestedName ? { name: requestedName } : {}),
          updated_at: now,
          last_used_at: now,
        })
        .where('id', '=', existing.id)
        .execute();
      return this.requireProject(existing.id);
    }

    const id = this.idFactory();
    await this.db
      .insertInto('supervisor_projects')
      .values({
        id,
        name: requestedName ?? projectName(path),
        path,
        created_at: now,
        updated_at: now,
        last_used_at: now,
      })
      .execute();
    return this.requireProject(id);
  }

  /** Keep projects created before this table existed visible after upgrading. */
  private async importLegacyPaths(): Promise<void> {
    const [agents, runs] = await Promise.all([
      this.db.selectFrom('supervisor_agents').select('cwd').execute(),
      this.db.selectFrom('supervisor_agent_runs').select('cwd').execute(),
    ]);
    const paths = new Set([...agents, ...runs].map((row) => normalizePath(row.cwd)));
    for (const path of paths) {
      const existing = await this.db
        .selectFrom('supervisor_projects')
        .select('id')
        .where('path', '=', path)
        .executeTakeFirst();
      if (existing) continue;

      const now = this.now();
      await this.db
        .insertInto('supervisor_projects')
        .values({
          id: this.idFactory(),
          name: projectName(path),
          path,
          created_at: now,
          updated_at: now,
          last_used_at: now,
        })
        .execute();
    }
  }

  private async requireProject(id: string): Promise<ManagedProjectResponse> {
    const row = await this.db
      .selectFrom('supervisor_projects')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new Error('project_insert_missing');
    return this.toResponse(row);
  }

  private toResponse(row: ProjectRow): ManagedProjectResponse {
    return ManagedProjectResponseSchema.parse({
      id: row.id,
      name: row.name,
      path: row.path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
    });
  }
}

function normalizePath(path: string): string {
  return resolveWorkingDirectory(path);
}

function projectName(path: string): string {
  return basename(path) || path;
}

function encodeCursor(lastUsedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ lastUsedAt, id }), 'utf8').toString('base64url');
}

function decodeCursor(value: string): { lastUsedAt: string; id: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { lastUsedAt?: unknown }).lastUsedAt !== 'string' ||
      typeof (parsed as { id?: unknown }).id !== 'string'
    ) {
      return undefined;
    }
    return parsed as { lastUsedAt: string; id: string };
  } catch {
    return undefined;
  }
}
