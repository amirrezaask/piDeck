import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 7_500 },
  workers: 1,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
