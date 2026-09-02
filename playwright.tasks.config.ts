import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/tasks/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'rm -rf .e2e/tasks && cargo run --manifest-path apps/server/Cargo.toml -- serve --host 127.0.0.1 --port 3101 --data-dir .e2e/tasks',
      url: 'http://127.0.0.1:3101/tasks/health',
      reuseExistingServer: false,
    },
    {
      command: 'VITE_API_URL=http://127.0.0.1:3101 pnpm --filter @dispatch/client exec vite --port 5175 --host 127.0.0.1',
      url: 'http://127.0.0.1:5175',
      reuseExistingServer: false,
    },
  ],
});
