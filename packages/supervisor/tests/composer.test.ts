import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { ComposerCatalog } from '../index';

describe('ComposerCatalog', () => {
  it('lists Pi slash commands using the typed prefix', async () => {
    const catalog = new ComposerCatalog({ defaultCwd: process.cwd() });

    const response = await catalog.list({ cwd: '.', kind: 'command', prefix: '/think' });

    expect(response.suggestions).toEqual([
      expect.objectContaining({
        value: 'thinking',
        label: '/thinking',
        kind: 'command',
      }),
    ]);
  });

  it('completes workspace files and directories for @ references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pideck-composer-'));
    try {
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'README.md'), '# piDeck');
      await writeFile(join(root, 'src', 'App.tsx'), 'export {}');

      const catalog = new ComposerCatalog({ defaultCwd: root });
      const rootSuggestions = await catalog.list({ cwd: '.', kind: 'file', prefix: '@' });
      const fileSuggestions = await catalog.list({
        cwd: '.',
        kind: 'file',
        prefix: '@src/',
      });

      expect(rootSuggestions.suggestions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: '@src/', kind: 'directory' }),
          expect.objectContaining({ value: '@README.md', kind: 'file' }),
        ]),
      );
      expect(fileSuggestions.suggestions).toEqual([
        expect.objectContaining({ value: '@src/App.tsx', kind: 'file' }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
