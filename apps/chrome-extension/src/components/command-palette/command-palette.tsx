import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircleIcon, XIcon } from 'lucide-react';

import type { PaletteClient } from '/src/app/palette-client';
import { Button } from '/src/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
} from '/src/components/ui/command';
import { Separator } from '/src/components/ui/separator';
import { TooltipProvider } from '/src/components/ui/tooltip';
import type { ThemePreference } from '/src/domain/theme';
import type { SwitcherItem, TabSwitcherItem } from '/src/domain/switcher-item';
import type { RuntimeRequest } from '/src/protocol/messages';
import type { BootstrapSnapshot, RuntimeResponse } from '/src/protocol/responses';
import { rankItems } from '/src/search/rank-items';

import { CommandFooter } from './command-footer';
import { PaletteErrorBoundary } from './error-boundary';
import { TabResult } from './tab-result';

interface CommandPaletteProps {
  readonly open: boolean;
  readonly standalone: boolean;
  readonly portalContainer: HTMLElement | null;
  readonly client: PaletteClient;
  readonly onClose: () => void;
}

export function CommandPalette({
  open,
  standalone,
  portalContainer,
  client,
  onClose,
}: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasLoadedRef = useRef(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<readonly SwitcherItem[]>([]);
  const [snapshot, setSnapshot] = useState<BootstrapSnapshot | undefined>();
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const focusInput = useCallback(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const ranked = useMemo(() => rankItems(items, query), [items, query]);
  const visibleItems = useMemo(() => ranked.map(({ item }) => item), [ranked]);
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];

  const applySnapshot = useCallback(
    async (next: BootstrapSnapshot) => {
      const loaded = await client.loadItems(next);
      setSnapshot(next);
      setItems(loaded);
      setSelectedId((current) =>
        loaded.some((item) => item.id === current) ? current : (loaded[0]?.id ?? ''),
      );
    },
    [client],
  );

  const bootstrap = useCallback(async () => {
    setLoading(!hasLoadedRef.current);
    setError(undefined);
    try {
      await applySnapshot(await client.bootstrap());
      hasLoadedRef.current = true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Switcher could not load browser tabs.');
    } finally {
      setLoading(false);
    }
  }, [applySnapshot, client]);

  const refresh = useCallback(async () => {
    try {
      await applySnapshot(await client.refresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Switcher could not refresh tabs.');
    }
  }, [applySnapshot, client]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    void bootstrap();
  }, [bootstrap, open]);

  useLayoutEffect(() => {
    if (!open) return;
    if (standalone) window.focus();
    focusInput();
    const frame = requestAnimationFrame(focusInput);
    const handleWindowFocus = () => focusInput();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') focusInput();
    };
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [focusInput, open, standalone]);

  useLayoutEffect(() => {
    if (!open || loading) return;
    focusInput();
    const frame = requestAnimationFrame(focusInput);
    return () => cancelAnimationFrame(frame);
  }, [focusInput, loading, open]);

  useEffect(() => {
    if (visibleItems.length === 0) setSelectedId('');
    else if (!visibleItems.some((item) => item.id === selectedId))
      setSelectedId(visibleItems[0]?.id ?? '');
  }, [selectedId, visibleItems]);

  const checkedSend = useCallback(
    async (request: RuntimeRequest): Promise<RuntimeResponse> => {
      const response = await client.send(request);
      if (!response.ok) throw new Error(response.message);
      return response;
    },
    [client],
  );

  const activate = useCallback(
    async (item: SwitcherItem) => {
      setError(undefined);
      try {
        if (item.tabId === snapshot?.currentTabId) {
          onClose();
          return;
        }
        await checkedSend({ type: 'tab/activate', tabId: item.tabId, windowId: item.windowId });
        onClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Chrome could not complete that action.');
        await refresh();
      }
    },
    [checkedSend, onClose, refresh, snapshot?.currentTabId],
  );

  const closeTab = useCallback(
    async (item: TabSwitcherItem) => {
      const currentIndex = visibleItems.findIndex((candidate) => candidate.id === item.id);
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      const next = visibleItems[currentIndex + 1] ?? visibleItems[currentIndex - 1];
      setSelectedId(next?.id ?? '');
      try {
        await checkedSend({ type: 'tab/close', tabId: item.tabId });
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Chrome could not close that tab.');
        await refresh();
      }
    },
    [checkedSend, refresh, visibleItems],
  );

  const updateTab = useCallback(
    async (item: TabSwitcherItem, field: 'pinned' | 'muted') => {
      const value = !item[field];
      setItems((current) =>
        current.map((candidate) =>
          candidate.id === item.id && candidate.kind === 'tab'
            ? { ...candidate, [field]: value }
            : candidate,
        ),
      );
      try {
        const request: RuntimeRequest =
          field === 'pinned'
            ? { type: 'tab/set-pinned', tabId: item.tabId, pinned: value }
            : { type: 'tab/set-muted', tabId: item.tabId, muted: value };
        const response = await checkedSend(request);
        if (response.ok && response.type === 'tab') {
          setItems((current) =>
            current.map((candidate) =>
              candidate.id === item.id && candidate.kind === 'tab'
                ? { ...candidate, pinned: response.data.pinned, muted: response.data.muted }
                : candidate,
            ),
          );
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Chrome could not update that tab.');
        await refresh();
      }
    },
    [checkedSend, refresh],
  );

  const configureShortcut = useCallback(async () => {
    setError(undefined);
    try {
      await checkedSend({ type: 'keyboard-shortcut/configure' });
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Chrome could not open keyboard shortcut settings.',
      );
    }
  }, [checkedSend, onClose]);

  const setTheme = useCallback(
    async (theme: ThemePreference) => {
      if (snapshot === undefined) return;
      setSnapshot({ ...snapshot, theme });
      try {
        await checkedSend({ type: 'theme/set', theme });
      } catch {
        setError('Switcher could not save the theme.');
      }
    },
    [checkedSend, snapshot],
  );

  const moveSelection = useCallback(
    (index: number) => {
      const item = visibleItems[Math.max(0, Math.min(visibleItems.length - 1, index))];
      if (item !== undefined) setSelectedId(item.id);
    },
    [visibleItems],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        inputRef.current?.focus();
        return;
      }
      const selectedIndex =
        selected === undefined ? -1 : visibleItems.findIndex((item) => item.id === selected.id);
      if (
        event.key === 'Home' ||
        event.key === 'End' ||
        event.key === 'PageUp' ||
        event.key === 'PageDown'
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Home') moveSelection(0);
        else if (event.key === 'End') moveSelection(visibleItems.length - 1);
        else moveSelection(selectedIndex + (event.key === 'PageDown' ? 8 : -8));
        return;
      }
      if (selected === undefined) return;
      if (event.shiftKey && event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        void closeTab(selected);
      } else if (event.altKey && event.key.toLocaleLowerCase() === 'p') {
        event.preventDefault();
        event.stopPropagation();
        void updateTab(selected, 'pinned');
      } else if (event.altKey && event.key.toLocaleLowerCase() === 'm') {
        event.preventDefault();
        event.stopPropagation();
        void updateTab(selected, 'muted');
      }
    },
    [closeTab, moveSelection, onClose, selected, updateTab, visibleItems],
  );

  const theme = snapshot?.theme ?? 'system';
  const resolvedDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const hasQuery = query.trim().length > 0;
  const pageZoom = standalone ? 1 : (snapshot?.pageZoom ?? 1);
  const compensatedWidth = window.innerWidth * pageZoom;
  const compensatedHeight = window.innerHeight * pageZoom;
  const compact = compensatedWidth <= 640;
  const rootPadding = compact
    ? '16px 8px'
    : `${Math.min(120, Math.max(40, compensatedHeight * 0.13))}px 24px 24px`;
  const rootStyle = standalone
    ? { padding: rootPadding }
    : {
        width: `${compensatedWidth}px`,
        height: `${compensatedHeight}px`,
        padding: rootPadding,
        transform: `scale(${1 / pageZoom})`,
        transformOrigin: 'top left',
      };

  if (!open) return null;

  return (
    <div
      className={`switcher-root ${resolvedDark ? 'dark' : 'light'}`}
      dir="ltr"
      data-theme={theme}
      data-host={standalone ? 'fallback' : 'overlay'}
      data-layout={compact ? 'compact' : 'default'}
      data-testid="switcher-overlay"
      style={rootStyle}
      onKeyDownCapture={handleKeyDown}
    >
      <button
        type="button"
        className="switcher-backdrop"
        aria-label="Dismiss Switcher"
        onClick={onClose}
      />
      <dialog open aria-modal="true" aria-label="Switcher" className="switcher-panel">
        <PaletteErrorBoundary>
          <TooltipProvider>
            <Command
              shouldFilter={false}
              value={selected?.id ?? ''}
              onValueChange={setSelectedId}
              loop
              label="Search tabs"
            >
              <div className="relative flex items-center">
                <CommandInput
                  ref={inputRef}
                  value={query}
                  onValueChange={setQuery}
                  aria-label="Search tabs"
                  placeholder="Search tabs…"
                  className="pr-8 text-sm"
                />
                <span className="absolute right-3 flex items-center gap-1.5">
                  {query.length > 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Clear search"
                      onClick={() => {
                        setQuery('');
                        inputRef.current?.focus();
                      }}
                    >
                      <XIcon />
                    </Button>
                  ) : null}
                </span>
              </div>
              <Separator />
              {snapshot?.fallback ? (
                <output className="mx-3 mt-2 rounded-xl bg-muted/55 px-4 py-2.5 text-sm text-muted-foreground">
                  Switcher opened in a separate window to stay centered.
                </output>
              ) : null}
              {error !== undefined ? (
                <div
                  role="alert"
                  className="mx-3 mt-2 rounded-xl bg-destructive/10 px-4 py-2.5 text-sm text-destructive"
                >
                  {error}
                </div>
              ) : null}
              <CommandList className="scroll-py-1">
                {loading ? (
                  <div className="flex min-h-28 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircleIcon className="animate-spin" /> Loading tabs…
                  </div>
                ) : null}
                {!loading && visibleItems.length === 0 ? (
                  <CommandEmpty>{hasQuery ? 'No matching tabs.' : 'No open tabs.'}</CommandEmpty>
                ) : null}
                {!loading && visibleItems.length > 0 ? (
                  <CommandGroup>
                    {visibleItems.map((item) => (
                      <TabResult
                        key={item.id}
                        item={item}
                        selected={selected?.id === item.id}
                        portalContainer={portalContainer}
                        onActivate={() => {
                          void activate(item);
                        }}
                        onClose={() => {
                          void closeTab(item);
                        }}
                        onPin={() => {
                          void updateTab(item, 'pinned');
                        }}
                        onMute={() => {
                          void updateTab(item, 'muted');
                        }}
                      />
                    ))}
                  </CommandGroup>
                ) : null}
              </CommandList>
              <Separator />
              <CommandFooter
                shortcut={snapshot?.shortcut}
                theme={theme}
                onConfigureShortcut={() => {
                  void configureShortcut();
                }}
                onTheme={(next) => {
                  void setTheme(next);
                }}
              />
            </Command>
          </TooltipProvider>
        </PaletteErrorBoundary>
      </dialog>
    </div>
  );
}
