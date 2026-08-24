import type {
  AgentThinkingLevel,
  ManagedAgentEvent,
  ManagedAgentModelsResponse,
  ManagedAgentResponse,
  ManagedAgentRunResponse,
} from '@nextflow/contracts';
import {
  ArrowUpIcon,
  BotIcon,
  BrainIcon,
  CircleStopIcon,
  FolderIcon,
  LoaderCircleIcon,
  PlusIcon,
  SettingsIcon,
  SparklesIcon,
  Trash2Icon,
} from 'lucide-react';
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Marker, MarkerContent } from '@/components/ui/marker';
import { Message, MessageContent, MessageFooter, MessageHeader } from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api-error';
import { modelDisplayName, type SupervisorClient, supervisorClient } from '@/lib/supervisor-client';
import { mapPiEvents } from '@/lib/transcript';

const DEFAULT_AGENT_INSTRUCTIONS =
  'Inspect the workspace carefully, explain consequential decisions, and verify your work before finishing.';
const THINKING_LEVELS: readonly AgentThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export type SupervisorClientApi = Pick<
  SupervisorClient,
  | 'listAgents'
  | 'listModels'
  | 'listRuns'
  | 'listRunEvents'
  | 'streamRunEvents'
  | 'getRun'
  | 'createAgent'
  | 'renameAgent'
  | 'deleteAgent'
  | 'createRun'
  | 'cancelRun'
>;

interface AppProps {
  client?: SupervisorClientApi;
}

