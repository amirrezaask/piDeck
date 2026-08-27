import path from 'node:path';

import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;
const webRoot = path.resolve(root, 'apps/web');
const webSrc = path.resolve(webRoot, 'src');
const isWorkspaceRun = path.resolve(process.cwd()) === root;

export default defineConfig(
  isWorkspaceRun
    ? {
        root,
        test: {
          projects: [
            {
              test: {
                name: 'node',
                include: [
                  'apps/{client,server}/src/**/*.test.ts',
                  'packages/**/tests/**/*.test.ts',
                ],
                environment: 'node',
              },
            },
            {
              root: webRoot,
              resolve: {
                alias: {
                  '@': webSrc,
                  '@nextflow/contracts': path.resolve(root, 'packages/contracts/src/index.ts'),
                  'motion/react': path.resolve(root, 'vitest-motion-mock.mjs'),
                },
              },
              test: {
                name: 'web',
                include: ['src/**/*.test.{ts,tsx}'],
                environment: path.resolve(root, 'vitest-jsdom-environment.mjs'),
                setupFiles: [path.resolve(root, 'vitest-root-setup.mjs')],
              },
            },
          ],
        },
      }
    : { root: process.cwd() },
);
