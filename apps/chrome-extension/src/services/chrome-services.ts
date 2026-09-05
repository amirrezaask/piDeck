import { Context, type Effect } from 'effect';

import type { ThemePreference } from '/src/domain/theme';
import type { RuntimeResponse } from '/src/protocol/responses';
import type { WorkbenchSurface } from '/src/runtime/workbench-navigation';
import type { SwitcherError } from './errors';

export interface InvocationContext {
  readonly tabId: number | undefined;
  readonly windowId: number | undefined;
}

export interface ChromeTabsShape {
  readonly snapshot: (
    context: InvocationContext,
    fallback: boolean,
  ) => Effect.Effect<RuntimeResponse, SwitcherError>;
  readonly activate: (
    tabId: number,
    windowId: number,
  ) => Effect.Effect<RuntimeResponse, SwitcherError>;
  readonly close: (tabId: number) => Effect.Effect<RuntimeResponse, SwitcherError>;
  readonly setPinned: (
    tabId: number,
    pinned: boolean,
  ) => Effect.Effect<RuntimeResponse, SwitcherError>;
  readonly setMuted: (
    tabId: number,
    muted: boolean,
  ) => Effect.Effect<RuntimeResponse, SwitcherError>;
}
export class ChromeTabs extends Context.Tag('Switcher/ChromeTabs')<ChromeTabs, ChromeTabsShape>() {}

export interface ChromeCommandsShape {
  readonly getShortcut: () => Effect.Effect<string | undefined, SwitcherError>;
  readonly openShortcutSettings: () => Effect.Effect<void, SwitcherError>;
  readonly updateBadge: () => Effect.Effect<void, SwitcherError>;
}
export class ChromeCommands extends Context.Tag('Switcher/ChromeCommands')<
  ChromeCommands,
  ChromeCommandsShape
>() {}

export interface ChromeStorageShape {
  readonly getTheme: () => Effect.Effect<ThemePreference, SwitcherError>;
  readonly setTheme: (theme: ThemePreference) => Effect.Effect<void, SwitcherError>;
  readonly getInvocation: () => Effect.Effect<InvocationContext, SwitcherError>;
  readonly setInvocation: (context: InvocationContext) => Effect.Effect<void, SwitcherError>;
}
export class ChromeStorage extends Context.Tag('Switcher/ChromeStorage')<
  ChromeStorage,
  ChromeStorageShape
>() {}

export interface WorkbenchNavigationShape {
  readonly openSurface: (surface: WorkbenchSurface) => Effect.Effect<void, SwitcherError>;
}
export class WorkbenchNavigation extends Context.Tag('Switcher/WorkbenchNavigation')<
  WorkbenchNavigation,
  WorkbenchNavigationShape
>() {}

export interface PaletteInjectionShape {
  readonly open: (
    tabId: number,
    windowId: number,
    url: string | undefined,
  ) => Effect.Effect<void, SwitcherError>;
  readonly openActive: () => Effect.Effect<void, SwitcherError>;
}
export class PaletteInjection extends Context.Tag('Switcher/PaletteInjection')<
  PaletteInjection,
  PaletteInjectionShape
>() {}
