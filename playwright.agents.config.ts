import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command:
        'rm -rf .tmp/agents-e2e && mkdir -p .tmp/agents-e2e && PI_EXECUTABLE="$PWD/tests/fixtures/fake-pi-rpc.mjs" cargo run --quiet --manifest-path apps/server/Cargo.toml -- serve --port 4774 --data-dir .tmp/agents-e2e --allowed-roots "$PWD"',
      url: 'http://127.0.0.1:4774/agents/v1/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command:
        'YAADE_PORT=4774 pnpm --filter @pideck/client-web build && YAADE_PORT=4774 pnpm --filter @pideck/client-web preview --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
