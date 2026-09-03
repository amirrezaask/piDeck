import {
  FileDiff as PierreFileDiff,
  parsePatchFiles,
  type FileDiffMetadata,
  type FileDiffOptions,
} from '@pierre/diffs';
import { FileTree as PierreFileTree, type GitStatus, type GitStatusEntry } from '@pierre/trees';
import type { ChangeScope, RunChangesResponse } from '@nextflow/contracts';
import { FileDiffIcon, LoaderCircleIcon, XIcon } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { OperationsClient } from '@agents/components/operations';
import { Badge } from '@agents/components/ui/badge';
import { Button } from '@agents/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@agents/components/ui/empty';
import { ToggleGroup, ToggleGroupItem } from '@agents/components/ui/toggle-group';

const CHANGE_SCOPES: ReadonlyArray<{ value: ChangeScope; label: string }> = [
  { value: 'last_turn', label: 'Last turn' },
  { value: 'working_tree', label: 'Working tree' },
  { value: 'staged', label: 'Staged' },
  { value: 'branch', label: 'Branch' },
];

const DIFF_OPTIONS: FileDiffOptions<undefined> = {
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  diffStyle: 'unified',
  overflow: 'scroll',
  stickyHeader: true,
};

const PANEL_TRANSITION = {
  duration: 0.2,
  ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
};

type InterfaceTheme = 'light' | 'dark';

function useInterfaceTheme(): InterfaceTheme {
  const [theme, setTheme] = useState<InterfaceTheme>(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  );

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setTheme(root.classList.contains('dark') ? 'dark' : 'light');
    });
    observer.observe(root, { attributeFilter: ['class'], attributes: true });
    return () => observer.disconnect();
  }, []);

  return theme;
}

function gitStatus(status: string): GitStatus {
  const normalized = status.trim().toUpperCase();
  if (normalized.startsWith('A')) return 'added';
  if (normalized.startsWith('D')) return 'deleted';
  if (normalized.startsWith('R')) return 'renamed';
  if (normalized.startsWith('?')) return 'untracked';
  if (normalized.startsWith('!')) return 'ignored';
  return 'modified';
}

function normalizePath(path: string): string {
  return path.replace(/^[ab]\//, '');
}

function parseDiffs(data: RunChangesResponse): {
  error?: string;
  files: FileDiffMetadata[];
} {
  if (!data.patch.trim()) return { files: [] };
  try {
    return {
      files: parsePatchFiles(data.patch, `${data.runId}:${data.scope}`, true).flatMap(
        (patch) => patch.files,
      ),
    };
  } catch {
    return {
      files: [],
      error: data.truncated
        ? 'The supervisor truncated this patch before it could be rendered.'
        : 'Pierre could not parse the patch returned by the supervisor.',
    };
  }
}

function PierreTree({
  paths,
  statuses,
  onSelect,
  theme,
}: {
  paths: string[];
  statuses: GitStatusEntry[];
  onSelect(path: string): void;
  theme: InterfaceTheme;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const pathSet = new Set(paths);
    const tree = new PierreFileTree({
      density: 'compact',
      flattenEmptyDirectories: false,
      gitStatus: statuses,
      initialExpansion: 'open',
      initialSelectedPaths: paths[0] ? [paths[0]] : [],
      onSelectionChange(selectedPaths) {
        const selectedFile = selectedPaths.findLast((path) => pathSet.has(path));
        if (selectedFile) onSelectRef.current(selectedFile);
      },
      paths,
      search: paths.length > 8,
    });
    container.replaceChildren();
    tree.render({ containerWrapper: container });
    return () => tree.cleanUp();
  }, [paths, statuses]);

  useEffect(() => {
    const treeHost = containerRef.current?.querySelector<HTMLElement>('file-tree-container');
    if (treeHost) treeHost.style.colorScheme = theme;
  }, [paths, statuses, theme]);

  return <div ref={containerRef} className="pideck-changes-tree" aria-label="Changed file tree" />;
}

function PierreDiff({ fileDiff, theme }: { fileDiff: FileDiffMetadata; theme: InterfaceTheme }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const instance = new PierreFileDiff({ ...DIFF_OPTIONS, themeType: theme });
    container.replaceChildren();
    instance.render({ fileDiff, containerWrapper: container });
    return () => instance.cleanUp();
  }, [fileDiff, theme]);

  return <div ref={containerRef} className="pideck-pierre-diff" />;
}

