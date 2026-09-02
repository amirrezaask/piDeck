import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom', 'motion', 'framer-motion'],
    alias: {
      motion: path.resolve(import.meta.dirname, '../../node_modules/motion'),
      react: path.resolve(import.meta.dirname, '../../node_modules/react'),
      'react-dom': path.resolve(import.meta.dirname, '../../node_modules/react-dom'),
      '@': path.resolve(import.meta.dirname, './src'),
      '@nextflow/contracts': path.resolve(
        import.meta.dirname,
        '../../packages/contracts/src/index.ts',
      ),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/App.tsx', 'src/components/operations.tsx', 'src/lib/**/*.ts'],
      thresholds: {
        statements: 50,
        branches: 45,
        functions: 45,
        lines: 50,
      },
    },
  },
});
