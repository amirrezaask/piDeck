import type {
  AgentThinkingLevel,
  JsonValue,
  ManagedAgentEvent,
  ManagedAgentModelsResponse,
  ManagedAgentResponse,
  ManagedAgentRunResponse,
  ManagedProjectResponse,
} from '@nextflow/contracts';
import {
  ArrowUpIcon,
  BookOpenIcon,
  BotIcon,
  BrainIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleStopIcon,
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
  LoaderCircleIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PaperclipIcon,
  PlusIcon,
  PuzzleIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  SunIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from 'motion/react';
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type SVGProps,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { MarkdownContent } from '@/components/markdown-content';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment';
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
import { AVAILABLE_SKILLS } from '@/lib/skills';
import { modelDisplayName, type SupervisorClient, supervisorClient } from '@/lib/supervisor-client';
import { collapseThinkingMarkers, mapPiEvents, type TranscriptEvent } from '@/lib/transcript';
import { cn } from '@/lib/utils';

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

type SettingsSection = 'agents' | 'skills' | 'extensions' | 'appearance';

const THEME_STORAGE_KEY = 'pideck-theme';
const SIDEBAR_STORAGE_KEY = 'pideck-sidebar-collapsed';

function PiIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} className={className} viewBox="0 0 800 800" fill="none" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M165.29 165.29h352.07V400H400v117.36H282.65v117.36H165.29V165.29Zm117.36 117.36V400H400V282.65H282.65Z"
      />
      <path fill="currentColor" d="M517.36 400h117.36v234.72H517.36z" />
    </svg>
  );
}

function readDarkModePreference() {
  if (typeof window === 'undefined') return false;

  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark';
  } catch {
    return false;
  }
}

function readSidebarCollapsedPreference() {
  if (typeof window === 'undefined') return false;

  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

const INSTALLED_EXTENSIONS = [
  {
    id: 'git-tools',
    name: 'Git tools',
    description: 'Inspect repository status, diffs, and branch context from Pi.',
    version: '1.8.2',
    latestVersion: '1.8.2',
  },
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'Run commands and inspect process output in the current workspace.',
    version: '2.4.0',
    latestVersion: '2.5.0',
  },
  {
    id: 'project-indexer',
    name: 'Project indexer',
    description: 'Build a searchable symbol map for larger workspaces.',
    version: '0.9.1',
    latestVersion: '0.9.1',
  },
] as const;

export type SupervisorClientApi = Pick<
  SupervisorClient,
  | 'listAgents'
  | 'listModels'
  | 'listRuns'
  | 'listProjects'
  | 'listRunEvents'
  | 'streamRunEvents'
  | 'getRun'
  | 'createAgent'
  | 'renameAgent'
  | 'deleteAgent'
  | 'createRun'
  | 'createProject'
  | 'deleteProject'
  | 'cancelRun'
  | 'followUpRun'
>;

interface AppProps {
  client?: SupervisorClientApi;
}