function ChangesBrowser({ data }: { data: RunChangesResponse }) {
  const reducedMotion = useReducedMotion();
  const theme = useInterfaceTheme();
  const parsed = useMemo(() => parseDiffs(data), [data]);
  const paths = useMemo(() => {
    const uniquePaths = new Set(data.files.map((file) => normalizePath(file.path)));
    for (const fileDiff of parsed.files) uniquePaths.add(normalizePath(fileDiff.name));
    return [...uniquePaths];
  }, [data.files, parsed.files]);
  const [selectedPath, setSelectedPath] = useState(paths[0]);
  const gitStatuses = useMemo<GitStatusEntry[]>(
    () =>
      data.files.map((file) => ({
        path: normalizePath(file.path),
        status: gitStatus(file.status),
      })),
    [data.files],
  );
  const diffByPath = useMemo(() => {
    const result = new Map<string, FileDiffMetadata>();
    for (const fileDiff of parsed.files) {
      result.set(normalizePath(fileDiff.name), fileDiff);
      if (fileDiff.prevName) result.set(normalizePath(fileDiff.prevName), fileDiff);
    }
    return result;
  }, [parsed.files]);
  const activeDiff = selectedPath ? diffByPath.get(selectedPath) : undefined;

  if (paths.length === 0) {
    return (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileDiffIcon />
          </EmptyMedia>
          <EmptyTitle>No changes in this scope</EmptyTitle>
          <EmptyDescription>
            Choose another scope or continue working in the session.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="pideck-changes-browser min-h-0 flex-1 [container-type:inline-size]">
      <motion.aside
        className="min-h-0 overflow-hidden border-r bg-muted/15"
        aria-label="Changed files"
        initial={reducedMotion ? { opacity: 0.82 } : { opacity: 0.82, x: -10 }}
        animate={{ opacity: 1, x: 0 }}
        transition={PANEL_TRANSITION}
      >
        <PierreTree paths={paths} statuses={gitStatuses} theme={theme} onSelect={setSelectedPath} />
      </motion.aside>
      <div className="relative min-h-0 min-w-0 overflow-auto bg-background">
        <AnimatePresence mode="wait" initial={false}>
          {parsed.error ? (
            <motion.div
              key="parse-error"
              role="alert"
              className="grid min-h-full place-items-center p-6 text-center text-sm text-destructive"
              initial={{ opacity: 0.8 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0.8 }}
              transition={PANEL_TRANSITION}
            >
              {parsed.error}
            </motion.div>
          ) : activeDiff ? (
            <motion.div
              key={selectedPath}
              className="min-h-full min-w-max"
              initial={
                reducedMotion ? { opacity: 0.86 } : { opacity: 0.78, x: 10, filter: 'blur(2px)' }
              }
              animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
              exit={reducedMotion ? { opacity: 0.84 } : { opacity: 0.72, x: -6 }}
              transition={PANEL_TRANSITION}
            >
              <PierreDiff fileDiff={activeDiff} theme={theme} />
            </motion.div>
          ) : (
            <motion.div
              key={`no-text-diff:${selectedPath ?? 'none'}`}
              className="grid min-h-full place-items-center p-6 text-center"
              initial={{ opacity: 0.82 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0.82 }}
              transition={PANEL_TRANSITION}
            >
              <div>
                <p className="text-sm font-medium">No textual diff</p>
                <p className="mt-1 max-w-72 text-xs leading-5 text-muted-foreground">
                  This file may be binary, renamed without content changes, or outside the returned
                  patch.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export function ChangesPanel({
  client,
  runId,
  onClose,
}: {
  client: OperationsClient;
  runId: string;
  onClose(): void;
}) {
  const reducedMotion = useReducedMotion();
  const [scope, setScope] = useState<ChangeScope>('working_tree');
  const [data, setData] = useState<RunChangesResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(undefined);
    void client
      .getRunChanges(runId, scope)
      .then((next) => {
        if (active) setData(next);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Changes unavailable');
      });
    return () => {
      active = false;
    };
  }, [client, runId, scope]);

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background [container-type:inline-size]"
      aria-label="Workspace changes"
    >
      <header className="pideck-changes-header flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-2 px-1.5">
          <FileDiffIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-xs font-semibold">Changes</h2>
          {data?.available ? (
            <Badge variant="outline" className="tabular-nums">
              {data.files.length}
            </Badge>
          ) : null}
          {data?.truncated ? <Badge variant="destructive">Truncated</Badge> : null}
        </div>
        <ToggleGroup
          type="single"
          value={scope}
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Change scope"
          className="pideck-changes-scopes ml-auto overflow-x-auto"
          onValueChange={(value) => {
            if (value) setScope(value as ChangeScope);
          }}
        >
          {CHANGE_SCOPES.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value} aria-label={item.label}>
              {item.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="pideck-changes-close"
          onClick={onClose}
        >
          <XIcon />
          <span className="sr-only">Close changes panel</span>
        </Button>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {error ? (
            <motion.div
              key="changes-error"
              role="alert"
              className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-destructive"
              initial={{ opacity: 0.78 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0.7 }}
              transition={PANEL_TRANSITION}
            >
              {error}
            </motion.div>
          ) : !data ? (
            <motion.div
              key="changes-loading"
              className="absolute inset-0 grid place-items-center text-xs text-muted-foreground"
              role="status"
              initial={{ opacity: 0.8 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0.7 }}
              transition={PANEL_TRANSITION}
            >
              <span className="flex items-center gap-2">
                <motion.span
                  animate={reducedMotion ? undefined : { rotate: 360 }}
                  transition={
                    reducedMotion
                      ? undefined
                      : { duration: 0.9, ease: 'linear', repeat: Number.POSITIVE_INFINITY }
                  }
                >
                  <LoaderCircleIcon className="size-3.5" aria-hidden="true" />
                </motion.span>
                Loading changes…
              </span>
            </motion.div>
          ) : !data.available ? (
            <motion.div
              key="changes-unavailable"
              className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground"
              initial={{ opacity: 0.82 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0.72 }}
              transition={PANEL_TRANSITION}
            >
              {data.unavailableReason}
            </motion.div>
          ) : (
            <motion.div
              key={`${data.runId}:${data.scope}`}
              className="absolute inset-0 flex min-h-0 flex-col [container-type:inline-size]"
              initial={
                reducedMotion ? { opacity: 0.86 } : { opacity: 0.84, clipPath: 'inset(0 4% 0 0)' }
              }
              animate={{ opacity: 1, clipPath: 'inset(0 0% 0 0)' }}
              exit={{ opacity: 0.76 }}
              transition={PANEL_TRANSITION}
            >
              <ChangesBrowser data={data} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
