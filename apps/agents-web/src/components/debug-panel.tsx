import type { RunDebugLogResponse } from '@nextflow/contracts';
import { BugIcon, CopyIcon, LoaderCircleIcon, RefreshCwIcon, XIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { OperationsClient } from '@/components/operations';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

function lifecycleLog(data: RunDebugLogResponse): string {
  return data.supervisorEvents
    .map((event) =>
      JSON.stringify({
        sequence: event.sequence,
        createdAt: event.createdAt,
        type: event.type,
        payload: event.payload,
      }),
    )
    .join('\n');
}

function byteLabel(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function DebugPanel({
  client,
  runId,
  runIsActive,
  onClose,
}: {
  client: OperationsClient;
  runId: string;
  runIsActive: boolean;
  onClose(): void;
}) {
  const [data, setData] = useState<RunDebugLogResponse>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setData(await client.getRunDebugLog(runId));
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Debug log unavailable');
    } finally {
      setRefreshing(false);
    }
  }, [client, runId]);

  useEffect(() => {
    void load();
    if (!runIsActive) return;
    const interval = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(interval);
  }, [load, runIsActive]);

  const journal = data?.content ?? '';
  const lifecycle = data ? lifecycleLog(data) : '';

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Run debug log">
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <BugIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-xs font-semibold">Debug log</h2>
        <Badge
          variant="outline"
          className="hidden font-normal text-muted-foreground sm:inline-flex"
        >
          Raw · sensitive
        </Badge>
        {data?.truncated ? <Badge variant="destructive">Truncated</Badge> : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          onClick={() => void load()}
          disabled={refreshing}
        >
          <RefreshCwIcon className={refreshing ? 'animate-spin' : undefined} />
          <span className="sr-only">Refresh debug log</span>
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose}>
          <XIcon />
          <span className="sr-only">Close debug log</span>
        </Button>
      </header>

      {error ? (
        <div
          className="grid min-h-0 flex-1 place-items-center p-6 text-center text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : !data ? (
        <div
          className="grid min-h-0 flex-1 place-items-center text-xs text-muted-foreground"
          role="status"
        >
          <span className="flex items-center gap-2">
            <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
            Loading debug log…
          </span>
        </div>
      ) : (
        <>
          {data.diagnostics.length > 0 ? (
            <div
              className="shrink-0 border-b bg-amber-500/8 px-4 py-2.5 text-xs leading-5 text-foreground"
              role="status"
            >
              {data.diagnostics.map((diagnostic) => (
                <p key={diagnostic}>{diagnostic}</p>
              ))}
            </div>
          ) : null}
          <Tabs defaultValue="journal" className="min-h-0 flex-1 gap-0">
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
              <TabsList className="h-7">
                <TabsTrigger value="journal" className="text-xs">
                  PI journal
                </TabsTrigger>
                <TabsTrigger value="lifecycle" className="text-xs">
                  Lifecycle <span className="tabular-nums">{data.supervisorEvents.length}</span>
                </TabsTrigger>
              </TabsList>
              <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                {data.available ? byteLabel(data.bytesRead) : 'No journal'}
              </span>
            </div>

            <TabsContent
              value="journal"
              className="relative min-h-0 flex-1 overflow-auto bg-muted/15"
            >
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="sticky top-2 z-10 float-right mr-2"
                onClick={() => void copy(journal)}
                disabled={!journal}
              >
                <CopyIcon />
                <span className="sr-only">{copied ? 'Copied' : 'Copy PI journal'}</span>
              </Button>
              {data.available ? (
                <pre
                  className="min-w-full whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-5"
                  dir="ltr"
                >
                  {journal || 'The journal exists but is empty.'}
                </pre>
              ) : (
                <div className="grid min-h-full place-items-center p-6 text-center">
                  <div className="max-w-sm">
                    <p className="text-sm font-medium">No PI journal</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {data.unavailableReason}
                    </p>
                    {data.sessionFile ? (
                      <p
                        className="mt-3 break-all font-mono text-[10px] leading-4 text-muted-foreground"
                        dir="ltr"
                      >
                        {data.sessionFile}
                      </p>
                    ) : null}
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent
              value="lifecycle"
              className="relative min-h-0 flex-1 overflow-auto bg-muted/15"
            >
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="sticky top-2 z-10 float-right mr-2"
                onClick={() => void copy(lifecycle)}
                disabled={!lifecycle}
              >
                <CopyIcon />
                <span className="sr-only">Copy lifecycle events</span>
              </Button>
              <pre
                className="min-w-full whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-5"
                dir="ltr"
              >
                {lifecycle || 'No supervisor lifecycle events were recorded.'}
              </pre>
            </TabsContent>
          </Tabs>
        </>
      )}
    </section>
  );
}
