import type {
  ChangeScope,
  FleetRun,
  InboxItemResponse,
  ManagedProjectResponse,
  RunChangesResponse,
  RunDebugLogResponse,
  WorktreeResponse,
} from '@nextflow/contracts';
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  FileDiffIcon,
  GitBranchIcon,
  InboxIcon,
  NetworkIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';

export interface OperationsClient {
  getFleet(): Promise<import('@nextflow/contracts').FleetOverviewResponse>;
  getRunChanges(runId: string, scope: ChangeScope, baseRef?: string): Promise<RunChangesResponse>;
  getRunDebugLog(runId: string): Promise<RunDebugLogResponse>;
  listInbox(): Promise<{ items: InboxItemResponse[] }>;
  resolveInbox(id: string, response: string): Promise<InboxItemResponse>;
  cancelInbox(id: string): Promise<InboxItemResponse>;
  searchSessions(q: string): Promise<import('@nextflow/contracts').SessionSearchResponse>;
  listWorktrees(): Promise<{ worktrees: WorktreeResponse[] }>;
  createWorktree(
    input: import('@nextflow/contracts').CreateWorktreeRequest,
  ): Promise<WorktreeResponse>;
  releaseWorktree(id: string, force?: boolean): Promise<WorktreeResponse>;
}

export interface ServerOperationsClient {
  id: string;
  name: string;
  client: OperationsClient;
}

function statusPriority(status: FleetRun['status']) {
  return status === 'failed'
    ? 0
    : status === 'running'
      ? 1
      : status === 'queued'
        ? 2
        : status === 'cancelled'
          ? 3
          : 4;
}

export function FleetOverview({
  servers,
  onOpenRun,
}: {
  servers: ServerOperationsClient[];
  onOpenRun(serverId: string, runId: string): void;
}) {
  const [data, setData] = useState<
    Array<{
      server: ServerOperationsClient;
      fleet?: import('@nextflow/contracts').FleetOverviewResponse;
      error?: string;
    }>
  >([]);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void Promise.all(
        servers.map(async (server) => {
          try {
            return { server, fleet: await server.client.getFleet() };
          } catch (error) {
            return { server, error: error instanceof Error ? error.message : 'Unavailable' };
          }
        }),
      ).then((next) => {
        if (active) setData(next);
      });
    refresh();
    const interval = window.setInterval(refresh, 3_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [servers]);
  const totals = data.reduce(
    (sum, item) => ({
      active: sum.active + (item.fleet?.counts.active ?? 0),
      attention: sum.attention + (item.fleet?.counts.attention ?? 0),
      total: sum.total + (item.fleet?.counts.total ?? 0),
    }),
    { active: 0, attention: 0, total: 0 },
  );
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto" aria-labelledby="fleet-title">
      <header className="border-b px-5 py-5">
        <div className="mx-auto flex max-w-6xl items-start justify-between gap-6">
          <div>
            <h1 id="fleet-title" className="text-xl font-semibold tracking-tight">
              Fleet overview
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Attention first across every connected supervisor.
            </p>
          </div>
          <div className="flex gap-2">
            <Badge variant={totals.attention ? 'destructive' : 'outline'}>
              {totals.attention} attention
            </Badge>
            <Badge variant="secondary">{totals.active} active</Badge>
            <Badge variant="outline">{totals.total} total</Badge>
          </div>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-6">
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading fleet state…</p>
        ) : (
          data.map(({ server, fleet, error }) => (
            <section key={server.id} className="overflow-hidden rounded-xl border">
              <header className="flex items-center gap-2 bg-muted/35 px-4 py-3">
                <ServerIcon className="size-4" />
                <h2 className="font-medium">{server.name}</h2>
                <Badge className="ml-auto" variant={error ? 'destructive' : 'outline'}>
                  {error ? 'Unavailable' : fleet?.health.status}
                </Badge>
                {fleet && !fleet.complete ? <Badge variant="outline">First 500</Badge> : null}
              </header>
              {error ? (
                <p className="px-4 py-5 text-sm text-destructive">{error}</p>
              ) : fleet?.runs.length ? (
                <div>
                  {[...fleet.runs]
                    .sort((a, b) => statusPriority(a.status) - statusPriority(b.status))
                    .map((run) => (
                      <FleetRunRow
                        key={run.id}
                        run={run}
                        depth={0}
                        onOpen={(runId) => onOpenRun(server.id, runId)}
                      />
                    ))}
                </div>
              ) : (
                <p className="px-4 py-5 text-sm text-muted-foreground">
                  No runs on this supervisor.
                </p>
              )}
            </section>
          ))
        )}
      </div>
    </section>
  );
}

