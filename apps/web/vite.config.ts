import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const supervisorUrl = env.VITE_SUPERVISOR_URL || 'http://127.0.0.1:4101';
  const supervisorToken = env.NEXTFLOW_SUPERVISOR_TOKEN?.trim();
  const supervisorHeaders = supervisorToken ? { Authorization: `Bearer ${supervisorToken}` } : {};

  return {
    base: './',
    envDir: path.resolve(import.meta.dirname, '../..'),
    plugins: [react(), tailwindcss()],
    resolve: {
      dedupe: ['react', 'react-dom', 'motion', 'framer-motion'],
      alias: {
        motion: path.resolve(import.meta.dirname, './node_modules/motion'),
        react: path.resolve(import.meta.dirname, './node_modules/react'),
        'react-dom': path.resolve(import.meta.dirname, './node_modules/react-dom'),
        '@': path.resolve(import.meta.dirname, './src'),
        '@nextflow/contracts': path.resolve(
          import.meta.dirname,
          '../../packages/contracts/src/index.ts',
        ),
      },
    },
    server: {
      proxy: {
        '/v1': {
          target: supervisorUrl,
          changeOrigin: true,
          ws: true,
          headers: supervisorHeaders,
        },
        '/supervisor': {
          target: supervisorUrl,
          changeOrigin: true,
          ws: true,
          headers: supervisorHeaders,
          rewrite: (requestPath) => requestPath.replace(/^\/supervisor/, ''),
        },
      },
    },
  };
});