export default function App({ client = supervisorClient }: AppProps) {
  const [agents, setAgents] = useState<ManagedAgentResponse[]>([]);
  const [models, setModels] = useState<ManagedAgentModelsResponse>();
  const [runs, setRuns] = useState<ManagedAgentRunResponse[]>([]);
  const [projects, setProjects] = useState<ManagedProjectResponse[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [events, setEvents] = useState<ManagedAgentEvent[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => readDarkModePreference());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsedPreference());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const run = runs.find((candidate) => candidate.id === selectedRunId);
  const selectedAgent = agents.find((agent) => agent.id === run?.agentId);
  const transcript = useMemo(() => mapPiEvents(events), [events]);
  const runIsActive = run?.status === 'queued' || run?.status === 'running';

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    document.documentElement.style.colorScheme = darkMode ? 'dark' : 'light';
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute('content', darkMode ? '#171717' : '#ffffff');

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, darkMode ? 'dark' : 'light');
    } catch {
      // Preferences are a convenience; an unavailable storage API should not block the app.
    }
  }, [darkMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
    } catch {
      // Preferences are a convenience; an unavailable storage API should not block the app.
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      client.listAgents({ limit: 100 }),
      client.listRuns({ limit: 100 }),
      client.listProjects({ limit: 100 }),
      client.listModels(),
    ])
      .then(([agentResponse, runResponse, projectResponse, modelResponse]) => {
        if (!active) return;
        setAgents(agentResponse.agents);
        setRuns(runResponse.runs);
        setProjects(projectResponse.projects);
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

    void (async () => {
      try {
        const response = await client.listRunEvents(run.id);
        if (!active) return;
        lastSequence = Math.max(lastSequence, ...response.events.map((event) => event.sequence), 0);
        setEvents((current) => mergeEvents(current, response.events));

        for await (const event of client.streamRunEvents(run.id, {
          afterSequence: lastSequence,
          signal: controller.signal,
        })) {
          if (!active) return;
          lastSequence = Math.max(lastSequence, event.sequence);
          setEvents((current) => mergeEvents(current, [event]));
        }
      } catch (reason) {
        if (active && !controller.signal.aborted) setError(errorMessage(reason));
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
      const project = await client.createProject({ path: input.cwd });
      setProjects((current) => [
        project,
        ...current.filter((candidate) => candidate.id !== project.id),
      ]);
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

  async function deleteProject(project: ManagedProjectResponse): Promise<boolean> {
    setSubmitting(true);
    setError(undefined);
    try {
      await client.deleteProject(project.id);
      setProjects((current) => current.filter((candidate) => candidate.id !== project.id));
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
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

  async function followUpRun(message: string) {
    if (!run) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const nextRun = await client.followUpRun(run.id, { message });
      setRuns((current) =>
        current.map((candidate) => (candidate.id === nextRun.id ? nextRun : candidate)),
      );
    } catch (reason) {
      setError(errorMessage(reason));
      throw reason;
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
          className={cn(
            'grid h-svh grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background text-foreground motion-safe:transition-[grid-template-columns] motion-safe:duration-200 motion-safe:ease-out md:grid-rows-1',
            sidebarCollapsed
              ? 'md:grid-cols-[4.5rem_minmax(0,1fr)]'
              : 'md:grid-cols-[18rem_minmax(0,1fr)]',
          )}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
        >
          <motion.aside
            className="flex flex-col border-b bg-sidebar md:min-h-svh md:border-r md:border-b-0"
            initial={{ opacity: 0, x: -18 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.16, delay: 0.04, ease: [0.22, 1, 0.36, 1] }}
          >
            <motion.div
              className={cn(
                'flex w-full items-center justify-between gap-3 px-4 py-3 md:py-4',
                sidebarCollapsed && 'flex-col items-center gap-2 px-2 py-3',
              )}
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, delay: 0.11, ease: [0.22, 1, 0.36, 1] }}
            >
              <motion.button
                type="button"
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded-lg font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                  sidebarCollapsed && 'size-8 justify-center',
                )}
                aria-label={sidebarCollapsed ? 'piDeck — New session' : undefined}
                title={sidebarCollapsed ? 'piDeck — New session' : undefined}
                onClick={openNewSession}
                whileHover={{ x: 2 }}
                whileTap={{ scale: 0.98 }}
              >
                <motion.span
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
                  initial={{ opacity: 0, scale: 0.7, rotate: -15 }}
                  animate={{ opacity: 1, scale: 1, rotate: 0 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 24, delay: 0.15 }}
                >
                  <PiIcon className="size-4" />
                </motion.span>
                {sidebarCollapsed ? null : 'piDeck'}
              </motion.button>
              <div className="flex items-center gap-1">
                <motion.div layout initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}>
                  <Badge variant="outline" className={sidebarCollapsed ? 'sr-only' : undefined}>
                    Local
                  </Badge>
                </motion.div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-expanded={!sidebarCollapsed}
                  aria-controls="sidebar-sessions"
                  aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                  title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                  onClick={() => setSidebarCollapsed((current) => !current)}
                >
                  {sidebarCollapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
                </Button>
              </div>
            </motion.div>
            <motion.div
              className={cn('px-3 pb-3', sidebarCollapsed && 'px-2')}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.17, delay: 0.15 }}
            >
              <Button
                size={sidebarCollapsed ? 'icon' : 'default'}
                className={cn(
                  'w-full justify-start',
                  sidebarCollapsed && 'mx-auto w-auto justify-center px-0 md:w-full',
                )}
                aria-label="New session"
                title={sidebarCollapsed ? 'New session' : undefined}
                onClick={openNewSession}
              >
                <PlusIcon aria-hidden="true" />
                {sidebarCollapsed ? null : 'New session'}
              </Button>
            </motion.div>
            <Separator />
            {sidebarCollapsed ? null : (
              <motion.div
                className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.17, delay: 0.18 }}
              >
                Sessions
              </motion.div>
            )}
            <nav
              id="sidebar-sessions"
              className={cn(
                'flex min-w-0 flex-1 gap-1 overflow-x-auto p-2 md:flex-col md:overflow-y-auto',
                sidebarCollapsed && 'items-center',
              )}
              aria-label="Sessions"
            >
              <AnimatePresence initial={false} mode="popLayout">
                {runs.length === 0 ? (
                  <motion.p
                    key="empty-runs"
                    className={cn(
                      'hidden px-2 py-3 text-xs leading-5 text-muted-foreground md:block',
                      sidebarCollapsed && 'md:hidden',
                    )}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.16 }}
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
                        transition={{ duration: 0.16, delay: Math.min(index, 8) * 0.025 }}
                        className={cn(
                          'relative min-w-52 md:min-w-0',
                          sidebarCollapsed && 'min-w-0',
                        )}
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
                          size={sidebarCollapsed ? 'icon' : 'default'}
                          className={cn(
                            'relative z-10 h-auto min-w-52 justify-start px-2 py-2 text-left md:w-full md:min-w-0',
                            sidebarCollapsed && 'min-w-0 justify-center px-0 py-2',
                          )}
                          aria-label={
                            sidebarCollapsed
                              ? `${sessionTitle(candidate.prompt)} · ${titleCase(candidate.status)}`
                              : undefined
                          }
                          title={
                            sidebarCollapsed
                              ? `${sessionTitle(candidate.prompt)} · ${titleCase(candidate.status)}`
                              : undefined
                          }
                          onClick={() => setSelectedRunId(candidate.id)}
                        >
                          {sidebarCollapsed ? (
                            <span className="relative flex size-4 items-center justify-center">
                              <BotIcon className="size-4" aria-hidden="true" />
                              <span className="absolute -top-1 -right-1">
                                <RunDot status={candidate.status} />
                              </span>
                            </span>
                          ) : (
                            <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                              <span className="w-full truncate">
                                {sessionTitle(candidate.prompt)}
                              </span>
                              <span className="flex w-full items-center gap-1.5 text-xs font-normal text-muted-foreground">
                                <RunDot status={candidate.status} />
                                <span className="min-w-0 truncate">{agent?.name ?? 'Agent'}</span>
                                <span aria-hidden="true">·</span>
                                <span className="min-w-0 truncate">
                                  {modelDisplayName(candidate.model, models)}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span className="shrink-0">
                                  {formatRelativeDate(candidate.createdAt)}
                                </span>
                              </span>
                            </span>
                          )}
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
              transition={{ duration: 0.17, delay: 0.14 }}
            >
              <div className={cn('flex gap-1', sidebarCollapsed && 'flex-col')}>
                <Button
                  variant="ghost"
                  size={sidebarCollapsed ? 'icon' : 'default'}
                  className={cn(
                    'relative min-w-0 flex-1 justify-start',
                    sidebarCollapsed && 'w-full justify-center px-0',
                  )}
                  aria-label="Settings"
                  title={sidebarCollapsed ? 'Settings' : undefined}
                  onClick={() => setSettingsOpen(true)}
                >
                  <SettingsIcon aria-hidden="true" />
                  {sidebarCollapsed ? null : 'Settings'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-pressed={darkMode}
                  aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                  title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                  onClick={() => setDarkMode((current) => !current)}
                >
                  {darkMode ? <SunIcon /> : <MoonIcon />}
                </Button>
              </div>
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
                  transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
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
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Conversation
                    agent={selectedAgent}
                    run={run}
                    models={models}
                    transcript={transcript}
                    submitting={submitting}
                    runIsActive={runIsActive}
                    onCancel={cancelRun}
                    onSendMessage={followUpRun}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="new-session"
                  className="flex min-h-0 min-w-0 flex-1"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                >
                  <NewSession
                    agents={agents}
                    models={models}
                    projects={projects}
                    submitting={submitting}
                    onStart={startRun}
                    onDeleteProject={deleteProject}
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
            darkMode={darkMode}
            onDarkModeChange={setDarkMode}
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
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.div
        className="flex items-center gap-2"
        animate={reducedMotion ? { opacity: 1 } : { opacity: [0.55, 1, 0.55] }}
        transition={reducedMotion ? { duration: 0.01 } : { duration: 0.85, repeat: Infinity }}
      >
        <motion.span
          animate={reducedMotion ? undefined : { rotate: 360 }}
          transition={
            reducedMotion ? undefined : { duration: 0.85, repeat: Infinity, ease: 'linear' }
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
  projects,
  submitting,
  onStart,
  onDeleteProject,
  onOpenAgents,
}: {
  agents: ManagedAgentResponse[];
  models: ManagedAgentModelsResponse | undefined;
  projects: ManagedProjectResponse[];
  submitting: boolean;
  onStart(input: {
    agentId: string;
    prompt: string;
    model?: { provider: string; id: string };
    thinkingLevel: AgentThinkingLevel;
    cwd: string;
  }): Promise<void>;
  onDeleteProject(project: ManagedProjectResponse): Promise<boolean>;
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
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        <Empty className="border-0">
          <EmptyHeader>
            <motion.div
              initial={{ opacity: 0, scale: 0.75, rotate: -8 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 24, delay: 0.07 }}
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
              transition={{ duration: 0.17, delay: 0.14 }}
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
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.header
        className="flex min-h-16 items-center border-b px-5 py-3"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, delay: 0.06 }}
      >
        <div>
          <h1 className="font-semibold">New session</h1>
          <p className="text-sm text-muted-foreground">Configure a Pi run and describe the task.</p>
        </div>
      </motion.header>
      <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 py-10 md:px-8">
        <motion.form
          className="relative w-full max-w-4xl rounded-3xl border bg-card shadow-[0_18px_50px_-28px_oklch(0.145_0_0/0.35)]"
          initial={{ opacity: 0, y: 18, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.28, delay: 0.06, ease: [0.22, 1, 0.36, 1] }}
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
            className="flex flex-col rounded-b-3xl border-t bg-muted/25"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, delay: 0.14 }}
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
              <Separator orientation="vertical" className="hidden h-5 sm:block" />
              <ProjectPicker
                projects={projects}
                path={cwd}
                onPathChange={setCwd}
                onDeleteProject={onDeleteProject}
                disabled={submitting}
              />
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
          </motion.div>
        </motion.form>
      </div>
    </motion.div>
  );
}