function FleetRunRow({
  run,
  depth,
  onOpen,
}: {
  run: FleetRun;
  depth: number;
  onOpen(runId: string): void;
}) {
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-3 border-t px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ paddingLeft: `${1 + depth * 1.5}rem` }}
        onClick={() => onOpen(run.id)}
      >
        {depth ? (
          <ChevronRightIcon className="size-3 text-muted-foreground" />
        ) : (
          <NetworkIcon className="size-4 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{run.prompt.split('\n', 1)[0]}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {run.agentName} · {run.executionMode} · {run.cwd}
          </span>
        </span>
        <Badge variant={run.status === 'failed' ? 'destructive' : 'outline'}>{run.status}</Badge>
      </button>
      {run.children.map((child) => (
        <FleetRunRow key={child.id} run={child} depth={depth + 1} onOpen={onOpen} />
      ))}
    </div>
  );
}

export function InboxView({ servers }: { servers: ServerOperationsClient[] }) {
  const [items, setItems] = useState<
    Array<InboxItemResponse & { serverId: string; serverName: string }>
  >([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const load = () => {
    void Promise.allSettled(
      servers.map(async (server) => ({
        server,
        result: await server.client.listInbox(),
      })),
    ).then((results) => {
      const failures: string[] = [];
      const next = results.flatMap((result) => {
        if (result.status === 'rejected') {
          failures.push(
            result.reason instanceof Error ? result.reason.message : 'Inbox unavailable',
          );
          return [];
        }
        return result.value.result.items.map((item) => ({
          ...item,
          serverId: result.value.server.id,
          serverName: result.value.server.name,
        }));
      });
      setItems(next);
      setError(failures.length ? [...new Set(failures)].join('\n') : undefined);
    });
  };
  useEffect(() => {
    load();
    const interval = window.setInterval(load, 3_000);
    return () => window.clearInterval(interval);
  }, [servers]);
  const act = async (item: InboxItemResponse & { serverId: string }, response: string) => {
    const server = servers.find((candidate) => candidate.id === item.serverId);
    if (!server) return;
    try {
      await server.client.resolveInbox(item.id, response);
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Action failed');
    }
  };
  const cancel = async (item: InboxItemResponse & { serverId: string }) => {
    const server = servers.find((candidate) => candidate.id === item.serverId);
    if (!server) return;
    await server.client.cancelInbox(item.id);
    load();
  };
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="border-b px-5 py-5">
        <div className="mx-auto max-w-4xl">
          <h1 className="text-xl font-semibold">Inbox</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Approvals and questions that interrupt active work.
          </p>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-5 py-6">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No items need a response.</p>
        ) : (
          items.map((item) => (
            <article key={item.id} className="rounded-xl border p-4">
              <div className="flex items-start gap-3">
                {item.kind === 'approval' ? (
                  <AlertTriangleIcon className="mt-0.5 size-4" />
                ) : (
                  <InboxIcon className="mt-0.5 size-4" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex gap-2">
                    <h2 className="font-medium">{item.title}</h2>
                    <Badge variant="outline">{item.serverName}</Badge>
                    <Badge variant="outline">{item.kind}</Badge>
                    <Badge variant={item.status === 'pending' ? 'secondary' : 'outline'}>
                      {item.status}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{item.body}</p>
                  {item.status === 'pending' ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {(item.options.length
                        ? item.options
                        : item.kind === 'approval'
                          ? ['Approve', 'Reject']
                          : []
                      ).map((option) => (
                        <Button
                          key={option}
                          size="sm"
                          variant={option.toLowerCase() === 'reject' ? 'destructive' : 'outline'}
                          onClick={() => void act(item, option)}
                        >
                          {option}
                        </Button>
                      ))}
                      {item.kind === 'question' && item.options.length === 0 ? (
                        <>
                          <Input
                            aria-label={`Answer ${item.title}`}
                            value={drafts[item.id] ?? ''}
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [item.id]: event.target.value,
                              }))
                            }
                            className="min-w-56 flex-1"
                          />
                          <Button
                            size="sm"
                            disabled={!drafts[item.id]?.trim()}
                            onClick={() => void act(item, drafts[item.id] ?? '')}
                          >
                            Answer
                          </Button>
                        </>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => void cancel(item)}>
                        <XIcon />
                        Cancel
                      </Button>
                    </div>
                  ) : item.response ? (
                    <p className="mt-3 text-sm">Response: {item.response}</p>
                  ) : null}
                </div>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

export function WorktreeManager({
  client,
  projects,
}: {
  client: OperationsClient;
  projects: ManagedProjectResponse[];
}) {
  const [worktrees, setWorktrees] = useState<WorktreeResponse[]>([]);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [branch, setBranch] = useState('pideck/task');
  const load = () => void client.listWorktrees().then((result) => setWorktrees(result.worktrees));
  const release = async (worktree: WorktreeResponse) => {
    try {
      await client.releaseWorktree(worktree.id);
    } catch (error) {
      const confirmed = window.confirm(
        `${error instanceof Error ? error.message : 'The worktree could not be released.'}\n\nForce cleanup may discard uncommitted work. Continue?`,
      );
      if (!confirmed) return;
      await client.releaseWorktree(worktree.id, true);
    }
    load();
  };
  useEffect(() => {
    load();
    const interval = window.setInterval(load, 3_000);
    return () => window.clearInterval(interval);
  }, [client]);
  return (
    <section className="p-5">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-xl font-semibold">Worktrees</h1>
        <form
          className="mt-5 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void client.createWorktree({ projectId, branch, baseRef: 'HEAD' }).then(load);
          }}
        >
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Project" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Input
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            className="w-64"
            aria-label="Worktree branch"
          />
          <Button type="submit" disabled={!projectId || !branch}>
            <GitBranchIcon />
            Create worktree
          </Button>
        </form>
        <div className="mt-5 overflow-hidden rounded-xl border">
          {worktrees.length ? (
            worktrees.map((worktree, index) => (
              <div key={worktree.id}>
                {index ? <Separator /> : null}
                <div className="flex items-center gap-3 p-4">
                  <GitBranchIcon className="size-4" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{worktree.branch}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {worktree.path}
                    </p>
                  </div>
                  <Badge variant="outline">{worktree.status}</Badge>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Release ${worktree.branch}`}
                    disabled={worktree.status === 'busy'}
                    onClick={() => void release(worktree)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
            ))
          ) : (
            <p className="p-4 text-sm text-muted-foreground">No managed worktrees.</p>
          )}
        </div>
      </div>
    </section>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  servers,
  onOpenRun,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  servers: ServerOperationsClient[];
  onOpenRun(serverId: string, runId: string): void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ serverId: string; runId: string; title: string }>>(
    [],
  );
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setResults([]);
      return;
    }
    let active = true;
    void Promise.all(
      servers.map(async (server) => ({
        server,
        results: (await server.client.searchSessions(query)).results,
      })),
    )
      .then((groups) => {
        if (active)
          setResults(
            groups.flatMap(({ server, results }) =>
              results.map((result) => ({
                serverId: server.id,
                runId: result.runId,
                title: result.title,
              })),
            ),
          );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [open, query, servers]);
  const run = (action: () => void) => {
    action();
    onOpenChange(false);
    setQuery('');
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) setQuery('');
      }}
    >
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Switch session</DialogTitle>
        <DialogDescription className="sr-only">
          Search for a Pi session and switch to it.
        </DialogDescription>
        <div className="flex items-center border-b px-3">
          <SearchIcon className="size-4 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Switch to a session…"
            className="h-12 min-w-0 flex-1 bg-transparent px-3 text-sm outline-none"
          />
        </div>
        <Command shouldFilter={false}>
          <CommandList>
            <CommandEmpty>
              {query.trim().length < 2 ? 'Type at least two characters.' : 'No matching sessions.'}
            </CommandEmpty>
            {results.length ? (
              <CommandGroup heading="Sessions">
                {results.map((result) => (
                  <CommandItem
                    key={`${result.serverId}:${result.runId}`}
                    onSelect={() => run(() => onOpenRun(result.serverId, result.runId))}
                  >
                    <FileDiffIcon />
                    <span className="truncate">{result.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
