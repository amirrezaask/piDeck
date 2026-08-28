import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createMigrationDatabase,
  createSupervisorDatabase,
  migrateToLatest,
} from '@nextflow/database';
import { describe, expect, it } from 'vitest';
import { ProjectService } from '../project-service';

async function createContext() {
  const directory = mkdtempSync(join(tmpdir(), 'pideck-project-service-'));
  const filename = join(directory, 'test.sqlite');
  const migration = createMigrationDatabase(filename);
  await migrateToLatest(migration.db);
  await migration.close();
  const connection = createSupervisorDatabase(filename);
  const service = new ProjectService({ db: connection.db });
  return {
    directory,
    connection,
    service,
    async close() {
      await connection.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('ProjectService', () => {
  it('uses one atomic path upsert and preserves an explicit name on touch', async () => {
    const context = await createContext();
    try {
      const path = join(context.directory, 'workspace');
      mkdirSync(path);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          context.service.createProject({ path, name: `Name ${index}` }),
        ),
      );
      const rows = await context.connection.db
        .selectFrom('supervisor_projects')
        .selectAll()
        .where('path', '=', path)
        .execute();
      expect(rows).toHaveLength(1);
      expect(new Set(results.map((result) => result.id)).size).toBe(1);

      const named = await context.service.createProject({ path, name: 'Chosen name' });
      const touched = await context.service.touchPath(path);
      expect(named.id).toBe(touched.id);
      expect(touched.name).toBe('Chosen name');
    } finally {
      await context.close();
    }
  });

  it('updates a saved project name and path', async () => {
    const context = await createContext();
    try {
      const path = join(context.directory, 'workspace');
      mkdirSync(path);
      const project = await context.service.createProject({ path, name: 'Workspace' });
      const renamedPath = join(context.directory, 'renamed-workspace');
      mkdirSync(renamedPath);

      const updated = await context.service.updateProject(project.id, {
        name: 'Renamed workspace',
        path: renamedPath,
      });

      expect(updated).toMatchObject({
        id: project.id,
        name: 'Renamed workspace',
        path: renamedPath,
      });
      await expect(
        context.service.updateProject('018bcfe4-7a4b-7000-8000-000000000999', {
          name: 'Missing',
        }),
      ).resolves.toBeNull();
    } finally {
      await context.close();
    }
  });

  it('imports legacy paths once and paginates equal timestamps without skipping', async () => {
    const context = await createContext();
    try {
      await context.connection.db
        .insertInto('supervisor_agents')
        .values({
          id: '018bcfe4-7a4b-7000-8000-000000000001',
          name: 'Agent',
          system_prompt: 'Prompt',
          system_prompt_mode: 'append',
          cwd: context.directory,
          tools_json: null,
          requested_model_provider: null,
          requested_model_id: null,
          thinking_level: null,
          created_at: '2026-08-23T20:00:00.000Z',
          updated_at: '2026-08-23T20:00:00.000Z',
          deleted_at: null,
        })
        .execute();
      await context.service.initialize();
      await context.service.initialize();
      const secondPath = join(context.directory, 'second');
      mkdirSync(secondPath);
      await context.service.createProject({ path: secondPath });
      const first = await context.service.listProjects({ limit: 1 });
      const second = await context.service.listProjects({
        limit: 1,
        cursor: first.nextCursor ?? '',
      });
      expect(first.projects).toHaveLength(1);
      expect(second.projects).toHaveLength(1);
      expect(new Set([first.projects[0]?.path, second.projects[0]?.path])).toEqual(
        new Set([context.directory, secondPath]),
      );
    } finally {
      await context.close();
    }
  });
});
