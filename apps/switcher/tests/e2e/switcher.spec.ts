import { chromium, expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('build/chrome-mv3');
test('loads Switcher, uses one isolated overlay, manages tabs, and opens the restricted fallback', async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'switcher-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const invoker = await context.newPage();
    await invoker.goto(`chrome-extension://${extensionId}/switcher.html?test-invoker=1`);
    const first = await context.newPage();
    await first.goto('https://example.com/?switcher=dispatch');
    await first.evaluate(() => {
      document.title = 'Dispatch';
      document.documentElement.dir = 'rtl';
    });
    const second = await context.newPage();
    await second.goto('https://example.org/?switcher=grafana');
    await second.evaluate(() => {
      document.title = 'Grafana';
    });

    const invoke = async () => {
      await first.bringToFront();
      await invoker.evaluate(() => chrome.runtime.sendMessage({ type: 'test/invoke' }));
    };

    await invoke();
    const search = first.getByRole('combobox', { name: 'Search tabs and commands' });
    await expect(search).toBeVisible();
    await expect(first.locator('.switcher-root')).toHaveAttribute('dir', 'ltr');
    await first.screenshot({ path: '../../.impeccable/review/switcher-desktop.png' });
    await first.getByRole('button', { name: 'System theme. Switch theme' }).click();
    await first.getByRole('button', { name: 'Light theme. Switch theme' }).click();
    await expect(first.locator('.switcher-root')).toHaveClass(/dark/);
    await first.screenshot({ path: '../../.impeccable/review/switcher-dark.png' });
    await search.fill('graf');
    await expect(first.getByRole('option', { name: /grafana/i })).toBeVisible();
    await first.getByRole('option', { name: /grafana/i }).click();
    await expect.poll(() => second.evaluate(() => document.visibilityState)).toBe('visible');

    await invoke();
    await first.keyboard.press('Escape');
    await invoke();
    await first.keyboard.press('Escape');
    await invoke();
    await expect(first.getByTestId('switcher-overlay')).toHaveCount(1);

    const grafanaRow = first.getByRole('option', { name: /grafana/i });
    await search.fill('graf');
    await grafanaRow.hover();
    await grafanaRow.getByRole('button', { name: 'Pin tab' }).click();
    await expect(grafanaRow.getByRole('button', { name: 'Unpin tab' })).toBeVisible();
    await grafanaRow.getByRole('button', { name: 'Unpin tab' }).click();
    await grafanaRow.getByRole('button', { name: 'Mute tab' }).click();
    await expect(grafanaRow.getByRole('button', { name: 'Unmute tab' })).toBeVisible();
    await grafanaRow.getByRole('button', { name: 'Unmute tab' }).click();
    await grafanaRow.getByRole('button', { name: 'Close tab' }).click();
    await expect.poll(() => second.isClosed()).toBe(true);

    await first.keyboard.press('Escape');
    const chromePage = await context.newPage();
    await chromePage.goto('chrome://extensions');
    await chromePage.bringToFront();
    const fallbackPromise = context.waitForEvent('page', {
      predicate: (page) => page.url() === `chrome-extension://${extensionId}/switcher.html`,
    });
    await invoker.evaluate(() => chrome.runtime.sendMessage({ type: 'test/invoke' }));
    const fallback = await fallbackPromise;
    await expect(fallback.getByRole('dialog', { name: 'Switcher' })).toBeVisible();
    await expect(fallback.locator('.switcher-root')).toHaveClass(/dark/);
    await fallback.screenshot({ path: '../../.impeccable/review/switcher-fallback.png' });
    await fallback.getByRole('combobox', { name: 'Search tabs and commands' }).fill('dispatch');
    await Promise.race([
      fallback.waitForEvent('close'),
      fallback.getByRole('option', { name: /dispatch/i }).dispatchEvent('click'),
    ]);
    await expect.poll(() => fallback.isClosed()).toBe(true);
  } finally {
    await context.close();
  }
});
