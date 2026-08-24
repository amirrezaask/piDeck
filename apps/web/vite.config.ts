import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const supervisorUrl = env.VITE_SUPERVISOR_URL || 'http://127.0.0.1:4101';
  const supervisorToken = env.NEXTFLOW_SUPERVISOR_TOKEN || 'pideck-local-dev-token';

  return {
    envDir: path.resolve(import.meta.dirname, '../..'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
        '@nextflow/contracts': path.resolve(
          import.meta.dirname,
          '../../packages/contracts/src/index.ts',
        ),
      },
    },
    server: {
      proxy: {
        '/supervisor': {
          target: supervisorUrl,
          changeOrigin: true,
          headers: { Authorization: `Bearer ${supervisorToken}` },
          rewrite: (requestPath) => requestPath.replace(/^\/supervisor/, ''),
        },
      },
    },
  };
});
