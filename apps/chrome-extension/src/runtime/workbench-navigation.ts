export const WORKBENCH_ORIGIN = 'http://ide.local:7774';

export const WORKBENCH_SURFACES = ['terminal', 'agent'] as const;
export type WorkbenchSurface = (typeof WORKBENCH_SURFACES)[number];

interface BrowserTabLocation {
  readonly id?: number;
  readonly windowId: number;
  readonly index: number;
  readonly splitViewId?: number;
  readonly url?: string;
}

export type SurfacePlacement =
  | { readonly kind: 'replace'; readonly tabId: number }
  | {
      readonly kind: 'create';
      readonly windowId: number;
      readonly index: number;
      readonly openerTabId: number;
    };

export const surfaceUrl = (surface: WorkbenchSurface): string =>
  `${WORKBENCH_ORIGIN}${surface === 'terminal' ? '/terminals' : '/agents/new'}`;

export const isWorkbenchUrl = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return url.origin === WORKBENCH_ORIGIN;
  } catch {
    return false;
  }
};

export const planSurfacePlacement = (
  active: BrowserTabLocation,
  splitTabs: readonly BrowserTabLocation[],
): SurfacePlacement | undefined => {
  if (active.id === undefined) return undefined;
  if (isWorkbenchUrl(active.url)) return { kind: 'replace', tabId: active.id };
  const companion = splitTabs.find(
    (tab) => tab.id !== undefined && tab.id !== active.id && tab.splitViewId === active.splitViewId,
  );
  if (companion?.id !== undefined) return { kind: 'replace', tabId: companion.id };
  return {
    kind: 'create',
    windowId: active.windowId,
    index: active.index + 1,
    openerTabId: active.id,
  };
};
