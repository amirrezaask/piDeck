import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

const e2eBuild = process.env.SWITCHER_E2E === '1';

export default defineConfig({
  outDir: 'build',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'Switcher',
    description: 'A fast keyboard-first command palette for open Chrome tabs.',
    permissions: ['tabs', 'activeTab', 'scripting', 'storage'],
    ...(e2eBuild ? { host_permissions: ['http://*/*', 'https://*/*'] } : {}),
    action: { default_title: 'Open Switcher' },
    commands: {
      'toggle-switcher': {
        description: 'Open Switcher',
        suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
      },
    },
  },
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      // Runtime injection relies on activeTab, never persistent origins.
      if (!e2eBuild) delete manifest.host_permissions;
      delete manifest.content_scripts;
    },
  },
});
