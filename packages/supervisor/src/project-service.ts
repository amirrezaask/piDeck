import { basename } from 'node:path';

import {
  type CreateManagedProjectRequest,
  CreateManagedProjectRequestSchema,
  type ManagedProjectListQuery,
  type ManagedProjectResponse,
  ManagedProjectResponseSchema,
  type UpdateManagedProjectRequest,
  UpdateManagedProjectRequestSchema,
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
export class ProjectPathConflictError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`A project is already saved for ${path}`);
    this.name = 'ProjectPathConflictError';
    this.path = path;
  }
}

export class ProjectService {
  private readonly db: Kysely<SupervisorDatabase>;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private legacyImport?: Promise<void>;

  constructor(options: ProjectServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? nowIso;
    this.idFactory = options.idFactory ?? createId;
  }

  async initialize(): Promise<void> {
    this.legacyImport ??= this.importLegacyPaths();
    await this.legacyImport;
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

  async updateProject(
    projectId: string,
    input: UpdateManagedProjectRequest,
  ): Promise<ManagedProjectResponse | null> {
    const request = UpdateManagedProjectRequestSchema.parse(input);
    const existing = await this.db
      .selectFrom('supervisor_projects')
      .selectAll()
      .where('id', '=', projectId)
      .executeTakeFirst();
    if (!existing) return null;

    const path = request.path === undefined ? existing.path : normalizePath(request.path);
    if (request.path !== undefined) await assertWorkingDirectory(path);

    const conflicting = await this.db
      .selectFrom('supervisor_projects')
      .select('id')
      .where('path', '=', path)
      .where('id', '!=', projectId)
      .executeTakeFirst();
    if (conflicting) throw new ProjectPathConflictError(path);

    await this.db
      .updateTable('supervisor_projects')
      .set({
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.path === undefined ? {} : { path }),
        updated_at: this.now(),
      })
      .where('id', '=', projectId)
      .execute();

    const updated = await this.db
      .selectFrom('supervisor_projects')
      .selectAll()
      .where('id', '=', projectId)
      .executeTakeFirst();
    if (!updated) throw new Error('project_update_missing');
    return this.toResponse(updated);
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
    const now = this.now();
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
      .onConflict((conflict) =>
        conflict.column('path').doUpdateSet({
          ...(requestedName ? { name: requestedName } : {}),
          updated_at: now,
          last_used_at: now,
        }),
      )
      .execute();

    const project = await this.db
      .selectFrom('supervisor_projects')
      .selectAll()
      .where('path', '=', path)
      .executeTakeFirst();
    if (!project) throw new Error('project_insert_missing');
    return this.toResponse(project);
  }

  /** Keep projects created before this table existed visible after upgrading. */
  private async importLegacyPaths(): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      const [agents, runs] = await Promise.all([
        transaction.selectFrom('supervisor_agents').select('cwd').execute(),
        transaction.selectFrom('supervisor_agent_runs').select('cwd').execute(),
      ]);
      const paths = new Set([...agents, ...runs].map((row) => normalizePath(row.cwd)));
      const now = this.now();
      for (const path of paths) {
        await transaction
          .insertInto('supervisor_projects')
          .values({
            id: this.idFactory(),
            name: projectName(path),
            path,
            created_at: now,
            updated_at: now,
            last_used_at: now,
          })
          .onConflict((conflict) => conflict.column('path').doNothing())
          .execute();
      }
    });
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
