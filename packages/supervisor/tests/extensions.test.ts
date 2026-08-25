import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { PiExtensionNotConfiguredError, PiExtensionService } from '../extensions';

describe('PiExtensionService', () => {
  it('lists package and local extension resources with update status', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pideck-extensions-'));
    const packageDirectory = join(directory, 'pi-tools');
    const localExtension = join(directory, 'local.ts');
    try {
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(
        join(packageDirectory, 'package.json'),
        JSON.stringify({
          name: '@example/pi-tools',
          version: '1.2.3',
          description: 'Project tools',
        }),
      );

      const update = vi.fn(async () => undefined);
      const service = new PiExtensionService({
        cwd: directory,
        now: () => '2026-08-23T20:00:00.000Z',
        packageManager: {
          resolve: async () => ({
            extensions: [
              {
                path: join(packageDirectory, 'index.ts'),
                enabled: true,
                metadata: {
                  source: 'npm:@example/pi-tools',
                  scope: 'user',
                  origin: 'package',
                  baseDir: packageDirectory,
                },
              },
              {
                path: localExtension,
                enabled: true,
                metadata: {
                  source: 'auto',
                  scope: 'user',
                  origin: 'top-level',
                  baseDir: directory,
                },
              },
            ],
            skills: [],
            prompts: [],
            themes: [],
          }),
          checkForAvailableUpdates: async () => [{ source: 'npm:@example/pi-tools' }],
          listConfiguredPackages: () => [{ source: 'npm:@example/pi-tools' }],
          update,
        },
      });

      const listed = await service.list();

      expect(listed).toMatchObject({
        cwd: directory,
        checkedAt: '2026-08-23T20:00:00.000Z',
        updateCheckError: null,
      });
      expect(listed.extensions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: '@example/pi-tools',
            packageName: '@example/pi-tools',
            version: '1.2.3',
            relativePath: 'index.ts',
            status: 'update_available',
          }),
          expect.objectContaining({ name: 'local', status: 'local', version: null }),
        ]),
      );

      const updated = await service.update('npm:@example/pi-tools');
      expect(update).toHaveBeenCalledWith('npm:@example/pi-tools');
      expect(updated.extensions[0]?.status).toBe('update_available');
      await expect(service.update('npm:missing')).rejects.toBeInstanceOf(
        PiExtensionNotConfiguredError,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not claim packages are current when update checks fail', async () => {
    const service = new PiExtensionService({
      cwd: '/workspace',
      packageManager: {
        resolve: async () => ({
          extensions: [
            {
              path: '/workspace/index.ts',
              enabled: true,
              metadata: {
                source: 'npm:pi-tools',
                scope: 'user',
                origin: 'package',
                baseDir: '/workspace',
              },
            },
          ],
          skills: [],
          prompts: [],
          themes: [],
        }),
        checkForAvailableUpdates: async () => {
          throw new Error('registry unavailable');
        },
        listConfiguredPackages: () => [{ source: 'npm:pi-tools' }],
        update: async () => undefined,
      },
    });

    const result = await service.list();

    expect(result.updateCheckError).toBe('registry unavailable');
    expect(result.extensions[0]?.status).toBe('unknown');
  });
});