export default function App({ client = supervisorClient }: AppProps) {
  const [agents, setAgents] = useState<ManagedAgentResponse[]>([]);
  const [models, setModels] = useState<ManagedAgentModelsResponse>();
  const [runs, setRuns] = useState<ManagedAgentRunResponse[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [events, setEvents] = useState<ManagedAgentEvent[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const run = runs.find((candidate) => candidate.id === selectedRunId);
  const selectedAgent = agents.find((agent) => agent.id === run?.agentId);
  const transcript = useMemo(() => mapPiEvents(events), [events]);
  const runIsActive = run?.status === 'queued' || run?.status === 'running';

  useEffect(() => {
    let active = true;
    void Promise.all([
      client.listAgents({ limit: 100 }),
      client.listRuns({ limit: 100 }),
      client.listModels(),
    ])
      .then(([agentResponse, runResponse, modelResponse]) => {
        if (!active) return;
        setAgents(agentResponse.agents);
        setRuns(runResponse.runs);
        setModels(modelResponse);
        setSelectedRunId(runResponse.runs[0]?.id);
      })
      .catch((reason: unknown) => active && setError(errorMessage(reason)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    if (!run?.id) {
      setEvents([]);
      return;
    }
    const controller = new AbortController();
    let active = true;
    let lastSequence = 0;
    setEvents([]);

    void client
      .listRunEvents(run.id)
      .then((response) => {
        if (!active) return;
        lastSequence = Math.max(lastSequence, ...response.events.map((event) => event.sequence), 0);
        setEvents((current) => mergeEvents(current, response.events));
      })
      .catch((reason: unknown) => active && setError(errorMessage(reason)));

    void (async () => {
      try {
        for await (const event of client.streamRunEvents(run.id, {
          afterSequence: lastSequence,
          signal: controller.signal,
        })) {
          lastSequence = Math.max(lastSequence, event.sequence);
          setEvents((current) => mergeEvents(current, [event]));
        }
      } catch (reason) {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [client, run?.id]);

  useEffect(() => {
    if (!runIsActive || !run) return;
    const interval = window.setInterval(() => {
      void client
        .getRun(run.id)
        .then((nextRun) => {
          setRuns((current) =>
            current.map((candidate) => (candidate.id === nextRun.id ? nextRun : candidate)),
          );
        })
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [client, run, runIsActive]);

  async function createAgent(name: string, systemPrompt: string) {
    setSubmitting(true);
    setError(undefined);
    try {
      const agent = await client.createAgent({ name, systemPrompt });
      setAgents((current) => [agent, ...current]);
      return agent;
    } catch (reason) {
      setError(errorMessage(reason));
      return undefined;
    } finally {
      setSubmitting(false);
    }
  }

  async function updateAgent(agentId: string, name: string, systemPrompt: string) {
    setSubmitting(true);
    setError(undefined);
    try {
      const agent = await client.renameAgent(agentId, { name, systemPrompt });
      setAgents((current) =>
        current.map((candidate) => (candidate.id === agent.id ? agent : candidate)),
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteAgent(agentId: string) {
    setSubmitting(true);
    setError(undefined);
    try {
      await client.deleteAgent(agentId);
      setAgents((current) => current.filter((candidate) => candidate.id !== agentId));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  }

  async function startRun(input: {
    agentId: string;
    prompt: string;
    model?: { provider: string; id: string };
    thinkingLevel: AgentThinkingLevel;
    cwd: string;
  }) {
    setSubmitting(true);
    setError(undefined);
    try {
      const nextRun = await client.createRun(input);
      setRuns((current) => [
        nextRun,
        ...current.filter((candidate) => candidate.id !== nextRun.id),
      ]);
      setSelectedRunId(nextRun.id);
      setEvents([]);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelRun() {
    if (!run) return;
    setSubmitting(true);
    try {
      const nextRun = await client.cancelRun(run.id);
      setRuns((current) =>
        current.map((candidate) => (candidate.id === nextRun.id ? nextRun : candidate)),
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  }

  function openNewSession() {
    setSelectedRunId(undefined);
    setEvents([]);
  }

  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup>
        <motion.main
          className="grid h-svh grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background text-foreground md:grid-cols-[18rem_minmax(0,1fr)] md:grid-rows-1"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        >
          <motion.aside
            className="flex flex-col border-b bg-sidebar md:min-h-svh md:border-r md:border-b-0"
            initial={{ opacity: 0, x: -18 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.45, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
          >
            <motion.div
              className="flex w-full items-center justify-between gap-3 px-4 py-3 md:py-4"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, delay: 0.16, ease: [0.22, 1, 0.36, 1] }}
            >
              <motion.button
                type="button"
                className="flex items-center gap-2 rounded-lg font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={openNewSession}
                whileHover={{ x: 2 }}
                whileTap={{ scale: 0.98 }}
              >
                <motion.span
                  className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"
                  initial={{ opacity: 0, scale: 0.7, rotate: -15 }}
                  animate={{ opacity: 1, scale: 1, rotate: 0 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 24, delay: 0.22 }}
                >
                  <SparklesIcon className="size-4" aria-hidden="true" />
                </motion.span>
                piDeck
              </motion.button>
              <motion.div layout initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}>
                <Badge variant="outline">Local</Badge>
              </motion.div>
            </motion.div>
            <motion.div
              className="px-3 pb-3"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: 0.22 }}
            >
              <Button className="w-full justify-start" onClick={openNewSession}>
                <PlusIcon data-icon="inline-start" />
                New session
              </Button>
            </motion.div>
            <Separator />
            <motion.div
              className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.25, delay: 0.28 }}
            >
              Sessions
            </motion.div>
            <nav
              className="flex min-w-0 flex-1 gap-1 overflow-x-auto p-2 md:flex-col md:overflow-y-auto"
              aria-label="Sessions"
            >
              <AnimatePresence initial={false} mode="popLayout">
                {runs.length === 0 ? (
                  <motion.p
                    key="empty-runs"
                    className="hidden px-2 py-3 text-xs leading-5 text-muted-foreground md:block"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.24 }}
                  >
                    Runs will appear here after you start a session.
                  </motion.p>
                ) : (
                  runs.map((candidate, index) => {
                    const agent = agents.find((item) => item.id === candidate.agentId);
                    const selected = candidate.id === selectedRunId;
                    return (
                      <motion.div
                        key={candidate.id}
                        layout
                        initial={{ opacity: 0, x: -12 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -12 }}
                        transition={{ duration: 0.24, delay: Math.min(index, 8) * 0.025 }}
                        className="relative min-w-52 md:min-w-0"
                      >
                        {selected ? (
                          <motion.span
                            layoutId="active-session"
                            className="absolute inset-0 rounded-lg bg-secondary"
                            transition={{ type: 'spring', stiffness: 500, damping: 36 }}
                          />
                        ) : null}
                        <Button
                          variant="ghost"
                          className="relative z-10 h-auto min-w-52 justify-start px-2 py-2 text-left md:w-full md:min-w-0"
                          onClick={() => setSelectedRunId(candidate.id)}
                        >
                          <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                            <span className="w-full truncate">
                              {sessionTitle(candidate.prompt)}
                            </span>
                            <span className="flex w-full items-center gap-1.5 text-xs font-normal text-muted-foreground">
                              <RunDot status={candidate.status} />
                              <span className="truncate">{agent?.name ?? 'Agent'}</span>
                              <span aria-hidden="true">·</span>
                              <span>{formatRelativeDate(candidate.createdAt)}</span>
                            </span>
                          </span>
                        </Button>
                      </motion.div>
                    );
                  })
                )}
              </AnimatePresence>
            </nav>
            <Separator />
            <motion.div
              className="p-2"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: 0.32 }}
            >
              <Button
                variant="ghost"
                className="relative w-full justify-start"
                onClick={() => setSettingsOpen(true)}
              >
                <SettingsIcon data-icon="inline-start" />
                Settings
              </Button>
            </motion.div>
          </motion.aside>

          <section className="flex h-full min-h-0 min-w-0 flex-col">
            <AnimatePresence initial={false}>
              {error ? (
                <motion.div
                  key={error}
                  initial={{ opacity: 0, y: -10, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.98 }}
                  transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Alert variant="destructive" className="m-4 mb-0 w-auto">
                    <AlertTitle>Supervisor request failed</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <AnimatePresence initial={false} mode="wait">
              {loading ? (
                <LoadingState key="loading" />
              ) : run ? (
                <motion.div
                  key={`conversation-${run.id}`}
                  className="flex min-h-0 min-w-0 flex-1"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Conversation
                    agent={selectedAgent}
                    run={run}
                    models={models}
                    transcript={transcript}
                    submitting={submitting}
                    runIsActive={runIsActive}
                    onCancel={cancelRun}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="new-session"
                  className="flex min-h-0 min-w-0 flex-1"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                >
                  <NewSession
                    agents={agents}
                    models={models}
                    submitting={submitting}
                    onStart={startRun}
                    onOpenAgents={() => setSettingsOpen(true)}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </section>

          <AgentSettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            agents={agents}
            submitting={submitting}
            onCreate={createAgent}
            onUpdate={updateAgent}
            onDelete={deleteAgent}
          />
        </motion.main>
      </LayoutGroup>
    </MotionConfig>
  );
}

function LoadingState() {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.div
        className="flex items-center gap-2"
        animate={reducedMotion ? { opacity: 1 } : { opacity: [0.55, 1, 0.55] }}
        transition={reducedMotion ? { duration: 0.01 } : { duration: 1.6, repeat: Infinity }}
      >
        <motion.span
          animate={reducedMotion ? undefined : { rotate: 360 }}
          transition={
            reducedMotion ? undefined : { duration: 1.1, repeat: Infinity, ease: 'linear' }
          }
        >
          <LoaderCircleIcon className="size-4" aria-hidden="true" />
        </motion.span>
        Loading supervisor…
      </motion.div>
    </motion.div>
  );
}

function NewSession({
  agents,
  models,
  submitting,
  onStart,
  onOpenAgents,
}: {
  agents: ManagedAgentResponse[];
  models: ManagedAgentModelsResponse | undefined;
  submitting: boolean;
  onStart(input: {
    agentId: string;
    prompt: string;
    model?: { provider: string; id: string };
    thinkingLevel: AgentThinkingLevel;
    cwd: string;
  }): Promise<void>;
  onOpenAgents(): void;
}) {
  const [prompt, setPrompt] = useState('');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [modelKey, setModelKey] = useState(() =>
    models?.defaultModel ? encodeModel(models.defaultModel) : '',
  );
  const [thinkingLevel, setThinkingLevel] = useState<AgentThinkingLevel>('medium');
  const [cwd, setCwd] = useState(agents[0]?.cwd ?? '.');

  useEffect(() => {
    if (!agentId && agents[0]) {
      setAgentId(agents[0].id);
      setCwd(agents[0].cwd);
    }
  }, [agentId, agents]);

  useEffect(() => {
    if (!modelKey && models?.defaultModel) setModelKey(encodeModel(models.defaultModel));
  }, [modelKey, models]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || !agentId || !cwd.trim()) return;
    const model = decodeModel(modelKey);
    await onStart({
      agentId,
      prompt: value,
      ...(model ? { model } : {}),
      thinkingLevel,
      cwd: cwd.trim(),
    });
  }

  if (agents.length === 0) {
    return (
      <motion.div
        className="flex flex-1"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      >
        <Empty className="border-0">
          <EmptyHeader>
            <motion.div
              initial={{ opacity: 0, scale: 0.75, rotate: -8 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 24, delay: 0.1 }}
            >
              <EmptyMedia variant="icon">
                <BotIcon />
              </EmptyMedia>
            </motion.div>
            <EmptyTitle>Create an agent profile first</EmptyTitle>
            <EmptyDescription>
              Agent profiles add reusable instructions to Pi’s default coding prompt.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: 0.2 }}
            >
              <Button onClick={onOpenAgents}>
                <SettingsIcon data-icon="inline-start" />
                Open agent settings
              </Button>
            </motion.div>
          </EmptyContent>
        </Empty>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="flex min-h-0 flex-1 flex-col"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.header
        className="flex min-h-16 items-center border-b px-5 py-3"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, delay: 0.08 }}
      >
        <div>
          <h1 className="font-semibold">New session</h1>
          <p className="text-sm text-muted-foreground">Configure a Pi run and describe the task.</p>
        </div>
      </motion.header>
      <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 py-10 md:px-8">
        <motion.form
          className="w-full max-w-4xl overflow-hidden rounded-3xl border bg-card shadow-[0_18px_50px_-28px_oklch(0.145_0_0/0.35)]"
          initial={{ opacity: 0, y: 18, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.4, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
          onSubmit={submit}
        >
          <Textarea
            aria-label="Session task"
            placeholder="Ask Pi to inspect, build, fix, or explain…"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={submitting}
            className="min-h-44 resize-none rounded-none border-0 bg-transparent px-6 py-5 text-base shadow-none focus-visible:ring-0 md:min-h-52 md:px-8 md:py-7 md:text-lg"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <motion.div
            className="flex flex-col border-t bg-muted/25"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, delay: 0.2 }}
          >
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 md:px-6">
              <motion.div
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.99 }}
                transition={{ duration: 0.16 }}
              >
                <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger
                    aria-label="Agent profile"
                    className="max-w-52 border-0 bg-transparent shadow-none"
                  >
                    <BotIcon />
                    <SelectValue placeholder="Choose agent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </motion.div>
              <Separator orientation="vertical" className="hidden h-5 sm:block" />
              <motion.div
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.99 }}
                transition={{ duration: 0.16 }}
              >
                <Select value={modelKey} onValueChange={setModelKey}>
                  <SelectTrigger
                    aria-label="Model"
                    className="max-w-64 border-0 bg-transparent shadow-none"
                  >
                    <SparklesIcon />
                    <SelectValue placeholder="Default model" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {models?.models.map((model) => (
                        <SelectItem key={encodeModel(model)} value={encodeModel(model)}>
                          {model.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </motion.div>
              <Separator orientation="vertical" className="hidden h-5 sm:block" />
              <motion.div
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.99 }}
                transition={{ duration: 0.16 }}
              >
                <Select
                  value={thinkingLevel}
                  onValueChange={(value) => setThinkingLevel(value as AgentThinkingLevel)}
                >
                  <SelectTrigger
                    aria-label="Thinking level"
                    className="border-0 bg-transparent shadow-none"
                  >
                    <BrainIcon />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {THINKING_LEVELS.map((level) => (
                        <SelectItem key={level} value={level}>
                          {titleCase(level)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </motion.div>
              <Button
                type="submit"
                size="icon-lg"
                className="ml-auto rounded-full"
                disabled={submitting || !prompt.trim() || !agentId || !cwd.trim()}
              >
                <ArrowUpIcon />
                <span className="sr-only">Start session</span>
              </Button>
            </div>
            <motion.div
              className="flex items-center gap-2 border-t px-5 py-3 md:px-7"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, delay: 0.26 }}
            >
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <label htmlFor="session-cwd" className="sr-only">
                Working directory
              </label>
              <Input
                id="session-cwd"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder="/path/to/project"
                className="h-7 flex-1 border-0 bg-transparent px-0 font-mono text-xs shadow-none focus-visible:ring-0"
                required
              />
              <span className="hidden text-xs text-muted-foreground sm:block">
                Working directory
              </span>
            </motion.div>
          </motion.div>
        </motion.form>
      </div>
    </motion.div>
  );
}

function Conversation({
  agent,
  run,
  models,
  transcript,
  submitting,
  runIsActive,
  onCancel,
}: {
  agent: ManagedAgentResponse | undefined;
  run: ManagedAgentRunResponse;
  models: ManagedAgentModelsResponse | undefined;
  transcript: ReturnType<typeof mapPiEvents>;
  submitting: boolean;
  runIsActive: boolean;
  onCancel(): Promise<void>;
}) {
  return (
    <motion.div
      className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.header
        className="flex min-h-16 items-center justify-between gap-4 border-b px-5 py-3"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, delay: 0.08 }}
      >
        <motion.div
          className="min-w-0"
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.24, delay: 0.14 }}
        >
          <h1 className="truncate font-semibold">{sessionTitle(run.prompt)}</h1>
          <p className="truncate text-sm text-muted-foreground">
            {agent?.name ?? 'Agent'} · {modelDisplayName(run.model, models)} ·{' '}
            {run.thinkingLevel ? titleCase(run.thinkingLevel) : 'Default thinking'} · {run.cwd}
          </p>
        </motion.div>
        <motion.div
          className="flex items-center gap-2"
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.24, delay: 0.16 }}
        >
          <RunStatus status={run.status} />
          <AnimatePresence initial={false}>
            {runIsActive ? (
              <motion.div
                key="cancel-run"
                initial={{ opacity: 0, scale: 0.82, x: 8 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.82, x: -8 }}
                transition={{ type: 'spring', stiffness: 480, damping: 28 }}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={onCancel}
                  disabled={submitting}
                >
                  <CircleStopIcon />
                  <span className="sr-only">Cancel run</span>
                </Button>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </motion.div>
      </motion.header>
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport aria-label={`${agent?.name ?? 'Agent'} conversation`}>
            <MessageScrollerContent className="mx-auto w-[calc(100vw-2.5rem)] max-w-3xl px-5 py-8 md:w-full md:px-8">
              <MessageScrollerItem messageId={`prompt-${run.id}`} scrollAnchor>
                <motion.div
                  layout="position"
                  initial={{ opacity: 0, y: 14, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Message align="end">
                    <MessageContent>
                      <MessageHeader>You</MessageHeader>
                      <Bubble align="end">
                        <BubbleContent className="whitespace-pre-wrap">{run.prompt}</BubbleContent>
                      </Bubble>
                      <MessageFooter>{formatTime(run.createdAt)}</MessageFooter>
                    </MessageContent>
                  </Message>
                </motion.div>
              </MessageScrollerItem>
              <MessageScrollerItem messageId="event-stream">
                <motion.div
                  layout="position"
                  initial={{ opacity: 0, scaleX: 0.94 }}
                  animate={{ opacity: 1, scaleX: 1 }}
                  transition={{ duration: 0.28, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Marker variant="separator">
                    <MarkerContent>PI event stream</MarkerContent>
                  </Marker>
                </motion.div>
              </MessageScrollerItem>
              {transcript.map((item, index) => (
                <TranscriptRow key={item.id} item={item} index={index} />
              ))}
              <AnimatePresence initial={false}>
                {runIsActive && transcript.length === 0 ? (
                  <MessageScrollerItem key="waiting" messageId="waiting">
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.22 }}
                    >
                      <Marker variant="separator">
                        <MarkerContent>Waiting for PI…</MarkerContent>
                      </Marker>
                    </motion.div>
                  </MessageScrollerItem>
                ) : null}
              </AnimatePresence>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </motion.div>
  );
}

function AgentSettingsDialog({
  open,
  onOpenChange,
  agents,
  submitting,
  onCreate,
  onUpdate,
  onDelete,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  agents: ManagedAgentResponse[];
  submitting: boolean;
  onCreate(name: string, systemPrompt: string): Promise<ManagedAgentResponse | undefined>;
  onUpdate(agentId: string, name: string, systemPrompt: string): Promise<void>;
  onDelete(agentId: string): Promise<void>;
}) {
  const [editing, setEditing] = useState<string | 'new'>();
  const selectedAgent = agents.find((agent) => agent.id === editing);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="h-[min(48rem,calc(100svh-2rem))] max-w-[min(64rem,calc(100vw-2rem))] overflow-hidden p-0 sm:max-w-[min(64rem,calc(100vw-2rem))]">
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Configure piDeck and reusable Pi agent profiles.
          </DialogDescription>
          <motion.div
            className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[14rem_minmax(0,1fr)] md:grid-rows-1"
            initial={{ opacity: 0, y: 12, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <motion.aside
              className="border-b bg-muted/25 p-4 md:border-r md:border-b-0"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.24, delay: 0.08 }}
            >
              <h2 className="px-2 text-lg font-semibold tracking-tight">Settings</h2>
              <nav className="mt-4" aria-label="Settings sections">
                <Button variant="secondary" className="w-full justify-start">
                  <BotIcon data-icon="inline-start" />
                  Agents
                  <Badge variant="outline" className="ml-auto">
                    {agents.length}
                  </Badge>
                </Button>
              </nav>
            </motion.aside>
            <motion.section
              className="min-h-0 overflow-y-auto p-5 md:p-8"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.26, delay: 0.1 }}
            >
              <div className="mx-auto flex max-w-3xl flex-col gap-6">
                <motion.div
                  className="flex items-start justify-between gap-4 pr-8"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.24, delay: 0.14 }}
                >
                  <div>
                    <h3 className="text-xl font-semibold tracking-tight">Agents</h3>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      Reusable instructions appended to Pi’s default coding-agent prompt.
                    </p>
                  </div>
                  <Button onClick={() => setEditing('new')}>
                    <PlusIcon data-icon="inline-start" />
                    New agent
                  </Button>
                </motion.div>

                {agents.length === 0 ? (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.24, delay: 0.2 }}
                  >
                    <Empty className="min-h-72 border">
                      <EmptyHeader>
                        <motion.div
                          initial={{ opacity: 0, scale: 0.75, rotate: -8 }}
                          animate={{ opacity: 1, scale: 1, rotate: 0 }}
                          transition={{ type: 'spring', stiffness: 420, damping: 24, delay: 0.24 }}
                        >
                          <EmptyMedia variant="icon">
                            <BotIcon />
                          </EmptyMedia>
                        </motion.div>
                        <EmptyTitle>No agents defined</EmptyTitle>
                        <EmptyDescription>
                          Create a profile with focused instructions for a repeatable role.
                        </EmptyDescription>
                      </EmptyHeader>
                      <EmptyContent>
                        <motion.div
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.22, delay: 0.3 }}
                        >
                          <Button onClick={() => setEditing('new')}>Create your first agent</Button>
                        </motion.div>
                      </EmptyContent>
                    </Empty>
                  </motion.div>
                ) : (
                  <motion.div
                    className="overflow-hidden rounded-xl border"
                    aria-label="Defined agents"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.24, delay: 0.2 }}
                  >
                    <AnimatePresence initial={false} mode="popLayout">
                      {agents.map((agent, index) => (
                        <motion.div
                          key={agent.id}
                          layout
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -10 }}
                          transition={{ duration: 0.24, delay: Math.min(index, 6) * 0.03 }}
                        >
                          {index > 0 ? <Separator /> : null}
                          <motion.button
                            type="button"
                            className="flex w-full items-center gap-3 px-4 py-4 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50"
                            onClick={() => setEditing(agent.id)}
                          >
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                              <BotIcon className="size-4" aria-hidden="true" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium">{agent.name}</span>
                              <span className="mt-0.5 block truncate text-sm text-muted-foreground">
                                {agent.systemPrompt}
                              </span>
                            </span>
                            <span className="text-xs text-muted-foreground">Edit</span>
                          </motion.button>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </motion.div>
                )}
              </div>
            </motion.section>
          </motion.div>
        </DialogContent>
      </Dialog>

      <AgentEditorDialog
        open={editing !== undefined}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setEditing(undefined);
        }}
        agent={selectedAgent}
        submitting={submitting}
        onCreate={async (name, systemPrompt) => {
          const created = await onCreate(name, systemPrompt);
          if (created) setEditing(undefined);
        }}
        onUpdate={async (agentId, name, systemPrompt) => {
          await onUpdate(agentId, name, systemPrompt);
          setEditing(undefined);
        }}
        onDelete={async (agentId) => {
          await onDelete(agentId);
          setEditing(undefined);
        }}
      />
    </>
  );
}

