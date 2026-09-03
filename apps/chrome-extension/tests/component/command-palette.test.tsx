import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { PaletteClient } from '/src/app/palette-client';
import { CommandPalette } from '/src/components/command-palette/command-palette';
import type { RuntimeRequest } from '/src/protocol/messages';
import type { BootstrapSnapshot } from '/src/protocol/responses';
import { makeTabItem } from '/src/providers/open-tabs-provider';

const snapshot: BootstrapSnapshot = {
  tabs: [
    {
      id: 1,
      windowId: 1,
      index: 0,
      title: 'Dispatch',
      url: 'https://github.com/acme/dispatch',
      active: true,
      pinned: false,
      audible: true,
      muted: false,
      lastAccessed: Date.now(),
    },
    {
      id: 2,
      windowId: 2,
      index: 0,
      title: 'Grafana',
      url: 'https://grafana.example.com/d/team',
      active: false,
      pinned: false,
      audible: false,
      muted: false,
      lastAccessed: Date.now() - 1000,
    },
  ],
  currentTabId: 1,
  currentWindowId: 1,
  shortcut: 'Ctrl+Shift+K',
  theme: 'system',
  fallback: false,
  pageZoom: 1,
};

const makeClient = (overrides: Partial<PaletteClient> = {}) => {
  const sent: RuntimeRequest[] = [];
  const context = {
    tabs: snapshot.tabs,
    currentTabId: 1,
    currentWindowId: 1,
    shortcut: snapshot.shortcut,
    theme: snapshot.theme,
  };
  const items = snapshot.tabs.map((tab) => makeTabItem(tab, context));
  const client: PaletteClient = {
    bootstrap: async () => snapshot,
    refresh: async () => snapshot,
    loadItems: async () => items,
    send: async (request) => {
      sent.push(request);
      if (request.type === 'tab/set-pinned')
        return { ok: true, type: 'tab', data: { ...snapshot.tabs[1]!, pinned: request.pinned } };
      if (request.type === 'tab/set-muted')
        return { ok: true, type: 'tab', data: { ...snapshot.tabs[1]!, muted: request.muted } };
      return {
        ok: true,
        type: 'done',
        closePalette: request.type === 'tab/activate',
      };
    },
    ...overrides,
  };
  return { client, sent };
};

const renderPalette = (client: PaletteClient, onClose = vi.fn<() => void>()) => {
  const result = render(
    <CommandPalette
      open
      standalone={false}
      portalContainer={document.body}
      client={client}
      onClose={onClose}
    />,
  );
  return { ...result, onClose };
};

describe('CommandPalette', () => {
  it('renders tabs, focuses search, filters, and shows favicon fallback', async () => {
    const { client } = makeClient();
    renderPalette(client);
    const input = await screen.findByRole('combobox', { name: 'Search tabs' });
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    await userEvent.type(input, 'graf');
    expect(screen.getAllByText('G').length).toBeGreaterThan(0);
    expect(screen.queryByRole('option', { name: /Dispatch/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Grafana/ })).toBeInTheDocument();
  });

  it('navigates, activates, closes, pins, and mutes from the keyboard', async () => {
    const { client, sent } = makeClient();
    const { onClose } = renderPalette(client);
    const input = await screen.findByRole('combobox', { name: 'Search tabs' });
    await userEvent.type(input, 'graf');
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Grafana/ })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(sent).toContainEqual({ type: 'tab/activate', tabId: 2, windowId: 2 }),
    );
    expect(onClose).toHaveBeenCalled();

    await userEvent.keyboard('{Shift>}{Backspace}{/Shift}');
    await userEvent.keyboard('{Alt>}p{/Alt}');
    await userEvent.keyboard('{Alt>}m{/Alt}');
    expect(input).toBeInTheDocument();
  });

  it('handles selected-row shortcuts and mouse actions without activating the row', async () => {
    const { client, sent } = makeClient();
    renderPalette(client);
    await userEvent.type(await screen.findByRole('combobox', { name: 'Search tabs' }), 'graf');
    const grafana = screen.getByRole('option', { name: /Grafana/ });
    fireEvent.mouseMove(grafana);
    const close = within(grafana).getByRole('button', { name: 'Close tab' });
    await userEvent.click(close);
    await waitFor(() => expect(sent).toContainEqual({ type: 'tab/close', tabId: 2 }));
    expect(sent.some((request) => request.type === 'tab/activate')).toBe(false);
  });

  it('closes on Escape and displays empty, error, shortcut warning, and theme states', async () => {
    const noShortcut = { ...snapshot, shortcut: undefined, theme: 'dark' as const };
    const { client, sent } = makeClient({
      bootstrap: async () => noShortcut,
      refresh: async () => noShortcut,
      loadItems: async () => [],
    });
    const { onClose, container } = renderPalette(client);
    const input = await screen.findByRole('combobox', { name: 'Search tabs' });
    await userEvent.type(input, 'missing');
    await screen.findByText('No matching tabs.');
    expect(screen.getByText('Shortcut unassigned')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Customize Switcher keyboard shortcut' }),
    );
    expect(sent).toContainEqual({ type: 'keyboard-shortcut/configure' });
    expect(container.querySelector('.dark')).not.toBeNull();
    input.focus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();

    const failure = makeClient({
      bootstrap: async () => {
        throw new Error('That tab no longer exists.');
      },
    });
    renderPalette(failure.client);
    expect(await screen.findByRole('alert')).toHaveTextContent('That tab no longer exists.');
  });

  it('applies light theme and exposes reduced-motion-safe transitions', async () => {
    const light = { ...snapshot, theme: 'light' as const };
    const { client } = makeClient({ bootstrap: async () => light, refresh: async () => light });
    const { container } = renderPalette(client);
    await userEvent.type(await screen.findByRole('combobox', { name: 'Search tabs' }), 'disp');
    await screen.findByRole('option', { name: /Dispatch/ });
    expect(container.querySelector('.light')).not.toBeNull();
    expect(screen.getByTestId('switcher-overlay')).toHaveAttribute('data-theme', 'light');
    expect(screen.getByTestId('switcher-overlay')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('switcher-overlay')).toHaveStyle({
      width: `${window.innerWidth}px`,
      transform: 'scale(1)',
    });
  });
});