function ProjectPicker({
  projects,
  path,
  onPathChange,
  onDeleteProject,
  disabled,
}: {
  projects: ManagedProjectResponse[];
  path: string;
  onPathChange(path: string): void;
  onDeleteProject(project: ManagedProjectResponse): Promise<boolean>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [draftPath, setDraftPath] = useState('');
  const [projectToDelete, setProjectToDelete] = useState<ManagedProjectResponse>();
  const pickerRef = useRef<HTMLDivElement>(null);
  const selectedProject = projects.find((project) => project.path === path);
  const selectedName = selectedProject?.name ?? projectNameFromPath(path);
  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(query) || project.path.toLowerCase().includes(query),
    );
  }, [projects, search]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selector = newProjectOpen ? '[data-project-path]' : '[data-project-search]';
    const input = pickerRef.current?.querySelector<HTMLInputElement>(selector);
    input?.focus();
  }, [open, newProjectOpen]);

  function selectProject(projectPath: string) {
    onPathChange(projectPath);
    setOpen(false);
    setSearch('');
  }

  function openNewProject() {
    setDraftPath('');
    setNewProjectOpen(true);
  }

  function useNewProject() {
    const value = draftPath.trim();
    if (!value) return;
    selectProject(value);
    setNewProjectOpen(false);
    setDraftPath('');
  }

  async function confirmDeleteProject() {
    if (!projectToDelete) return;
    const project = projectToDelete;
    const deleted = await onDeleteProject(project);
    if (!deleted) return;
    if (path === project.path) onPathChange('');
    setProjectToDelete(undefined);
  }

  return (
    <div ref={pickerRef} className="relative min-w-0">
      <Button
        type="button"
        variant="ghost"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Choose project"
        className="h-auto max-w-full justify-start gap-2 rounded-full bg-background/55 px-3 py-1.5 text-left hover:bg-background/85 dark:bg-background/30 dark:hover:bg-background/45"
        onClick={() => setOpen((current) => !current)}
      >
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate">
          <span className="font-medium">{selectedName}</span>
          <span className="ml-2 hidden font-mono text-[0.68rem] font-normal text-muted-foreground md:inline">
            {path}
          </span>
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Button>

      <AnimatePresence>
        {open ? (
          <motion.div
            role="dialog"
            aria-label="Choose project"
            className="absolute bottom-[calc(100%+8rem)] left-0 z-50 w-[min(34rem,calc(100vw-4rem))] md:bottom-[calc(100%+3.5rem)] overflow-hidden rounded-2xl border bg-popover p-2 text-popover-foreground shadow-[0_20px_60px_-24px_oklch(0.145_0_0/0.65)] ring-1 ring-foreground/8"
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          >
            {newProjectOpen ? (
              <div>
                <div className="flex items-center gap-2 px-2 pb-2 pt-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Back to saved projects"
                    onClick={() => setNewProjectOpen(false)}
                  >
                    <ChevronRightIcon className="rotate-180" />
                  </Button>
                  <div>
                    <p className="text-sm font-semibold">New project</p>
                    <p className="text-xs text-muted-foreground">
                      Add a workspace to your project list.
                    </p>
                  </div>
                </div>
                <div className="space-y-2 border-t px-2 pb-2 pt-3">
                  <label
                    htmlFor="new-project-path"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Working directory
                  </label>
                  <input
                    id="new-project-path"
                    data-project-path
                    value={draftPath}
                    onChange={(event) => setDraftPath(event.target.value)}
                    placeholder="/path/to/project"
                    className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  />
                  <p className="text-[0.7rem] leading-4 text-muted-foreground">
                    It will be saved when you start the session.
                  </p>
                </div>
                <div className="flex justify-end gap-2 border-t px-2 pb-1 pt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setNewProjectOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!draftPath.trim()}
                    onClick={useNewProject}
                  >
                    Use project
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 rounded-xl bg-muted/65 px-3 py-2">
                  <SearchIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <input
                    data-project-search
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search projects"
                    aria-label="Search projects"
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                  <kbd className="hidden rounded border bg-background px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground sm:inline">
                    /
                  </kbd>
                </div>
                <div
                  className="max-h-64 overflow-y-auto py-1"
                  role="listbox"
                  aria-label="Saved projects"
                >
                  {filteredProjects.length > 0 ? (
                    filteredProjects.map((project) => (
                      <div
                        key={project.id}
                        role="option"
                        tabIndex={-1}
                        aria-selected={project.path === path}
                        className="group flex w-full items-center gap-1 rounded-xl p-1 transition-colors aria-selected:bg-accent"
                      >
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
                          onClick={() => selectProject(project.path)}
                        >
                          <FolderIcon
                            className="size-5 shrink-0 text-muted-foreground group-hover:text-current"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {project.name}
                            </span>
                            <span className="block truncate font-mono text-[0.68rem] text-muted-foreground group-hover:text-current/70">
                              {project.path}
                            </span>
                          </span>
                          {project.path === path ? (
                            <CheckCircle2Icon
                              className="size-4 shrink-0 text-primary"
                              aria-label="Selected"
                            />
                          ) : null}
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete project ${project.name}`}
                          title="Delete project"
                          className="shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => setProjectToDelete(project)}
                        >
                          <Trash2Icon className="size-4" aria-hidden="true" />
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="px-3 py-5 text-center text-xs text-muted-foreground">
                      {projects.length === 0 ? 'No saved projects yet.' : 'No matching projects.'}
                    </p>
                  )}
                </div>
                <div className="border-t pt-1">
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
                    onClick={openNewProject}
                  >
                    <span className="flex size-5 items-center justify-center rounded-md border border-dashed border-muted-foreground/70">
                      <PlusIcon className="size-3.5" aria-hidden="true" />
                    </span>
                    New project
                  </button>
                </div>
              </>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
      <Dialog
        open={projectToDelete !== undefined}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !disabled) setProjectToDelete(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete saved project?</DialogTitle>
            <DialogDescription>
              {projectToDelete
                ? `Remove “${projectToDelete.name}” from the project picker. Files on disk will not be changed.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={disabled}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={() => void confirmDeleteProject()}
            >
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function projectNameFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Choose project';
}

type ChatAttachment = {
  id: string;
  file: File;
  previewUrl?: string;
};

function createAttachmentPreview(file: File): string | undefined {
  if (!file.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') {
    return undefined;
  }
  return URL.createObjectURL(file);
}

function revokeAttachmentPreview(attachment: ChatAttachment): void {
  if (attachment.previewUrl && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function attachmentTypeLabel(file: File): string {
  const extension = file.name.split('.').pop();
  if (extension && extension !== file.name) return extension.toUpperCase();
  if (file.type) {
    const [, subtype] = file.type.split('/');
    if (subtype) return subtype.toUpperCase();
  }
  return 'FILE';
}

function attachmentIcon(file: File) {
  if (file.type.startsWith('text/') || file.type === 'application/pdf') {
    return <FileTextIcon aria-hidden="true" />;
  }
  return <FileIcon aria-hidden="true" />;
}

function hasFileDragPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files');
}

function Conversation({
  agent,
  run,
  models,
  transcript,
  submitting,
  runIsActive,
  onCancel,
  onSendMessage,
}: {
  agent: ManagedAgentResponse | undefined;
  run: ManagedAgentRunResponse;
  models: ManagedAgentModelsResponse | undefined;
  transcript: ReturnType<typeof mapPiEvents>;
  submitting: boolean;
  runIsActive: boolean;
  onCancel(): Promise<void>;
  onSendMessage(message: string): Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const attachmentSequenceRef = useRef(0);
  const attachmentsRef = useRef(attachments);
  const canChat = run.status === 'queued' || run.status === 'running' || run.status === 'completed';

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(revokeAttachmentPreview);
    };
  }, []);

  function addFiles(fileList: FileList | File[]) {
    const nextAttachments = Array.from(fileList).map((file) => ({
      id: `attachment-${attachmentSequenceRef.current++}`,
      file,
      previewUrl: createAttachmentPreview(file),
    }));
    if (nextAttachments.length > 0) setAttachments((current) => [...current, ...nextAttachments]);
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    if (event.currentTarget.files) addFiles(event.currentTarget.files);
    event.currentTarget.value = '';
  }

  function removeAttachment(id: string) {
    const attachment = attachments.find((item) => item.id === id);
    if (attachment) revokeAttachmentPreview(attachment);
    setAttachments((current) => current.filter((item) => item.id !== id));
  }

  function clearAttachments() {
    attachmentsRef.current.forEach(revokeAttachmentPreview);
    setAttachments([]);
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    addFiles(event.dataTransfer.files);
  }

  async function submitMessage(event: FormEvent) {
    event.preventDefault();
    const value = message.trim();
    if ((!value && attachments.length === 0) || submitting || !canChat) return;
    try {
      await onSendMessage(value || 'Please inspect the attached file.');
      setMessage('');
      clearAttachments();
    } catch {
      // Keep the draft and attachments visible while the app-level error explains what failed.
    }
  }

  return (
    <motion.div
      role="region"
      aria-label="Chat area"
      className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.header
        className="flex min-h-16 items-center justify-between gap-4 border-b px-5 py-3"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, delay: 0.06 }}
      >
        <motion.div
          className="min-w-0"
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.16, delay: 0.07 }}
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
          transition={{ duration: 0.16, delay: 0.11 }}
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
      <AnimatePresence>
        {dragActive ? (
          <motion.div
            className="pointer-events-none absolute inset-x-3 top-20 bottom-3 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/90 px-6 text-center shadow-lg"
            role="status"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
          >
            <div>
              <p className="font-medium">Drop files to attach</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Images and other file types are supported
              </p>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport aria-label={`${agent?.name ?? 'Agent'} conversation`}>
            <MessageScrollerContent className="mx-auto w-[calc(100vw-2.5rem)] max-w-3xl px-5 py-8 md:w-full md:px-8">
              <MessageScrollerItem messageId={`prompt-${run.id}`} scrollAnchor>
                <motion.div
                  layout="position"
                  initial={{ opacity: 0, y: 14, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
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
                  transition={{ duration: 0.18, delay: 0.06, ease: [0.22, 1, 0.36, 1] }}
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
                      transition={{ duration: 0.14 }}
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
        {canChat ? (
          <motion.form
            aria-label="Chat with agent"
            className="border-t bg-background px-4 py-3 md:px-6"
            onSubmit={submitMessage}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div className="mx-auto flex max-w-3xl flex-col gap-2">
              {attachments.length > 0 ? (
                <AttachmentGroup aria-label="Attached files">
                  {attachments.map((attachment) => {
                    const isImage = attachment.file.type.startsWith('image/');
                    return (
                      <Attachment
                        key={attachment.id}
                        state="done"
                        size="sm"
                        orientation={isImage ? 'vertical' : 'horizontal'}
                      >
                        <AttachmentMedia variant={isImage ? 'image' : 'icon'}>
                          {isImage && attachment.previewUrl ? (
                            <img src={attachment.previewUrl} alt={attachment.file.name} />
                          ) : isImage ? (
                            <ImageIcon aria-hidden="true" />
                          ) : (
                            attachmentIcon(attachment.file)
                          )}
                        </AttachmentMedia>
                        <AttachmentContent>
                          <AttachmentTitle>{attachment.file.name}</AttachmentTitle>
                          <AttachmentDescription>
                            {attachmentTypeLabel(attachment.file)} {'·'}
                            {formatFileSize(attachment.file.size)}
                          </AttachmentDescription>
                        </AttachmentContent>
                        <AttachmentActions>
                          <AttachmentAction
                            type="button"
                            aria-label={`Remove ${attachment.file.name}`}
                            onClick={() => removeAttachment(attachment.id)}
                          >
                            <XIcon />
                          </AttachmentAction>
                        </AttachmentActions>
                      </Attachment>
                    );
                  })}
                </AttachmentGroup>
              ) : null}
              <div className="flex items-end gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="sr-only"
                  aria-label="Files to attach"
                  onChange={handleFileInput}
                  tabIndex={-1}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Attach files"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={submitting}
                  className="self-center"
                >
                  <PaperclipIcon />
                </Button>
                <Textarea
                  aria-label="Message agent"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Send a message to Pi…"
                  disabled={submitting}
                  rows={1}
                  className="max-h-32 min-h-10 resize-none rounded-2xl bg-muted/40 py-2.5 shadow-none focus-visible:ring-2"
                />
                <Button
                  type="submit"
                  size="icon-lg"
                  className="shrink-0 rounded-full"
                  disabled={submitting || (!message.trim() && attachments.length === 0)}
                >
                  <ArrowUpIcon />
                  <span className="sr-only">Send message</span>
                </Button>
              </div>
            </div>
            <p className="mx-auto mt-1.5 max-w-3xl px-1 text-[11px] text-muted-foreground">
              Drop files anywhere in chat · Enter to send · Shift+Enter for a new line
            </p>
          </motion.form>
        ) : null}
      </MessageScrollerProvider>
    </motion.div>
  );
}

function AgentSettingsDialog({
  open,
  onOpenChange,
  agents,
  submitting,
  darkMode,
  onDarkModeChange,
  onCreate,
  onUpdate,
  onDelete,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  agents: ManagedAgentResponse[];
  submitting: boolean;
  darkMode: boolean;
  onDarkModeChange(darkMode: boolean): void;
  onCreate(name: string, systemPrompt: string): Promise<ManagedAgentResponse | undefined>;
  onUpdate(agentId: string, name: string, systemPrompt: string): Promise<void>;
  onDelete(agentId: string): Promise<void>;
}) {
  const [editing, setEditing] = useState<string | 'new'>();
  const [section, setSection] = useState<SettingsSection>('agents');
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
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <motion.aside
              className="border-b bg-muted/25 p-4 md:border-r md:border-b-0"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.16, delay: 0.06 }}
            >
              <h2 className="px-2 text-lg font-semibold tracking-tight">Settings</h2>
              <nav className="mt-4 flex flex-col gap-1" aria-label="Settings sections">
                <Button
                  variant={section === 'appearance' ? 'secondary' : 'ghost'}
                  className="w-full justify-start"
                  aria-current={section === 'appearance' ? 'page' : undefined}
                  onClick={() => setSection('appearance')}
                >
                  <SunIcon data-icon="inline-start" />
                  Appearance
                </Button>
                <Button
                  variant={section === 'agents' ? 'secondary' : 'ghost'}
                  className="w-full justify-start"
                  aria-current={section === 'agents' ? 'page' : undefined}
                  onClick={() => setSection('agents')}
                >
                  <BotIcon data-icon="inline-start" />
                  Agents
                  <Badge variant="outline" className="ml-auto">
                    {agents.length}
                  </Badge>
                </Button>
                <Button
                  variant={section === 'skills' ? 'secondary' : 'ghost'}
                  className="w-full justify-start"
                  aria-current={section === 'skills' ? 'page' : undefined}
                  onClick={() => setSection('skills')}
                >
                  <BookOpenIcon data-icon="inline-start" />
                  Skills
                  <Badge variant="outline" className="ml-auto">
                    {AVAILABLE_SKILLS.length}
                  </Badge>
                </Button>
                <Button
                  variant={section === 'extensions' ? 'secondary' : 'ghost'}
                  className="w-full justify-start"
                  aria-current={section === 'extensions' ? 'page' : undefined}
                  onClick={() => setSection('extensions')}
                >
                  <PuzzleIcon data-icon="inline-start" />
                  Extensions
                  <Badge variant="outline" className="ml-auto">
                    {INSTALLED_EXTENSIONS.length}
                  </Badge>
                </Button>
              </nav>
            </motion.aside>
            <motion.section
              className="min-h-0 overflow-y-auto p-5 md:p-8"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.18, delay: 0.07 }}
            >
              {section === 'agents' ? (
                <div className="mx-auto flex max-w-3xl flex-col gap-6">
                  <motion.div
                    className="flex items-start justify-between gap-4 pr-8"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.16, delay: 0.07 }}
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
                      transition={{ duration: 0.16, delay: 0.14 }}
                    >
                      <Empty className="min-h-72 border">
                        <EmptyHeader>
                          <motion.div
                            initial={{ opacity: 0, scale: 0.75, rotate: -8 }}
                            animate={{ opacity: 1, scale: 1, rotate: 0 }}
                            transition={{
                              type: 'spring',
                              stiffness: 420,
                              damping: 24,
                              delay: 0.11,
                            }}
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
                            transition={{ duration: 0.14, delay: 0.14 }}
                          >
                            <Button onClick={() => setEditing('new')}>
                              Create your first agent
                            </Button>
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
                      transition={{ duration: 0.16, delay: 0.14 }}
                    >
                      <AnimatePresence initial={false} mode="popLayout">
                        {agents.map((agent, index) => (
                          <motion.div
                            key={agent.id}
                            layout
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -10 }}
                            transition={{ duration: 0.16, delay: Math.min(index, 6) * 0.03 }}
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
              ) : section === 'skills' ? (
                <SkillsSettingsPage />
              ) : section === 'appearance' ? (
                <AppearanceSettingsPage darkMode={darkMode} onDarkModeChange={onDarkModeChange} />
              ) : (
                <ExtensionsSettingsPage />
              )}
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

function AppearanceSettingsPage({
  darkMode,
  onDarkModeChange,
}: {
  darkMode: boolean;
  onDarkModeChange(darkMode: boolean): void;
}) {
  return (
    <motion.div
      className="mx-auto flex max-w-3xl flex-col gap-6"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
    >
      <div>
        <h3 className="text-xl font-semibold tracking-tight">Appearance</h3>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          Choose the color theme that feels best for your workspace. Your preference is saved in
          this browser.
        </p>
      </div>

      <div className="rounded-xl border p-4">
        <div>
          <h4 className="font-medium">Color theme</h4>
          <p className="mt-1 text-sm text-muted-foreground">
            Switch between a bright canvas and a focused dark workspace.
          </p>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Color theme">
          <Button
            type="button"
            role="radio"
            aria-checked={!darkMode}
            variant={!darkMode ? 'secondary' : 'outline'}
            className="h-auto justify-start gap-3 p-3 text-left"
            onClick={() => onDarkModeChange(false)}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <SunIcon className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block font-medium">Light</span>
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                A bright, open workspace
              </span>
            </span>
          </Button>
          <Button
            type="button"
            role="radio"
            aria-checked={darkMode}
            variant={darkMode ? 'secondary' : 'outline'}
            className="h-auto justify-start gap-3 p-3 text-left"
            onClick={() => onDarkModeChange(true)}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <MoonIcon className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block font-medium">Dark</span>
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                Easier on the eyes at night
              </span>
            </span>
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

function SkillsSettingsPage() {
  const [selectedSkill, setSelectedSkill] = useState<(typeof AVAILABLE_SKILLS)[number]>();

  return (
    <>
      <motion.div
        className="mx-auto flex max-w-3xl flex-col gap-6"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="flex items-start justify-between gap-4 pr-8">
          <div>
            <h3 className="text-xl font-semibold tracking-tight">Skills</h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              Skills available to Pi for focused workflows. Select one to browse its files and
              preview the instructions.
            </p>
          </div>
          <Badge variant="outline" className="mt-1 shrink-0">
            {AVAILABLE_SKILLS.length} available
          </Badge>
        </div>

        <div
          className="overflow-hidden rounded-xl border"
          aria-label="Available skills"
          role="list"
        >
          {AVAILABLE_SKILLS.map((skill, index) => (
            <div key={skill.name} role="listitem">
              {index > 0 ? <Separator /> : null}
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-4 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50"
                onClick={() => setSelectedSkill(skill)}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <BookOpenIcon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{skill.name}</span>
                  <span className="mt-0.5 block text-sm leading-5 text-muted-foreground">
                    {skill.description}
                  </span>
                </span>
                <Badge variant="outline" className="hidden shrink-0 sm:inline-flex">
                  {skill.files.length} files
                </Badge>
              </button>
            </div>
          ))}
        </div>
      </motion.div>

      <SkillViewerDialog
        skill={selectedSkill}
        open={selectedSkill !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelectedSkill(undefined);
        }}
      />
    </>
  );
}

function SkillViewerDialog({
  skill,
  open,
  onOpenChange,
}: {
  skill: (typeof AVAILABLE_SKILLS)[number] | undefined;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {skill ? <SkillViewerContent key={skill.name} skill={skill} /> : null}
    </Dialog>
  );
}

function SkillViewerContent({ skill }: { skill: (typeof AVAILABLE_SKILLS)[number] }) {
  const [selectedFileName, setSelectedFileName] = useState(skill.files[0].name);
  const selectedFile = skill.files.find((file) => file.name === selectedFileName) ?? skill.files[0];
  const isMarkdown = selectedFile.name.toLowerCase().endsWith('.md');

  return (
    <DialogContent className="h-[min(52rem,calc(100svh-2rem))] max-w-[min(72rem,calc(100vw-2rem))] overflow-hidden p-0 sm:max-w-[min(72rem,calc(100vw-2rem))]">
      <DialogTitle className="sr-only">{skill.name}</DialogTitle>
      <DialogDescription className="sr-only">
        Browse the files in the {skill.name} skill and preview their markdown contents.
      </DialogDescription>
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[16rem_minmax(0,1fr)] md:grid-rows-1">
        <aside className="min-h-0 border-b bg-muted/20 p-4 md:border-r md:border-b-0">
          <div className="px-2">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Skill files
            </p>
            <h2 className="mt-2 truncate font-semibold">{skill.name}</h2>
          </div>
          <nav
            className="mt-4 flex max-h-32 flex-wrap gap-1 overflow-y-auto md:max-h-none md:flex-col md:overflow-visible"
            aria-label={`Files in ${skill.name}`}
          >
            {skill.files.map((file) => (
              <button
                type="button"
                key={file.name}
                className={cn(
                  'flex min-w-0 max-w-full items-center rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 md:w-full',
                  selectedFile.name === file.name
                    ? 'bg-secondary font-medium text-secondary-foreground'
                    : 'text-muted-foreground',
                )}
                aria-current={selectedFile.name === file.name ? 'page' : undefined}
                onClick={() => setSelectedFileName(file.name)}
              >
                <span className="truncate">{file.name}</span>
              </button>
            ))}
          </nav>
        </aside>
        <section className="min-h-0 overflow-y-auto bg-background p-5 md:p-8">
          <div className="mx-auto max-w-3xl">
            <div className="mb-6 flex flex-wrap items-center gap-2 border-b pb-4 pr-8">
              <span className="font-mono text-xs text-muted-foreground">{skill.name}</span>
              <span className="text-xs text-muted-foreground/60">/</span>
              <span className="font-mono text-xs font-medium">{selectedFile.name}</span>
              <Badge variant="outline" className="ml-auto">
                {isMarkdown ? 'Markdown' : 'Plain text'}
              </Badge>
            </div>
            {isMarkdown ? (
              <MarkdownContent content={selectedFile.content} variant="preview" />
            ) : (
              <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-xl border bg-muted/30 p-4 font-mono text-xs leading-6 text-muted-foreground">
                {selectedFile.content}
              </pre>
            )}
          </div>
        </section>
      </div>
    </DialogContent>
  );
}

function ExtensionsSettingsPage() {
  const [updatedExtensions, setUpdatedExtensions] = useState<Set<string>>(() => new Set());
  const updateCount = INSTALLED_EXTENSIONS.filter(
    (extension) =>
      extension.version !== extension.latestVersion && !updatedExtensions.has(extension.id),
  ).length;

  return (
    <motion.div
      className="mx-auto flex max-w-3xl flex-col gap-6"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex items-start justify-between gap-4 pr-8">
        <div>
          <h3 className="text-xl font-semibold tracking-tight">Extensions</h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Extensions already installed in this Pi environment. Keep them current from here.
          </p>
        </div>
        <Badge variant={updateCount > 0 ? 'secondary' : 'outline'} className="mt-1 shrink-0">
          {updateCount > 0 ? `${updateCount} update${updateCount === 1 ? '' : 's'}` : 'All current'}
        </Badge>
      </div>

      <div
        className="overflow-hidden rounded-xl border"
        aria-label="Installed extensions"
        role="list"
      >
        {INSTALLED_EXTENSIONS.map((extension, index) => {
          const isCurrent =
            extension.version === extension.latestVersion || updatedExtensions.has(extension.id);

          return (
            <div key={extension.id} role="listitem">
              {index > 0 ? <Separator /> : null}
              <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <PuzzleIcon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{extension.name}</span>
                  <span className="mt-0.5 block text-sm leading-5 text-muted-foreground">
                    {extension.description}
                  </span>
                  <span className="mt-1 block font-mono text-xs text-muted-foreground">
                    v{extension.version}
                    {!isCurrent ? ` · v${extension.latestVersion} available` : ''}
                  </span>
                </span>
                <span className="flex shrink-0 items-center justify-end">
                  {isCurrent ? (
                    <Badge
                      variant="outline"
                      className="gap-1 text-emerald-700 dark:text-emerald-400"
                    >
                      <CheckCircle2Icon aria-hidden="true" />
                      Up to date
                    </Badge>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setUpdatedExtensions((current) => new Set(current).add(extension.id))
                      }
                    >
                      <DownloadIcon data-icon="inline-start" />
                      Update
                    </Button>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </motion.div>
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
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
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
            transition={{ duration: 0.14, delay: 0.06 }}
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
            transition={{ duration: 0.14, delay: 0.09 }}
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
    duration: 0.18,
    delay: Math.min(index, 6) * 0.025,
    ease: [0.22, 1, 0.36, 1] as const,
  };

  if (item.kind === 'assistant' || item.kind === 'user') {
    return (
      <MessageScrollerItem messageId={item.id}>
        <motion.div
          layout="position"
          initial={{ opacity: 0, y: 12, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={transition}
        >
          <Message align={item.kind === 'user' ? 'end' : 'start'}>
            <MessageContent>
              <MessageHeader>{item.kind === 'user' ? 'You' : 'PI'}</MessageHeader>
              <Bubble
                align={item.kind === 'user' ? 'end' : 'start'}
                variant={item.kind === 'user' ? 'default' : 'muted'}
              >
                <BubbleContent>
                  <MarkdownContent content={item.content} />
                </BubbleContent>
              </Bubble>
              <MessageFooter>{formatTime(item.createdAt)}</MessageFooter>
            </MessageContent>
          </Message>
        </motion.div>
      </MessageScrollerItem>
    );
  }

  if (item.kind === 'event-group') {
    return <EventGroupRow item={item} transition={transition} />;
  }

  if (item.kind !== 'marker' && item.kind !== 'error') return null;

  return (
    <MessageScrollerItem messageId={item.id}>
      <motion.div
        layout="position"
        initial={{ opacity: 0, y: 8, scaleX: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={transition}
      >
        <EventMarker item={item} />
      </motion.div>
    </MessageScrollerItem>
  );
}

function EventGroupRow({
  item,
  transition,
}: {
  item: Extract<ReturnType<typeof mapPiEvents>[number], { kind: 'event-group' }>;
  transition: { duration: number; delay: number; ease: readonly [number, number, number, number] };
}) {
  const [expanded, setExpanded] = useState(false);
  const hasError = item.events.some((event) => event.kind === 'error');
  const summary = item.events.at(-1);
  const visibleEvents = collapseThinkingMarkers(item.events);

  return (
    <MessageScrollerItem messageId={item.id}>
      <motion.div
        layout="position"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transition}
      >
        <button
          type="button"
          className="group/event flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronRightIcon
            className="size-3.5 shrink-0 transition-transform duration-150 group-aria-expanded/event:rotate-90"
            aria-hidden="true"
          />
          <span className={hasError ? 'text-destructive' : 'text-foreground'}>
            {item.events.length} events
          </span>
          <span className="min-w-0 truncate">{summary?.label ?? 'Activity'}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground/70">
            {formatTime(item.createdAt)}
          </span>
        </button>
        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.14 }}
              className="mt-2 flex flex-col gap-4 pl-5"
            >
              {visibleEvents.map((event) => (
                <EventMarker key={event.id} item={event} />
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </MessageScrollerItem>
  );
}

function formatToolArguments(value: JsonValue | undefined): string {
  if (value === undefined) return 'No arguments provided';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function EventMarker({ item }: { item: TranscriptEvent }) {
  const marker = (
    <Marker
      variant={item.variant}
      className={item.kind === 'marker' && item.toolCall ? 'w-auto flex-1' : undefined}
      role={item.kind === 'marker' && item.shimmer && !item.toolCall ? 'status' : undefined}
    >
      <MarkerContent
        className={cn(
          item.kind === 'error' && 'text-destructive',
          item.kind === 'marker' && item.shimmer && 'shimmer',
        )}
      >
        {item.label}
        {item.detail ? ` · ${item.detail}` : ''}
      </MarkerContent>
    </Marker>
  );

  if (item.kind !== 'marker' || !item.toolCall) return marker;

  return (
    <Accordion type="single" collapsible className="w-full">
      <AccordionItem value={item.id} className="border-b-0">
        <AccordionTrigger className="rounded-md py-1 hover:no-underline">{marker}</AccordionTrigger>
        <AccordionContent className="pl-6">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Arguments</p>
          <pre
            aria-label="Tool call arguments"
            className="overflow-x-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words"
          >
            {formatToolArguments(item.toolArguments)}
          </pre>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
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
        active && !reducedMotion ? { duration: 1.1, repeat: Infinity } : { duration: 0.18 }
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