function AgentEditorDialog({
  open,
  onOpenChange,
  agent,
  submitting,
  onCreate,
  onUpdate,
  onDelete,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  agent: ManagedAgentResponse | undefined;
  submitting: boolean;
  onCreate(name: string, systemPrompt: string): Promise<void>;
  onUpdate(agentId: string, name: string, systemPrompt: string): Promise<void>;
  onDelete(agentId: string): Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <AgentEditorForm
        key={agent?.id ?? 'new'}
        agent={agent}
        submitting={submitting}
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
      />
    </Dialog>
  );
}

function AgentEditorForm({
  agent,
  submitting,
  onCreate,
  onUpdate,
  onDelete,
}: {
  agent: ManagedAgentResponse | undefined;
  submitting: boolean;
  onCreate(name: string, systemPrompt: string): Promise<void>;
  onUpdate(agentId: string, name: string, systemPrompt: string): Promise<void>;
  onDelete(agentId: string): Promise<void>;
}) {
  const [name, setName] = useState(agent?.name ?? 'Coding agent');
  const [systemPrompt, setSystemPrompt] = useState(
    agent?.systemPrompt ?? DEFAULT_AGENT_INSTRUCTIONS,
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    const nextPrompt = systemPrompt.trim();
    if (!nextName || !nextPrompt) return;
    if (agent) await onUpdate(agent.id, nextName, nextPrompt);
    else await onCreate(nextName, nextPrompt);
  }

  return (
    <DialogContent className="sm:max-w-2xl">
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      >
        <DialogHeader>
          <DialogTitle>{agent ? 'Edit agent' : 'New agent'}</DialogTitle>
          <DialogDescription>
            Add focused role instructions. Pi’s maintained coding prompt, tools, skills, and project
            context remain intact.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="py-6">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, delay: 0.08 }}
          >
            <Field>
              <FieldLabel htmlFor="agent-name">Name</FieldLabel>
              <Input
                id="agent-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Release reviewer"
                required
              />
            </Field>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, delay: 0.13 }}
          >
            <Field>
              <FieldLabel htmlFor="agent-instructions">Additional instructions</FieldLabel>
              <Textarea
                id="agent-instructions"
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                rows={10}
                placeholder="Describe this agent’s role, priorities, and constraints."
                required
              />
              <FieldDescription>
                Do not repeat general coding or tool guidance already provided by Pi.
              </FieldDescription>
            </Field>
          </motion.div>
        </FieldGroup>
        <DialogFooter className="justify-between sm:justify-between">
          <div>
            {agent ? (
              <Button
                type="button"
                variant="destructive"
                disabled={submitting}
                onClick={() => void onDelete(agent.id)}
              >
                <Trash2Icon data-icon="inline-start" />
                Delete
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting || !name.trim() || !systemPrompt.trim()}>
              {agent ? 'Save changes' : 'Create agent'}
            </Button>
          </div>
        </DialogFooter>
      </motion.form>
    </DialogContent>
  );
}

function TranscriptRow({
  item,
  index,
}: {
  item: ReturnType<typeof mapPiEvents>[number];
  index: number;
}) {
  const transition = {
    duration: 0.28,
    delay: Math.min(index, 6) * 0.025,
    ease: [0.22, 1, 0.36, 1] as const,
  };

  if (item.kind === 'assistant') {
    return (
      <MessageScrollerItem messageId={item.id}>
        <motion.div
          layout="position"
          initial={{ opacity: 0, y: 12, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={transition}
        >
          <Message>
            <MessageContent>
              <MessageHeader>PI</MessageHeader>
              <Bubble variant="muted">
                <BubbleContent className="whitespace-pre-wrap">{item.content}</BubbleContent>
              </Bubble>
              <MessageFooter>{formatTime(item.createdAt)}</MessageFooter>
            </MessageContent>
          </Message>
        </motion.div>
      </MessageScrollerItem>
    );
  }

  return (
    <MessageScrollerItem messageId={item.id}>
      <motion.div
        layout="position"
        initial={{ opacity: 0, y: 8, scaleX: 0.98 }}
        animate={{ opacity: 1, y: 0, scaleX: 1 }}
        transition={transition}
      >
        <Marker variant={item.kind === 'error' ? 'border' : 'separator'}>
          <MarkerContent className={item.kind === 'error' ? 'text-destructive' : undefined}>
            {item.label}
            {item.detail ? ` · ${item.detail}` : ''}
          </MarkerContent>
        </Marker>
      </motion.div>
    </MessageScrollerItem>
  );
}

function RunStatus({ status }: { status: ManagedAgentRunResponse['status'] }) {
  return (
    <AnimatePresence initial={false} mode="wait">
      <motion.div
        key={status}
        layout
        initial={{ opacity: 0, y: -6, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.9 }}
        transition={{ type: 'spring', stiffness: 440, damping: 28 }}
      >
        <Badge variant={status === 'failed' ? 'destructive' : 'secondary'}>
          {titleCase(status)}
        </Badge>
      </motion.div>
    </AnimatePresence>
  );
}

function RunDot({ status }: { status: ManagedAgentRunResponse['status'] }) {
  const reducedMotion = useReducedMotion();
  const active = status === 'running' || status === 'queued';
  return (
    <motion.span
      className={
        active
          ? 'size-1.5 rounded-full bg-foreground'
          : 'size-1.5 rounded-full bg-muted-foreground/50'
      }
      aria-label={titleCase(status)}
      animate={
        active && !reducedMotion
          ? { opacity: [0.45, 1, 0.45], scale: [0.9, 1.15, 0.9] }
          : { opacity: 1 }
      }
      transition={
        active && !reducedMotion ? { duration: 1.4, repeat: Infinity } : { duration: 0.18 }
      }
    />
  );
}

function encodeModel(model: { provider: string; id: string }): string {
  return `${model.provider}\u0000${model.id}`;
}

function decodeModel(value: string): { provider: string; id: string } | undefined {
  const separator = value.indexOf('\u0000');
  if (separator < 1 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

function sessionTitle(prompt: string): string {
  const firstLine = prompt.split('\n', 1)[0]?.trim() ?? '';
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine || 'Untitled session';
}

function mergeEvents(
  current: readonly ManagedAgentEvent[],
  incoming: readonly ManagedAgentEvent[],
): ManagedAgentEvent[] {
  return [
    ...new Map([...current, ...incoming].map((event) => [event.sequence, event])).values(),
  ].sort((left, right) => left.sequence - right.sequence);
}

function errorMessage(reason: unknown): string {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message;
  return 'The supervisor could not complete the request.';
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(value),
  );
}

function formatRelativeDate(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return formatTime(value);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}
