import type {
  AgentImageAttachment,
  AgentModel,
  AgentThinkingLevel,
  JsonValue,
  ManagedAgentEvent,
  ManagedAgentExtension,
  ManagedAgentExtensionsResponse,
  ManagedAgentModelsResponse,
  ManagedAgentResponse,
  ManagedAgentRunResponse,
  ManagedProjectResponse,
} from '@nextflow/contracts';
import { ManagedAgentRunResponseSchema } from '@nextflow/contracts';
import {
  ArchiveIcon,
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
  GitBranchIcon,
  ImageIcon,
  LoaderCircleIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  PuzzleIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SparklesIcon,
  GitForkIcon,
  FileDiffIcon,
  SquareTerminalIcon,
  SunIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type SVGProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { ComposerInput } from '@/components/composer-input';
import {
  ChangesPanel,
  CommandPalette,
  FleetOverview,
  InboxView,
  TerminalPanel,
  WorktreeManager,
  type ServerOperationsClient,
} from '@/components/operations';
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
  AttachmentTrigger,
} from '@/components/ui/attachment';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ApiError } from '@/lib/api-error';
import {
  type ServerConnectionManager,
  type ServerDefinition,
  type ServerInput,
  serverConnectionManager,
} from '@/lib/server-connections';
import { AVAILABLE_SKILLS } from '@/lib/skills';
import {
  modelDisplayName,
  type StreamConnectionState,
  type SupervisorClient,
  supervisorClient,
} from '@/lib/supervisor-client';
import {
  collapseThinkingMarkers,
  mapPiEvents,
  mergeTranscriptEvents,
  prependTranscriptEvents,
  TRANSCRIPT_EVENT_WINDOW,
  type TranscriptEvent,
} from '@/lib/transcript';
import { LruCache } from '@/lib/lru';
import {
  beginSubmission,
  completeSubmission,
  isUncertainSubmissionError,
  markSubmissionFailed,
  markSubmissionUncertain,
  readSubmissions,
  rememberSubmissionReceipt,
  type SubmissionRecord,
} from '@/lib/submissions';
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

const TASK_STARTERS = [
  {
    label: 'Understand this codebase',
    prompt:
      'Inspect this codebase and explain its architecture, important modules, and current risks.',
  },
  {
    label: 'Review current changes',
    prompt:
      'Review the current changes for correctness, regressions, and missing tests. Report findings before editing.',
  },
  {
    label: 'Fix a failing check',
    prompt:
      'Run the relevant checks, diagnose the first failure, fix its root cause, and verify the result.',
  },
] as const;

type SettingsSection = 'servers' | 'agents' | 'projects' | 'skills' | 'extensions' | 'appearance';

type AppLayout = 'sidebar' | 'tabs';

const THEME_STORAGE_KEY = 'pideck-theme';
const LAYOUT_STORAGE_KEY = 'pideck-layout';
const SIDEBAR_STORAGE_KEY = 'pideck-sidebar-collapsed';
const ARCHIVED_RUNS_STORAGE_KEY = 'pideck-archived-runs';
const RUN_ATTACHMENT_CACHE_LIMIT = 24;
const LATEST_TRANSCRIPT_PAGE_SIZE = 500;

type AppRoute =
  | { kind: 'default' }
  | { kind: 'fleet' }
  | { kind: 'inbox' }
  | { kind: 'worktrees' }
  | { kind: 'new' }
  | { kind: 'session'; serverId?: string; runId: string };

interface ServerSnapshot {
  readonly server: ServerDefinition;
  readonly client: SupervisorClientApi;
  readonly agents: ManagedAgentResponse[];
  readonly models: ManagedAgentModelsResponse | undefined;
  readonly runs: ManagedAgentRunResponse[];
  readonly projects: ManagedProjectResponse[];
  readonly resources: Record<SnapshotResource, SnapshotResourceState>;
  readonly historyCursor: string | null;
}

type SnapshotResource = 'agents' | 'runs' | 'projects' | 'models';
interface SnapshotResourceState {
  readonly status: 'live' | 'stale' | 'failed';
  readonly checkedAt: string;
  readonly error?: string;
}

interface ServerSession {
  readonly serverId: string;
  readonly run: ManagedAgentRunResponse;
}

function readAppRoute(): AppRoute {
  if (typeof window === 'undefined') return { kind: 'default' };

  const serverMatch = window.location.pathname.match(/^\/servers\/([^/]+)\/sessions\/([^/]+)\/?$/);
  if (serverMatch?.[1] && serverMatch[2]) {
    try {
      return {
        kind: 'session',
        serverId: decodeURIComponent(serverMatch[1]),
        runId: decodeURIComponent(serverMatch[2]),
      };
    } catch {
      return { kind: 'default' };
    }
  }

  const legacyMatch = window.location.pathname.match(/^\/sessions\/([^/]+)\/?$/);
  if (legacyMatch?.[1]) {
    try {
      return { kind: 'session', runId: decodeURIComponent(legacyMatch[1]) };
    } catch {
      return { kind: 'default' };
    }
  }

  if (window.location.pathname === '/fleet') return { kind: 'fleet' };
  if (window.location.pathname === '/inbox') return { kind: 'inbox' };
  if (window.location.pathname === '/worktrees') return { kind: 'worktrees' };
  return window.location.pathname === '/new' ? { kind: 'new' } : { kind: 'default' };
}

function writeAppRoute(route: AppRoute, replace = false) {
  if (typeof window === 'undefined') return;

  const path =
    route.kind === 'session'
      ? route.serverId
        ? `/servers/${encodeURIComponent(route.serverId)}/sessions/${encodeURIComponent(route.runId)}`
        : `/sessions/${encodeURIComponent(route.runId)}`
      : route.kind === 'new'
        ? '/new'
        : route.kind === 'fleet'
          ? '/fleet'
          : route.kind === 'inbox'
            ? '/inbox'
            : route.kind === 'worktrees'
              ? '/worktrees'
              : '/';
  if (window.location.pathname === path) return;

  const method = replace ? 'replaceState' : 'pushState';
  window.history[method]({}, '', path);
}

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

function modelProvider(model: AgentModel | null | undefined): string {
  return model?.provider.trim().toLowerCase() ?? '';
}

function modelAvatarTone(provider: string): string {
  if (provider.includes('openai'))
    return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  if (provider.includes('anthropic') || provider.includes('claude')) {
    return 'bg-orange-500/15 text-orange-700 dark:text-orange-300';
  }
  if (provider.includes('google') || provider.includes('gemini')) {
    return 'bg-blue-500/15 text-blue-700 dark:text-blue-300';
  }
  if (provider.includes('mistral')) return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  if (provider.includes('xai') || provider.includes('grok')) {
    return 'bg-slate-500/15 text-slate-700 dark:text-slate-300';
  }
  if (provider.includes('deepseek')) return 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300';
  if (provider.includes('meta') || provider.includes('llama')) {
    return 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300';
  }
  return 'bg-muted text-muted-foreground';
}

function ModelLogo({ provider }: { provider: string }) {
  const className = 'size-4 shrink-0';
  if (provider.includes('openai')) {
    return (
      <svg className={className} viewBox="0 0 256 260" fill="currentColor" aria-hidden="true">
        <path d="M239.184 106.203a64.72 64.72 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.72 64.72 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.67 64.67 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.77 64.77 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483m-97.56 136.338a48.4 48.4 0 0 1-31.105-11.255l1.535-.87l51.67-29.825a8.6 8.6 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601M37.158 197.93a48.35 48.35 0 0 1-5.781-32.589l1.534.921l51.722 29.826a8.34 8.34 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803M23.549 85.38a48.5 48.5 0 0 1 25.58-21.333v61.39a8.29 8.29 0 0 0 4.195 7.316l62.874 36.272l-21.845 12.636a.82.82 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405zm179.466 41.695l-63.08-36.63L161.73 77.86a.82.82 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.54 8.54 0 0 0-4.4-7.213m21.742-32.69l-1.535-.922l-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.72.72 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391zM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87l-51.67 29.825a8.6 8.6 0 0 0-4.246 7.367zm11.868-25.58L128.067 97.3l28.188 16.218v32.434l-28.086 16.218l-28.188-16.218z" />
      </svg>
    );
  }
  if (provider.includes('anthropic') || provider.includes('claude')) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
      </svg>
    );
  }
  if (provider.includes('google') || provider.includes('gemini')) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 1.5c.6 5.3 3.2 8 8.5 8.5-5.3.6-7.9 3.2-8.5 8.5-.6-5.3-3.2-7.9-8.5-8.5C8.8 9.5 11.4 6.8 12 1.5Z" />
      </svg>
    );
  }
  if (provider.includes('mistral')) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z" />
      </svg>
    );
  }
  if (provider.includes('xai') || provider.includes('grok')) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
      </svg>
    );
  }
  if (provider.includes('deepseek')) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254 1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45Z" />
      </svg>
    );
  }
  if (provider.includes('meta') || provider.includes('llama')) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973.056.3.145.588.265.86.101.27.225.524.371.761.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325.183.3 2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843.32-.27.59-.6.81-.973.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.923-2.93-1.497 0-2.633.671-3.965 2.444-.76 1.012-1.144 1.626-2.663 4.32l-.756 1.339-.186.325-.183-.3L9.01 7.54C8.286 6.33 7.345 4.984 6.54 4.227 5.494 3.24 4.548 4.03 6.915 4.03Zm-.037 12.02c-.67 0-1.164-.342-1.55-1.014-.264-.46-.45-1.1-.45-1.91 0-1.09.3-2.26.84-3.205.49-.86 1.077-1.28 1.768-1.28.676 0 1.1.305 1.58.876.45.535 1.03 1.46 1.77 2.7l.3.5c-1.145 2.03-1.47 2.54-1.94 3.165-.803 1.07-1.42 1.168-2.318 1.168Zm10.49 0c-.691 0-1.278-.42-1.768-1.28-.54-.946-.84-2.116-.84-3.206 0-.81.186-1.45.45-1.91.386-.672.88-1.014 1.55-1.014.899 0 1.515.098 2.318 1.168.47.625.795 1.136 1.94 3.165l-.3.5c-.74 1.24-1.32 2.165-1.77 2.7-.48.571-.904.876-1.58.876Z" />
      </svg>
    );
  }
  return <BotIcon className={className} aria-hidden="true" />;
}

function SessionAvatar({
  model,
  models,
  className,
}: {
  model: AgentModel | null | undefined;
  models: ManagedAgentModelsResponse | undefined;
  className?: string;
}) {
  const effectiveModel = model ?? models?.defaultModel;
  const provider = modelProvider(effectiveModel);

  return (
    <Avatar aria-hidden="true" className={cn('size-8', modelAvatarTone(provider), className)}>
      <AvatarFallback className={cn('size-full', modelAvatarTone(provider), className)}>
        <ModelLogo provider={provider} />
      </AvatarFallback>
    </Avatar>
  );
}

function normalizePath(value: string): string {
  const normalized = value.replace(/[\\/]+$/, '');
  return normalized || value;
}

function lastPathSegment(value: string): string {
  return normalizePath(value).split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

function projectForCwd(cwd: string, projects: readonly ManagedProjectResponse[]) {
  const normalizedCwd = normalizePath(cwd);
  return projects
    .filter((project) => {
      const normalizedProjectPath = normalizePath(project.path);
      return (
        normalizedCwd === normalizedProjectPath ||
        normalizedCwd.startsWith(`${normalizedProjectPath}/`) ||
        normalizedCwd.startsWith(`${normalizedProjectPath}\\`)
      );
    })
    .sort((left, right) => right.path.length - left.path.length)[0];
}

function sessionProjectLabel(cwd: string, projects: readonly ManagedProjectResponse[]): string {
  return projectForCwd(cwd, projects)?.name || lastPathSegment(cwd) || 'Workspace';
}

function sessionBranchLabel(cwd: string, projects: readonly ManagedProjectResponse[]): string {
  const project = projectForCwd(cwd, projects);
  if (!project) return lastPathSegment(cwd) || 'working tree';

  const normalizedCwd = normalizePath(cwd);
  const normalizedProjectPath = normalizePath(project.path);
  if (normalizedCwd === normalizedProjectPath) return 'working tree';

  return (
    normalizedCwd
      .slice(normalizedProjectPath.length)
      .replace(/^[\\/]/, '')
      .replace(/[\\/]+/g, '/') || 'working tree'
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

function readAppLayoutPreference(): AppLayout {
  if (typeof window === 'undefined') return 'sidebar';

  try {
    return window.localStorage.getItem(LAYOUT_STORAGE_KEY) === 'tabs' ? 'tabs' : 'sidebar';
  } catch {
    return 'sidebar';
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

function readArchivedRunIds(): string[] {
  if (typeof window === 'undefined') return [];

  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(ARCHIVED_RUNS_STORAGE_KEY) ?? '[]',
    );
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
  } catch {
    return [];
  }
}

export type SupervisorClientApi = Pick<
  SupervisorClient,
  | 'listAgents'
  | 'listModels'
  | 'listComposerSuggestions'
  | 'listExtensions'
  | 'updateExtensions'
  | 'listRuns'
  | 'listAllRuns'
  | 'listProjects'
  | 'listRunAttachments'
  | 'listRunEvents'
  | 'listRunEventPages'
  | 'streamRunEvents'
  | 'getRun'
  | 'createAgent'
  | 'renameAgent'
  | 'deleteAgent'
  | 'createRun'
  | 'createProject'
  | 'updateProject'
  | 'deleteProject'
  | 'cancelRun'
  | 'steerRun'
  | 'followUpRun'
  | 'getFleet'
  | 'getRunChanges'
  | 'createWorktree'
  | 'listWorktrees'
  | 'releaseWorktree'
  | 'createTerminalSession'
  | 'listTerminalSessions'
  | 'getTerminalSession'
  | 'writeTerminalSession'
  | 'cancelTerminalSession'
  | 'listInbox'
  | 'resolveInbox'
  | 'cancelInbox'
  | 'searchSessions'
> & {
  /** Older injected test clients may not implement optional reconciliation APIs. */
  getCommandReceipt?: SupervisorClient['getCommandReceipt'];
  listRunEventPage?: SupervisorClient['listRunEventPage'];
};

function mergeRuns(...groups: ManagedAgentRunResponse[][]): ManagedAgentRunResponse[] {
  const byId = new Map<string, ManagedAgentRunResponse>();
  for (const group of groups) for (const run of group) if (!byId.has(run.id)) byId.set(run.id, run);
  return [...byId.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function loadServerSnapshot(
  server: ServerDefinition,
  client: SupervisorClientApi,
  previous?: ServerSnapshot,
): Promise<ServerSnapshot> {
  const checkedAt = new Date().toISOString();
  const [agents, history, queued, running, projects, models] = await Promise.allSettled([
    client.listAgents({ limit: 100 }),
    client.listRuns({ limit: 100 }),
    client.listAllRuns({ limit: 100, status: 'queued' }, { maxPages: 100 }),
    client.listAllRuns({ limit: 100, status: 'running' }, { maxPages: 100 }),
    client.listProjects({ limit: 100 }),
    client.listModels(),
  ]);
  const state = (results: PromiseSettledResult<unknown>[]): SnapshotResourceState => {
    const failure = results.find((result) => result.status === 'rejected') as
      | PromiseRejectedResult
      | undefined;
    return failure
      ? { status: previous ? 'stale' : 'failed', checkedAt, error: errorMessage(failure.reason) }
      : { status: 'live', checkedAt };
  };
  const historicalRuns =
    history.status === 'fulfilled' ? history.value.runs : (previous?.runs ?? []);
  const activeRuns = [queued, running].flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  );
  return {
    server,
    client,
    agents: agents.status === 'fulfilled' ? agents.value.agents : (previous?.agents ?? []),
    runs: mergeRuns(activeRuns, historicalRuns),
    projects:
      projects.status === 'fulfilled' ? projects.value.projects : (previous?.projects ?? []),
    models: models.status === 'fulfilled' ? models.value : previous?.models,
    historyCursor:
      history.status === 'fulfilled' ? history.value.nextCursor : (previous?.historyCursor ?? null),
    resources: {
      agents: state([agents]),
      runs: state([history, queued, running]),
      projects: state([projects]),
      models: state([models]),
    },
  };
}

interface AppProps {
  client?: SupervisorClientApi;
  connectionManager?: ServerConnectionManager;
}

export default function App({
  client: injectedClient,
  connectionManager = serverConnectionManager,
}: AppProps) {
  const fallbackServer = useMemo<ServerDefinition>(
    () => ({ id: 'local', name: 'Local', address: '/', hasToken: false }),
    [],
  );
  const [client, setClient] = useState<SupervisorClientApi>(injectedClient ?? supervisorClient);
  const [initialRoute] = useState(readAppRoute);
  const [route, setRoute] = useState<AppRoute>(initialRoute);
  const initialRouteRef = useRef(initialRoute);
  const [servers, setServers] = useState<ServerDefinition[]>(() =>
    injectedClient ? [fallbackServer] : [],
  );
  const [snapshots, setSnapshots] = useState<Record<string, ServerSnapshot>>({});
  const snapshotsRef = useRef<Record<string, ServerSnapshot>>({});
  const [activeServerId, setActiveServerId] = useState<string | undefined>(() =>
    initialRoute.kind === 'session' ? initialRoute.serverId : undefined,
  );
  const [agents, setAgents] = useState<ManagedAgentResponse[]>([]);
  const [models, setModels] = useState<ManagedAgentModelsResponse>();
  const [runs, setRuns] = useState<ManagedAgentRunResponse[]>([]);
  const [projects, setProjects] = useState<ManagedProjectResponse[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(() =>
    initialRoute.kind === 'session' ? initialRoute.runId : undefined,
  );
  const [archivedRunIds, setArchivedRunIds] = useState<string[]>(readArchivedRunIds);
  const initialArchivedRunIdsRef = useRef(archivedRunIds);
  const [events, setEvents] = useState<ManagedAgentEvent[]>([]);
  const [hasOlderEvents, setHasOlderEvents] = useState(false);
  const [loadingOlderEvents, setLoadingOlderEvents] = useState(false);
  const historyExpandedRef = useRef(false);
  const [runAttachments, setRunAttachments] = useState<Record<string, AgentImageAttachment[]>>({});
  const attachmentCacheRef = useRef(
    new LruCache<string, AgentImageAttachment[]>(RUN_ATTACHMENT_CACHE_LIMIT),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(
    injectedClient ? 'agents' : 'servers',
  );
  const [darkMode, setDarkMode] = useState(() => readDarkModePreference());
  const [appLayout, setAppLayout] = useState<AppLayout>(readAppLayoutPreference);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsedPreference());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [connectionState, setConnectionState] = useState<StreamConnectionState>('stale');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [attentionCount, setAttentionCount] = useState(0);

  const sessions = useMemo<ServerSession[]>(
    () =>
      Object.values(snapshots).flatMap((snapshot) =>
        snapshot.runs.map((run) => ({ serverId: snapshot.server.id, run })),
      ),
    [snapshots],
  );
  const visibleSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          !archivedRunIds.includes(sessionKey(session.serverId, session.run.id)) &&
          !archivedRunIds.includes(session.run.id),
      ),
    [archivedRunIds, sessions],
  );
  const archivedSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          archivedRunIds.includes(sessionKey(session.serverId, session.run.id)) ||
          archivedRunIds.includes(session.run.id),
      ),
    [archivedRunIds, sessions],
  );
  const run = runs.find((candidate) => candidate.id === selectedRunId);
  const selectedAgent = agents.find((agent) => agent.id === run?.agentId);
  const activeServer = servers.find((server) => server.id === activeServerId);
  const selectedSessionKey =
    activeServerId && selectedRunId ? sessionKey(activeServerId, selectedRunId) : undefined;
  const transcript = useMemo(() => mapPiEvents(events), [events]);
  const runIsActive = run?.status === 'queued' || run?.status === 'running';
  const operationsServers = useMemo<ServerOperationsClient[]>(
    () =>
      Object.values(snapshots).map((snapshot) => ({
        id: snapshot.server.id,
        name: snapshot.server.name,
        client: snapshot.client,
      })),
    [snapshots],
  );
  const workspaceTabValue =
    activeServerId && selectedRunId
      ? sessionKey(activeServerId, selectedRunId)
      : route.kind === 'default'
        ? 'new'
        : route.kind;

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
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, appLayout);
    } catch {
      // Preferences are a convenience; an unavailable storage API should not block the app.
    }
  }, [appLayout]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
    } catch {
      // Preferences are a convenience; an unavailable storage API should not block the app.
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ARCHIVED_RUNS_STORAGE_KEY, JSON.stringify(archivedRunIds));
    } catch {
      // Preferences are a convenience; an unavailable storage API should not block the app.
    }
  }, [archivedRunIds]);

  useEffect(() => {
    const handlePopState = () => {
      const route = readAppRoute();
      setRoute(route);
      if (route.kind !== 'session') {
        setSelectedRunId(undefined);
        return;
      }
      const snapshot = route.serverId
        ? snapshotsRef.current[route.serverId]
        : Object.values(snapshotsRef.current).find((candidate) =>
            candidate.runs.some((run) => run.id === route.runId),
          );
      if (snapshot) activateSnapshot(snapshot, route.runId);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const configuredServers = injectedClient
          ? [fallbackServer]
          : await connectionManager.list();
        if (!active) return;
        setServers(configuredServers);
        if (configuredServers.length === 0) {
          setSettingsSection('servers');
          setSettingsOpen(true);
          return;
        }

        const results = await Promise.allSettled(
          configuredServers.map(async (server) => {
            const serverClient = injectedClient ?? connectionManager.client(server);
            return loadServerSnapshot(server, serverClient, snapshotsRef.current[server.id]);
          }),
        );
        if (!active) return;
        const nextSnapshots: Record<string, ServerSnapshot> = {};
        const failures: string[] = [];
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            nextSnapshots[result.value.server.id] = result.value;
            const degraded = Object.entries(result.value.resources)
              .filter(([, resource]) => resource.status !== 'live')
              .map(([name, resource]) => `${name}: ${resource.error ?? 'stale'}`);
            if (degraded.length > 0) {
              const errors = [
                ...new Set(
                  Object.values(result.value.resources).flatMap((resource) =>
                    resource.error ? [resource.error] : [],
                  ),
                ),
              ];
              failures.push(
                injectedClient && errors.length === 1 && degraded.length === 4
                  ? errors[0]
                  : `${result.value.server.name}: ${degraded.join(', ')}`,
              );
            }
          } else {
            const message = errorMessage(result.reason);
            failures.push(
              injectedClient
                ? message
                : `${configuredServers[index]?.name ?? 'Server'}: ${message}`,
            );
          }
        });
        snapshotsRef.current = nextSnapshots;
        setSnapshots(nextSnapshots);
        if (failures.length > 0) setError(failures.join('\n'));

        const route = initialRouteRef.current;
        let routeSnapshot =
          route.kind === 'session'
            ? route.serverId
              ? nextSnapshots[route.serverId]
              : Object.values(nextSnapshots).find((snapshot) =>
                  snapshot.runs.some((candidate) => candidate.id === route.runId),
                )
            : undefined;
        if (route.kind === 'session' && !routeSnapshot) {
          for (const candidate of Object.values(nextSnapshots)) {
            try {
              const restoredRun = await candidate.client.getRun(route.runId);
              const restored = { ...candidate, runs: mergeRuns([restoredRun], candidate.runs) };
              nextSnapshots[candidate.server.id] = restored;
              routeSnapshot = restored;
              break;
            } catch {
              // A legacy route has no server id, so continue until a server recognizes the run.
            }
          }
        }
        if (
          route.kind === 'session' &&
          routeSnapshot &&
          !routeSnapshot.runs.some((candidate) => candidate.id === route.runId)
        ) {
          try {
            const restoredRun = await routeSnapshot.client.getRun(route.runId);
            const restored = {
              ...routeSnapshot,
              runs: mergeRuns([restoredRun], routeSnapshot.runs),
            };
            nextSnapshots[routeSnapshot.server.id] = restored;
            routeSnapshot = restored;
          } catch {
            // The route can still fall back to the first known session.
          }
        }
        const routeRunId =
          route.kind === 'session' &&
          routeSnapshot?.runs.some((candidate) => candidate.id === route.runId)
            ? route.runId
            : undefined;
        const firstSession = Object.values(nextSnapshots)
          .flatMap((snapshot) => snapshot.runs.map((candidate) => ({ snapshot, run: candidate })))
          .find(
            ({ snapshot, run: candidate }) =>
              !initialArchivedRunIdsRef.current.includes(
                sessionKey(snapshot.server.id, candidate.id),
              ) && !initialArchivedRunIdsRef.current.includes(candidate.id),
          );
        const targetSnapshot =
          routeSnapshot ?? firstSession?.snapshot ?? Object.values(nextSnapshots)[0];
        if (targetSnapshot) {
          const nextRunId = route.kind === 'default' ? firstSession?.run.id : routeRunId;
          activateSnapshot(targetSnapshot, nextRunId);
          if (nextRunId && !routeRunId) {
            const nextRoute = {
              kind: 'session',
              serverId: targetSnapshot.server.id,
              runId: nextRunId,
            } as const;
            setRoute(nextRoute);
            writeAppRoute(nextRoute, true);
          }
        }
      } catch (reason) {
        if (active) setError(errorMessage(reason));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [connectionManager, fallbackServer, injectedClient]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      const currentSnapshots = Object.values(snapshotsRef.current);
      if (currentSnapshots.length === 0) return;
      void Promise.allSettled(
        currentSnapshots.map(async (snapshot) => {
          const [runPage, inbox] = await Promise.all([
            snapshot.client.listRuns({ limit: 100 }),
            snapshot.client.listInbox(),
          ]);
          return { snapshot, runPage, inbox };
        }),
      ).then((results) => {
        if (!active) return;
        let attention = 0;
        const nextSnapshots = { ...snapshotsRef.current };
        for (const result of results) {
          if (result.status === 'rejected') {
            attention += 1;
            continue;
          }
          const { snapshot, runPage, inbox } = result.value;
          const nextRuns = mergeRuns(runPage.runs, snapshot.runs);
          attention +=
            nextRuns.filter((candidate) => candidate.status === 'failed').length +
            inbox.items.filter((item) => item.status === 'pending').length;
          nextSnapshots[snapshot.server.id] = {
            ...snapshot,
            runs: nextRuns,
            resources: {
              ...snapshot.resources,
              runs: { status: 'live', checkedAt: new Date().toISOString() },
            },
          };
          if (snapshot.server.id === activeServerId) setRuns(nextRuns);
        }
        snapshotsRef.current = nextSnapshots;
        setSnapshots(nextSnapshots);
        setAttentionCount(attention);
      });
    };
    const interval = window.setInterval(refresh, 3_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [activeServerId, servers]);

  useEffect(() => {
    document.title = attentionCount > 0 ? `(${attentionCount}) piDeck` : 'piDeck';
  }, [attentionCount]);

  useEffect(() => {
    if (!activeServerId || !snapshotsRef.current[activeServerId]) return;
    const current = snapshotsRef.current[activeServerId];
    const next = { ...current, agents, models, runs, projects };
    const nextSnapshots = { ...snapshotsRef.current, [activeServerId]: next };
    snapshotsRef.current = nextSnapshots;
    setSnapshots(nextSnapshots);
  }, [activeServerId, agents, models, projects, runs]);

  useEffect(() => {
    const runId = run?.id;
    const attachmentKey = selectedSessionKey;
    if (!runId || !attachmentKey) return;
    const cached = attachmentCacheRef.current.get(attachmentKey);
    if (cached) {
      setRunAttachments(attachmentCacheRef.current.snapshot());
      return;
    }
    let active = true;
    void client
      .listRunAttachments(runId)
      .then((response) => {
        if (!active) return;
        attachmentCacheRef.current.set(attachmentKey, response.attachments);
        setRunAttachments(attachmentCacheRef.current.snapshot());
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [client, run?.id, selectedSessionKey]);

  useEffect(() => {
    const getReceipt = client.getCommandReceipt;
    if (!getReceipt) return;
    let active = true;
    for (const submission of readSubmissions()) {
      void client
        .getCommandReceipt(submission.key)
        .then((receipt) => {
          if (!active) return;
          if (receipt.status === 'succeeded') {
            const result = ManagedAgentRunResponseSchema.safeParse(receipt.result);
            if (result.success) {
              setRuns((current) => [
                result.data,
                ...current.filter((candidate) => candidate.id !== result.data.id),
              ]);
            }
            completeSubmission(submission);
          } else if (receipt.status === 'failed') {
            markSubmissionFailed(submission, receipt.id);
          } else {
            markSubmissionUncertain(submission, receipt.id);
          }
        })
        .catch((reason: unknown) => {
          if (!active) return;
          if (reason instanceof ApiError && reason.status === 404) {
            // No receipt means the command never became durable. Keep the key
            // for a same-payload retry, but allow a new payload to replace it.
            markSubmissionFailed(submission, submission.receiptId);
          } else {
            markSubmissionUncertain(submission, submission.receiptId);
          }
        });
    }
    return () => {
      active = false;
    };
  }, [client, connectionState]);

  useEffect(() => {
    if (!run?.id) {
      setEvents([]);
      setHasOlderEvents(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    let lastSequence = 0;
    setEvents([]);
    setHasOlderEvents(false);
    historyExpandedRef.current = false;

    void (async () => {
      try {
        if (client.listRunEventPage) {
          const response = await client.listRunEventPage(run.id, {
            beforeSequence: Number.MAX_SAFE_INTEGER,
            limit: LATEST_TRANSCRIPT_PAGE_SIZE,
          });
          if (!active) return;
          lastSequence = response.events.at(-1)?.sequence ?? 0;
          setHasOlderEvents(response.hasMore === true && response.previousSequence != null);
          setEvents((current) => mergeTranscriptEvents(current, response.events));
        } else {
          for await (const response of client.listRunEventPages(run.id)) {
            if (!active) return;
            lastSequence = Math.max(
              lastSequence,
              ...response.events.map((event) => event.sequence),
              0,
            );
            setEvents((current) => mergeTranscriptEvents(current, response.events));
          }
        }

        const onConnectionState = (state: StreamConnectionState) => {
          setConnectionState(state);
          if (state === 'connected') {
            void client
              .getRun(run.id)
              .then((nextRun) => {
                if (!active) return;
                setRuns((current) =>
                  current.map((candidate) => (candidate.id === nextRun.id ? nextRun : candidate)),
                );
              })
              .catch(() => undefined);
          }
        };
        for await (const event of client.streamRunEvents(run.id, {
          afterSequence: lastSequence,
          signal: controller.signal,
          onConnectionState,
        })) {
          if (!active) return;
          lastSequence = Math.max(lastSequence, event.sequence);
          setEvents((current) =>
            mergeTranscriptEvents(
              current,
              [event],
              historyExpandedRef.current ? current.length + 1 : TRANSCRIPT_EVENT_WINDOW,
            ),
          );
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

  const loadOlderEvents = useCallback(async () => {
    if (
      !client.listRunEventPage ||
      !run?.id ||
      !hasOlderEvents ||
      loadingOlderEvents ||
      events.length === 0
    ) {
      return;
    }
    const oldestSequence = events[0]?.sequence;
    if (oldestSequence === undefined) return;
    setLoadingOlderEvents(true);
    try {
      const page = await client.listRunEventPage(run.id, {
        beforeSequence: oldestSequence,
        limit: LATEST_TRANSCRIPT_PAGE_SIZE,
      });
      historyExpandedRef.current = true;
      setEvents((current) => prependTranscriptEvents(current, page.events));
      setHasOlderEvents(page.hasMore === true && page.previousSequence != null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoadingOlderEvents(false);
    }
  }, [client, events, hasOlderEvents, loadingOlderEvents, run?.id]);

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

  function activateSnapshot(snapshot: ServerSnapshot, runId?: string) {
    setActiveServerId(snapshot.server.id);
    setClient(snapshot.client);
    setAgents(snapshot.agents);
    setModels(snapshot.models);
    setRuns(snapshot.runs);
    setProjects(snapshot.projects);
    setSelectedRunId(runId);
  }

  async function retryServerSnapshot(serverId: string) {
    const current = snapshotsRef.current[serverId];
    if (!current) return;
    const next = await loadServerSnapshot(current.server, current.client, current);
    const all = { ...snapshotsRef.current, [serverId]: next };
    snapshotsRef.current = all;
    setSnapshots(all);
    if (activeServerId === serverId) activateSnapshot(next, selectedRunId);
    setError(undefined);
  }

  async function loadMoreHistory() {
    const candidates = Object.values(snapshotsRef.current).filter(
      (snapshot) => snapshot.historyCursor,
    );
    if (candidates.length === 0 || historyLoading) return;
    setHistoryLoading(true);
    setHistoryError(undefined);
    try {
      const all = { ...snapshotsRef.current };
      for (const snapshot of candidates) {
        const page = await snapshot.client.listRuns({
          limit: 100,
          cursor: snapshot.historyCursor ?? undefined,
        });
        all[snapshot.server.id] = {
          ...snapshot,
          runs: mergeRuns(snapshot.runs, page.runs),
          historyCursor: page.nextCursor,
          resources: {
            ...snapshot.resources,
            runs: { status: 'live', checkedAt: new Date().toISOString() },
          },
        };
      }
      snapshotsRef.current = all;
      setSnapshots(all);
      const active = activeServerId ? all[activeServerId] : undefined;
      if (active) activateSnapshot(active, selectedRunId);
    } catch (reason) {
      setHistoryError(errorMessage(reason));
    } finally {
      setHistoryLoading(false);
    }
  }

  function selectComposerServer(serverId: string) {
    const snapshot = snapshotsRef.current[serverId];
    if (!snapshot) return;
    activateSnapshot(snapshot);
    setRoute({ kind: 'new' });
    writeAppRoute({ kind: 'new' });
  }

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
    attachments?: AgentImageAttachment[];
    executionMode?: 'local' | 'worktree';
    worktreeId?: string;
  }) {
    setSubmitting(true);
    setError(undefined);
    let submission: SubmissionRecord | undefined;
    let runRequestStarted = false;
    try {
      submission = beginSubmission('create-run', input.agentId, input, {
        prompt: input.prompt,
        cwd: input.cwd,
        attachmentCount: input.attachments?.length ?? 0,
        executionMode: input.executionMode ?? 'local',
      });
      const project = await client.createProject({ path: input.cwd });
      setProjects((current) => [
        project,
        ...current.filter((candidate) => candidate.id !== project.id),
      ]);
      runRequestStarted = true;
      const nextRun = await client.createRun({ ...input, idempotencyKey: submission.key });
      rememberSubmissionReceipt(submission, nextRun.acknowledgementId);
      completeSubmission(submission);
      setRuns((current) => [
        nextRun,
        ...current.filter((candidate) => candidate.id !== nextRun.id),
      ]);
      if (input.attachments?.length) {
        attachmentCacheRef.current.set(
          sessionKey(activeServerId ?? 'local', nextRun.id),
          input.attachments,
        );
        setRunAttachments(attachmentCacheRef.current.snapshot());
      }
      if (activeServerId) {
        setSelectedRunId(nextRun.id);
        const nextRoute = { kind: 'session' as const, serverId: activeServerId, runId: nextRun.id };
        setRoute(nextRoute);
        writeAppRoute(nextRoute);
      }
      setEvents([]);
    } catch (reason) {
      if (submission) {
        if (runRequestStarted && isUncertainSubmissionError(reason)) {
          markSubmissionUncertain(submission);
        } else {
          markSubmissionFailed(submission);
        }
      }
      setError(errorMessage(reason));
      throw reason;
    } finally {
      setSubmitting(false);
    }
  }

  async function createManagedProject(input: {
    name?: string;
    path: string;
  }): Promise<ManagedProjectResponse | undefined> {
    setSubmitting(true);
    setError(undefined);
    try {
      const project = await client.createProject(input);
      setProjects((current) => [
        project,
        ...current.filter((candidate) => candidate.id !== project.id),
      ]);
      return project;
    } catch (reason) {
      setError(errorMessage(reason));
      return undefined;
    } finally {
      setSubmitting(false);
    }
  }

  async function updateManagedProject(
    projectId: string,
    input: { name?: string; path?: string },
  ): Promise<ManagedProjectResponse | undefined> {
    setSubmitting(true);
    setError(undefined);
    try {
      const project = await client.updateProject(projectId, input);
      setProjects((current) =>
        current.map((candidate) => (candidate.id === project.id ? project : candidate)),
      );
      return project;
    } catch (reason) {
      setError(errorMessage(reason));
      return undefined;
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
    let submission: SubmissionRecord | undefined;
    try {
      submission = beginSubmission('cancel-run', run.id, { runId: run.id }, { runId: run.id });
      const nextRun = await client.cancelRun(run.id, submission.key);
      rememberSubmissionReceipt(submission, nextRun.acknowledgementId);
      completeSubmission(submission);
      setRuns((current) =>
        current.map((candidate) => (candidate.id === nextRun.id ? nextRun : candidate)),
      );
    } catch (reason) {
      if (submission) {
        if (isUncertainSubmissionError(reason)) markSubmissionUncertain(submission);
        else markSubmissionFailed(submission);
      }
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  }

  async function steerRun(message: string, attachments?: AgentImageAttachment[]) {
    if (!run) return;
    setSubmitting(true);
    setError(undefined);
    let submission: SubmissionRecord | undefined;
    try {
      const request = {
        message,
        ...(attachments?.length ? { attachments } : {}),
      };
      submission = beginSubmission('steer-run', run.id, request, {
        message,
        attachmentCount: attachments?.length ?? 0,
      });
      const nextRun = await client.steerRun(run.id, {
        ...request,
        idempotencyKey: submission.key,
      });
      rememberSubmissionReceipt(submission, nextRun.acknowledgementId);
      completeSubmission(submission);
      setRuns((current) =>
        current.map((candidate) => (candidate.id === nextRun.id ? nextRun : candidate)),
      );
    } catch (reason) {
      if (submission) {
        if (isUncertainSubmissionError(reason)) markSubmissionUncertain(submission);
        else markSubmissionFailed(submission);
      }
      setError(errorMessage(reason));
      throw reason;
    } finally {
      setSubmitting(false);
    }
  }

  async function followUpRun(message: string, attachments?: AgentImageAttachment[]) {
    if (!run) return;
    setSubmitting(true);
    setError(undefined);
    let submission: SubmissionRecord | undefined;
    try {
      const request = {
        message,
        ...(attachments?.length ? { attachments } : {}),
      };
      submission = beginSubmission('follow-up-run', run.id, request, {
        message,
        attachmentCount: attachments?.length ?? 0,
      });
      const nextRun = await client.followUpRun(run.id, {
        ...request,
        idempotencyKey: submission.key,
      });
      rememberSubmissionReceipt(submission, nextRun.acknowledgementId);
      completeSubmission(submission);
      setRuns((current) =>
        current.map((candidate) => (candidate.id === nextRun.id ? nextRun : candidate)),
      );
    } catch (reason) {
      if (submission) {
        if (isUncertainSubmissionError(reason)) markSubmissionUncertain(submission);
        else markSubmissionFailed(submission);
      }
      setError(errorMessage(reason));
      throw reason;
    } finally {
      setSubmitting(false);
    }
  }

  function openRun(serverId: string, runId: string) {
    const snapshot = snapshotsRef.current[serverId];
    if (!snapshot) return;
    activateSnapshot(snapshot, runId);
    const nextRoute = {
      kind: 'session' as const,
      serverId: injectedClient ? undefined : serverId,
      runId,
    };
    setRoute(nextRoute);
    writeAppRoute(nextRoute);
  }

  function openNewSession() {
    setSelectedRunId(undefined);
    setEvents([]);
    setRoute({ kind: 'new' });
    writeAppRoute({ kind: 'new' });
  }

  function openWorkspaceRoute(kind: 'fleet' | 'inbox' | 'worktrees') {
    setSelectedRunId(undefined);
    setEvents([]);
    setRoute({ kind });
    writeAppRoute({ kind });
  }

  function restoreRun(serverId: string, runId: string) {
    const key = sessionKey(serverId, runId);
    setArchivedRunIds((current) => current.filter((item) => item !== key && item !== runId));
    openRun(serverId, runId);
  }

  function archiveRun(serverId: string, runId: string) {
    const key = sessionKey(serverId, runId);
    setArchivedRunIds((current) => (current.includes(key) ? current : [...current, key]));
    if (activeServerId !== serverId || selectedRunId !== runId) return;

    const nextSession = visibleSessions.find(
      (candidate) => candidate.serverId !== serverId || candidate.run.id !== runId,
    );
    if (nextSession) openRun(nextSession.serverId, nextSession.run.id);
    else openNewSession();
  }

  useEffect(() => {
    function handleAppShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        openNewSession();
      }
      if (event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener('keydown', handleAppShortcut);
    return () => window.removeEventListener('keydown', handleAppShortcut);
  });

  return (
    <TooltipProvider delayDuration={300}>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}>
        <LayoutGroup>
          <motion.main
            aria-label="piDeck agent workspace"
            className={cn(
              'grid h-svh grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background text-foreground motion-safe:transition-[grid-template-columns] motion-safe:duration-120 motion-safe:ease-out',
              appLayout === 'tabs'
                ? 'grid-cols-1'
                : sidebarCollapsed
                  ? 'md:grid-cols-[4.5rem_minmax(0,1fr)] md:grid-rows-1'
                  : 'md:grid-cols-[18rem_minmax(0,1fr)] md:grid-rows-1',
            )}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
          >
            <Tabs
              value={workspaceTabValue}
              className="contents"
              onValueChange={(value) => {
                const session = visibleSessions.find(
                  (candidate) => sessionKey(candidate.serverId, candidate.run.id) === value,
                );
                if (session) openRun(session.serverId, session.run.id);
              }}
            >
              {appLayout === 'sidebar' ? (
                <motion.aside
                  className="flex min-w-0 flex-col border-b bg-sidebar md:min-h-svh md:border-r md:border-b-0"
                  initial={{ opacity: 0, x: -18 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{
                    duration: 0.12,
                    delay: 0.02,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                >
                  <motion.div
                    className={cn(
                      'flex w-full items-center justify-end gap-1 px-4 py-3 md:py-4',
                      sidebarCollapsed && 'flex-col items-center gap-2 px-2 py-3',
                    )}
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.12,
                      delay: 0.06,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="New session"
                      title="New session"
                      onClick={openNewSession}
                    >
                      <PlusIcon aria-hidden="true" />
                    </Button>
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
                  </motion.div>
                  <nav
                    id="sidebar-sessions"
                    className={cn(
                      'flex min-w-0 flex-1 gap-1 overflow-x-auto p-2 md:flex-col md:overflow-y-auto',
                      sidebarCollapsed && 'items-center',
                    )}
                    aria-label="Sessions"
                  >
                    <AnimatePresence initial={false} mode="popLayout">
                      {visibleSessions.length === 0 ? (
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
                        visibleSessions.map((session, index) => {
                          const candidate = session.run;
                          const snapshot = snapshots[session.serverId];
                          const server = snapshot?.server;
                          const sessionAgents = snapshot?.agents ?? [];
                          const sessionModels = snapshot?.models;
                          const sessionProjects = snapshot?.projects ?? [];
                          const agent = sessionAgents.find((item) => item.id === candidate.agentId);
                          const selected =
                            session.serverId === activeServerId && candidate.id === selectedRunId;
                          const modelName = modelDisplayName(candidate.model, sessionModels);
                          const thinkingLabel = candidate.thinkingLevel
                            ? titleCase(candidate.thinkingLevel)
                            : 'Default';
                          const projectLabel = sessionProjectLabel(candidate.cwd, sessionProjects);
                          const branchLabel = sessionBranchLabel(candidate.cwd, sessionProjects);
                          const sessionDetails = `${modelName} · ${thinkingLabel} thinking`;
                          const serverDetail = injectedClient
                            ? ''
                            : ` · ${server?.name ?? 'Server'}`;
                          const sessionTooltip = `${sessionTitle(candidate.prompt)}${serverDetail} · ${projectLabel} · ${branchLabel} · ${sessionDetails} · ${titleCase(candidate.status)}`;
                          return (
                            <motion.div
                              key={sessionKey(session.serverId, candidate.id)}
                              layout
                              initial={{ opacity: 0, x: -12 }}
                              animate={{ opacity: 1, x: 0 }}
                              exit={{ opacity: 0, x: -12 }}
                              transition={{
                                duration: 0.16,
                                delay: Math.min(index, 8) * 0.025,
                              }}
                              className={cn(
                                'group/session-card relative min-w-52 md:min-w-0',
                                sidebarCollapsed && 'min-w-0',
                              )}
                            >
                              {selected ? (
                                <motion.span
                                  layoutId="active-session"
                                  className="absolute inset-0 rounded-lg bg-secondary"
                                  transition={{
                                    type: 'spring',
                                    stiffness: 500,
                                    damping: 36,
                                  }}
                                />
                              ) : null}
                              <ContextMenuPrimitive.Root>
                                <ContextMenuPrimitive.Trigger asChild>
                                  <div className="min-w-0">
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant="ghost"
                                          size={sidebarCollapsed ? 'icon' : 'default'}
                                          className={cn(
                                            'relative z-10 h-auto min-w-52 items-center justify-start gap-3 px-2 py-2 pr-10 text-left md:w-full md:min-w-0',
                                            sidebarCollapsed &&
                                              'min-w-0 items-center justify-center gap-0 px-0 py-1.5',
                                          )}
                                          aria-current={selected ? 'page' : undefined}
                                          aria-label={sidebarCollapsed ? sessionTooltip : undefined}
                                          title={sessionTooltip}
                                          onClick={() => openRun(session.serverId, candidate.id)}
                                        >
                                          {sidebarCollapsed ? (
                                            <span className="relative flex size-7 items-center justify-center">
                                              <SessionAvatar
                                                model={candidate.model}
                                                models={sessionModels}
                                              />
                                              <span className="absolute -top-1 -right-1">
                                                <RunDot status={candidate.status} />
                                              </span>
                                            </span>
                                          ) : (
                                            <SessionAvatar
                                              model={candidate.model}
                                              models={sessionModels}
                                              className="size-9 rounded-full ring-1 ring-border/70"
                                            />
                                          )}
                                          {!sidebarCollapsed ? (
                                            <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                                              <span
                                                className="flex w-full min-w-0 items-center gap-1 truncate text-[0.68rem] font-medium leading-4 text-muted-foreground"
                                                title={`Project: ${projectLabel}`}
                                              >
                                                <FolderIcon
                                                  className="size-3 shrink-0"
                                                  aria-hidden="true"
                                                />
                                                <span className="truncate">
                                                  {server?.name ?? 'Server'} · {projectLabel}
                                                </span>
                                              </span>
                                              <span className="w-full truncate text-sm font-semibold leading-5 tracking-tight text-foreground">
                                                {sessionTitle(candidate.prompt)}
                                              </span>
                                              <span className="flex w-full min-w-0 items-center gap-1.5 pt-0.5 text-[0.68rem] font-normal leading-4 text-muted-foreground">
                                                <GitBranchIcon
                                                  className="size-3 shrink-0"
                                                  aria-hidden="true"
                                                />
                                                <span
                                                  className="min-w-0 truncate"
                                                  title={`Branch: ${branchLabel}`}
                                                >
                                                  {branchLabel}
                                                </span>
                                                <RunDot status={candidate.status} />
                                              </span>
                                              <span className="sr-only">
                                                {agent?.name ?? 'Agent'} · {sessionDetails} ·{' '}
                                                {formatRelativeDate(candidate.createdAt)}
                                              </span>
                                            </span>
                                          ) : null}
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent side="right" align="start">
                                        <p className="font-medium">{modelName}</p>
                                        <p className="text-primary-foreground/70">
                                          {thinkingLabel} thinking
                                        </p>
                                      </TooltipContent>
                                    </Tooltip>
                                  </div>
                                </ContextMenuPrimitive.Trigger>
                                <ContextMenuPrimitive.Portal>
                                  <ContextMenuPrimitive.Content className="z-50 min-w-44 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
                                    <ContextMenuPrimitive.Label className="max-w-60 truncate px-2 py-1.5 text-xs font-medium text-muted-foreground">
                                      {sessionTitle(candidate.prompt)}
                                    </ContextMenuPrimitive.Label>
                                    <ContextMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
                                    <ContextMenuPrimitive.Item
                                      className="relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                                      onSelect={() => archiveRun(session.serverId, candidate.id)}
                                    >
                                      <ArchiveIcon className="size-4" aria-hidden="true" />
                                      Archive
                                    </ContextMenuPrimitive.Item>
                                  </ContextMenuPrimitive.Content>
                                </ContextMenuPrimitive.Portal>
                              </ContextMenuPrimitive.Root>
                              {!sidebarCollapsed ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  className="absolute top-1/2 right-2 z-20 -translate-y-1/2 bg-background text-foreground opacity-0 shadow-md ring-1 ring-border/80 transition-opacity hover:bg-background/80 group-hover/session-card:opacity-100 group-focus-within/session-card:opacity-100"
                                  aria-label="Archive session"
                                  title="Archive session"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    archiveRun(session.serverId, candidate.id);
                                  }}
                                >
                                  <ArchiveIcon aria-hidden="true" />
                                </Button>
                              ) : null}
                            </motion.div>
                          );
                        })
                      )}
                    </AnimatePresence>
                    {!sidebarCollapsed &&
                    Object.values(snapshots).some((snapshot) => snapshot.historyCursor) ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="mx-2 mb-2"
                        disabled={historyLoading}
                        onClick={() => void loadMoreHistory()}
                      >
                        {historyLoading ? 'Loading history…' : 'Load more history'}
                      </Button>
                    ) : null}
                    {historyError ? (
                      <p className="px-4 pb-2 text-xs text-destructive">{historyError}</p>
                    ) : null}
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
              ) : (
                <TabsWorkspaceHeader
                  sessions={visibleSessions}
                  snapshots={snapshots}
                  darkMode={darkMode}
                  onOpenRun={openRun}
                  onArchiveRun={archiveRun}
                  onNew={openNewSession}
                  onSettings={() => setSettingsOpen(true)}
                  onDarkModeChange={setDarkMode}
                />
              )}

              <TabsContent value={workspaceTabValue} forceMount className="contents">
                <section className="flex h-full min-h-0 min-w-0 flex-col">
                  {archivedSessions.length > 0 ? (
                    <div className="flex items-center gap-2 overflow-x-auto border-b px-3 py-2 text-xs">
                      <span className="shrink-0 text-muted-foreground">Archived:</span>
                      {archivedSessions.map((session) => (
                        <Button
                          key={sessionKey(session.serverId, session.run.id)}
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={() => restoreRun(session.serverId, session.run.id)}
                        >
                          <ArchiveIcon aria-hidden="true" />
                          Restore {sessionTitle(session.run.prompt)}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  {activeServerId &&
                  snapshots[activeServerId] &&
                  Object.values(snapshots[activeServerId].resources).some(
                    (resource) => resource.status !== 'live',
                  ) ? (
                    <Alert className="m-4 mb-0 w-auto">
                      <AlertTitle>Server data is degraded</AlertTitle>
                      <AlertDescription className="flex items-center justify-between gap-3">
                        <span>
                          {Object.entries(snapshots[activeServerId].resources)
                            .filter(([, resource]) => resource.status !== 'live')
                            .map(([name]) => name)
                            .join(', ')}{' '}
                          data is stale or unavailable. Known runs remain available.
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void retryServerSnapshot(activeServerId)}
                        >
                          Retry
                        </Button>
                      </AlertDescription>
                    </Alert>
                  ) : null}
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
                    ) : route.kind === 'fleet' ? (
                      <FleetOverview key="fleet" servers={operationsServers} onOpenRun={openRun} />
                    ) : route.kind === 'inbox' ? (
                      <InboxView key="inbox" servers={operationsServers} />
                    ) : route.kind === 'worktrees' ? (
                      <div key="worktrees" className="min-h-0 flex-1 overflow-y-auto">
                        <WorktreeManager client={client} projects={projects} />
                      </div>
                    ) : run ? (
                      <motion.div
                        key={`conversation-${run.id}`}
                        className="flex min-h-0 min-w-0 flex-1"
                        initial={{ opacity: 0, y: 14 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                      >
                        <Conversation
                          client={client}
                          agent={selectedAgent}
                          run={run}
                          models={models}
                          serverName={activeServer?.name ?? 'Local'}
                          projectLabel={sessionProjectLabel(run.cwd, projects)}
                          branchLabel={sessionBranchLabel(run.cwd, projects)}
                          transcript={transcript}
                          hasOlderEvents={hasOlderEvents}
                          loadingOlderEvents={loadingOlderEvents}
                          onLoadOlderEvents={loadOlderEvents}
                          promptAttachments={
                            runAttachments[sessionKey(activeServerId ?? 'local', run.id)] ?? []
                          }
                          submitting={submitting}
                          runIsActive={runIsActive}
                          connectionState={connectionState}
                          onCancel={cancelRun}
                          onSteer={steerRun}
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
                        transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                      >
                        <NewSession
                          client={client}
                          servers={servers}
                          serverId={activeServerId}
                          agents={agents}
                          models={models}
                          projects={projects}
                          submitting={submitting}
                          onStart={startRun}
                          onDeleteProject={deleteProject}
                          onServerChange={selectComposerServer}
                          onOpenAgents={() => {
                            setSettingsSection(servers.length === 0 ? 'servers' : 'agents');
                            setSettingsOpen(true);
                          }}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </section>
              </TabsContent>
            </Tabs>

            <CommandPalette
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              servers={operationsServers}
              onFleet={() => openWorkspaceRoute('fleet')}
              onInbox={() => openWorkspaceRoute('inbox')}
              onNew={openNewSession}
              onSettings={() => setSettingsOpen(true)}
              onOpenRun={openRun}
            />

            <AgentSettingsDialog
              client={client}
              connectionManager={connectionManager}
              servers={servers}
              activeServerId={activeServerId}
              section={settingsSection}
              onSectionChange={setSettingsSection}
              onServersChange={(nextServers, nextSnapshots) => {
                setServers(nextServers);
                snapshotsRef.current = nextSnapshots;
                setSnapshots(nextSnapshots);
                const nextActive = activeServerId
                  ? (nextSnapshots[activeServerId] ?? Object.values(nextSnapshots)[0])
                  : Object.values(nextSnapshots)[0];
                if (nextActive) activateSnapshot(nextActive);
                else {
                  setActiveServerId(undefined);
                  setAgents([]);
                  setModels(undefined);
                  setRuns([]);
                  setProjects([]);
                  setSelectedRunId(undefined);
                }
              }}
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              agents={agents}
              projects={projects}
              submitting={submitting}
              darkMode={darkMode}
              onDarkModeChange={setDarkMode}
              appLayout={appLayout}
              onAppLayoutChange={setAppLayout}
              onCreate={createAgent}
              onUpdate={updateAgent}
              onDelete={deleteAgent}
              onCreateProject={createManagedProject}
              onUpdateProject={updateManagedProject}
              onDeleteProject={deleteProject}
            />
          </motion.main>
        </LayoutGroup>
      </MotionConfig>
    </TooltipProvider>
  );
}

function TabsWorkspaceHeader({
  sessions,
  snapshots,
  darkMode,
  onOpenRun,
  onArchiveRun,
  onNew,
  onSettings,
  onDarkModeChange,
}: {
  sessions: ServerSession[];
  snapshots: Record<string, ServerSnapshot>;
  darkMode: boolean;
  onOpenRun(serverId: string, runId: string): void;
  onArchiveRun(serverId: string, runId: string): void;
  onNew(): void;
  onSettings(): void;
  onDarkModeChange(darkMode: boolean): void;
}) {
  return (
    <motion.header
      className="flex min-w-0 items-center gap-1 border-b bg-sidebar px-2 py-1.5"
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
    >
      <Button
        type="button"
        variant="ghost"
        className="shrink-0 gap-2 px-2 font-semibold tracking-tight"
        aria-label="piDeck — New session"
        title="New session"
        onClick={onNew}
      >
        <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <PiIcon className="size-3.5" />
        </span>
        <span className="hidden sm:inline">piDeck</span>
      </Button>

      <Separator orientation="vertical" className="mx-1 h-5" />

      <TabsList
        variant="default"
        aria-label="Sessions"
        className="h-9 max-w-full min-w-0 flex-1 justify-start overflow-x-auto overflow-y-hidden"
      >
        {sessions.map((session, index) => {
          const candidate = session.run;
          const snapshot = snapshots[session.serverId];
          const tabValue = sessionKey(session.serverId, candidate.id);
          const projectLabel = sessionProjectLabel(candidate.cwd, snapshot?.projects ?? []);
          return (
            <span key={tabValue} className="group/session-tab flex h-full shrink-0 items-center">
              <TabsTrigger
                value={tabValue}
                className="max-w-56 min-w-32 justify-start px-2.5"
                title={`${sessionTitle(candidate.prompt)} · ${projectLabel}`}
                onKeyDown={(event) => {
                  const offset =
                    event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                  if (!offset) return;
                  const nextSession =
                    sessions[(index + offset + sessions.length) % sessions.length];
                  if (nextSession) onOpenRun(nextSession.serverId, nextSession.run.id);
                }}
              >
                <RunDot status={candidate.status} />
                <span className="truncate">{sessionTitle(candidate.prompt)}</span>
              </TabsTrigger>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="mr-1 shrink-0 opacity-60 hover:opacity-100"
                aria-label={`Archive ${sessionTitle(candidate.prompt)}`}
                title="Archive session"
                onClick={() => onArchiveRun(session.serverId, candidate.id)}
              >
                <XIcon />
              </Button>
            </span>
          );
        })}
      </TabsList>

      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New session"
          onClick={onNew}
        >
          <PlusIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Settings"
          onClick={onSettings}
        >
          <SettingsIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-pressed={darkMode}
          aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => onDarkModeChange(!darkMode)}
        >
          {darkMode ? <SunIcon /> : <MoonIcon />}
        </Button>
      </div>
    </motion.header>
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
  client,
  servers,
  serverId,
  agents,
  models,
  projects,
  submitting,
  onStart,
  onDeleteProject,
  onServerChange,
  onOpenAgents,
}: {
  client: Pick<SupervisorClientApi, 'listComposerSuggestions' | 'listWorktrees'>;
  servers: ServerDefinition[];
  serverId: string | undefined;
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
    attachments?: AgentImageAttachment[];
    executionMode?: 'local' | 'worktree';
    worktreeId?: string;
  }): Promise<void>;
  onDeleteProject(project: ManagedProjectResponse): Promise<boolean>;
  onServerChange(serverId: string): void;
  onOpenAgents(): void;
}) {
  const [prompt, setPrompt] = useState('');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [modelKey, setModelKey] = useState(() =>
    models?.defaultModel ? encodeModel(models.defaultModel) : '',
  );
  const [thinkingLevel, setThinkingLevel] = useState<AgentThinkingLevel>('medium');
  const [cwd, setCwd] = useState(agents[0]?.cwd ?? '.');
  const [executionMode, setExecutionMode] = useState<'local' | 'worktree'>('local');
  const [worktreeId, setWorktreeId] = useState('');
  const [worktrees, setWorktrees] = useState<import('@nextflow/contracts').WorktreeResponse[]>([]);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const attachmentSequenceRef = useRef(0);
  const attachmentsRef = useRef(attachments);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    void client
      .listWorktrees()
      .then((response) =>
        setWorktrees(response.worktrees.filter((item) => item.status === 'ready')),
      )
      .catch(() => setWorktrees([]));
  }, [client]);

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

  function handleDragEnter(event: DragEvent<HTMLFormElement>) {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLFormElement>) {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLFormElement>) {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLFormElement>) {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    addFiles(event.dataTransfer.files);
  }

  async function prepareImageAttachments(): Promise<AgentImageAttachment[] | undefined> {
    if (attachments.length === 0) return undefined;
    const unsupported = attachments.filter(
      (attachment) =>
        !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.file.type),
    );
    if (unsupported.length > 0) {
      setAttachmentError(
        'Only PNG, JPEG, GIF, and WebP images can be sent to Pi. Remove other files first.',
      );
      return undefined;
    }
    if (
      attachments.length > 4 ||
      attachments.some((attachment) => attachment.file.size > 6_000_000)
    ) {
      setAttachmentError('Use at most four images, each smaller than 6 MB.');
      return undefined;
    }
    return Promise.all(
      attachments.map(async (attachment) => ({
        name: attachment.file.name,
        mimeType: attachment.file.type as AgentImageAttachment['mimeType'],
        data: await fileToBase64(attachment.file),
      })),
    );
  }

  useEffect(() => {
    if (agents.some((agent) => agent.id === agentId)) return;
    setAgentId(agents[0]?.id ?? '');
    setCwd(agents[0]?.cwd ?? projects[0]?.path ?? '.');
  }, [agentId, agents, projects]);

  useEffect(() => {
    const availableKeys = new Set(models?.models.map(encodeModel) ?? []);
    if (availableKeys.has(modelKey)) return;
    setModelKey(models?.defaultModel ? encodeModel(models.defaultModel) : '');
  }, [modelKey, models]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if ((!value && attachments.length === 0) || !agentId || !cwd.trim() || submitting) return;
    try {
      const imageAttachments = await prepareImageAttachments();
      if (attachments.length > 0 && !imageAttachments) return;
      const model = decodeModel(modelKey);
      const selectedWorktree = worktrees.find((item) => item.id === worktreeId);
      await onStart({
        agentId,
        prompt: value || 'Please inspect the attached image.',
        ...(model ? { model } : {}),
        thinkingLevel,
        cwd: executionMode === 'worktree' && selectedWorktree ? selectedWorktree.path : cwd.trim(),
        ...(imageAttachments ? { attachments: imageAttachments } : {}),
        ...(executionMode === 'worktree' ? { executionMode, worktreeId } : {}),
      });
      setPrompt('');
      setAttachmentError(undefined);
      clearAttachments();
    } catch {
      // Keep the draft and attachments visible while the app-level error explains what failed.
    }
  }

  if (servers.length === 0) {
    return (
      <motion.div
        className="flex flex-1"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ServerIcon />
            </EmptyMedia>
            <EmptyTitle>Connect a server first</EmptyTitle>
            <EmptyDescription>
              Add the address of a piDeck server to load its sessions and start new work.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={onOpenAgents}>
              <SettingsIcon data-icon="inline-start" />
              Open server settings
            </Button>
          </EmptyContent>
        </Empty>
      </motion.div>
    );
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
              transition={{
                type: 'spring',
                stiffness: 420,
                damping: 24,
                delay: 0.07,
              }}
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
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.header
        className="flex h-12 shrink-0 items-center justify-between border-b px-4"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, delay: 0.06 }}
      >
        <h1 className="text-sm font-semibold">New session</h1>
      </motion.header>
      <div className="flex flex-1 justify-center overflow-y-auto px-4 py-8 md:px-8 md:py-14">
        <div className="w-full max-w-3xl">
          <motion.div
            className="mb-7"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: 0.04 }}
          >
            <h2 className="max-w-xl text-balance text-2xl font-semibold tracking-tight md:text-3xl">
              What should Pi work on?
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Choose a workspace, describe the outcome, and let the run continue in the background.
            </p>
          </motion.div>
          <motion.form
            aria-label="New session composer"
            className="group/composer relative w-full overflow-hidden rounded-2xl border border-border/80 bg-card transition-[border-color,background-color] focus-within:border-foreground/30"
            initial={{ opacity: 0, y: 18, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.18, delay: 0.03, ease: [0.22, 1, 0.36, 1] }}
            onSubmit={submit}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <AnimatePresence>
              {dragActive ? (
                <motion.div
                  className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/90 px-6 text-center shadow-lg"
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
            <ComposerInput
              ariaLabel="Session task"
              placeholder="Ask Pi to inspect, build, fix, or explain…"
              value={prompt}
              onChange={setPrompt}
              cwd={cwd}
              client={client}
              disabled={submitting}
              className="min-h-28 resize-none rounded-none border-0 bg-transparent px-4 py-4 text-base leading-6 shadow-none focus-visible:ring-0 md:min-h-32 md:px-5 md:py-5"
              placement="top"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <Separator />
            <motion.div
              className="flex flex-col bg-muted/15"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, delay: 0.14 }}
            >
              {attachmentError ? (
                <p role="alert" className="px-3 pt-2.5 text-xs text-destructive">
                  {attachmentError}
                </p>
              ) : null}
              {attachments.length > 0 ? (
                <AttachmentGroup aria-label="Attached files" className="px-3 pt-2.5">
                  {attachments.map((attachment) => {
                    const isImage = attachment.file.type.startsWith('image/');
                    if (isImage && attachment.previewUrl) {
                      return (
                        <ImageAttachmentCard
                          key={attachment.id}
                          name={attachment.file.name}
                          src={attachment.previewUrl}
                          description={`${attachmentTypeLabel(attachment.file)} · ${formatFileSize(attachment.file.size)} · Ready to send`}
                          state="idle"
                          onRemove={() => removeAttachment(attachment.id)}
                        />
                      );
                    }

                    return (
                      <Attachment
                        key={attachment.id}
                        state="idle"
                        size="sm"
                        orientation={isImage ? 'vertical' : 'horizontal'}
                      >
                        <AttachmentMedia variant={isImage ? 'image' : 'icon'}>
                          {isImage ? (
                            <ImageIcon aria-hidden="true" />
                          ) : (
                            attachmentIcon(attachment.file)
                          )}
                        </AttachmentMedia>
                        <AttachmentContent>
                          <AttachmentTitle>{attachment.file.name}</AttachmentTitle>
                          <AttachmentDescription>
                            {attachmentTypeLabel(attachment.file)} {'·'}
                            {formatFileSize(attachment.file.size)} {'·'} Ready to send
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
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto px-2.5 py-1.5 [scrollbar-width:none]">
                <Select value={serverId} onValueChange={onServerChange}>
                  <SelectTrigger
                    aria-label="Server"
                    size="sm"
                    className="max-w-40 shrink-0 border-0 bg-transparent shadow-none"
                  >
                    <ServerIcon />
                    <SelectValue placeholder="Choose server" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {servers.map((server) => (
                        <SelectItem key={server.id} value={server.id}>
                          {server.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Select
                  value={executionMode}
                  onValueChange={(value) => setExecutionMode(value as 'local' | 'worktree')}
                >
                  <SelectTrigger
                    aria-label="Execution mode"
                    size="sm"
                    className="shrink-0 border-0 bg-transparent shadow-none"
                  >
                    <GitForkIcon />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="local">Local</SelectItem>
                      <SelectItem value="worktree" disabled={worktrees.length === 0}>
                        Worktree
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {executionMode === 'worktree' ? (
                  <Select value={worktreeId} onValueChange={setWorktreeId}>
                    <SelectTrigger
                      aria-label="Worktree"
                      size="sm"
                      className="max-w-48 shrink-0 border-0 bg-transparent shadow-none"
                    >
                      <SelectValue placeholder="Choose worktree" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {worktrees
                          .filter((worktree) => worktree.status === 'ready')
                          .map((worktree) => (
                            <SelectItem key={worktree.id} value={worktree.id}>
                              {worktree.branch}
                            </SelectItem>
                          ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : null}
                <Separator orientation="vertical" className="h-4 shrink-0" />
                <ProjectPicker
                  projects={projects}
                  path={cwd}
                  onPathChange={setCwd}
                  onDeleteProject={onDeleteProject}
                  disabled={submitting}
                />
              </div>
              <Separator />
              <div className="flex items-center gap-1 p-2">
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
                  className="rounded-full"
                >
                  <PaperclipIcon />
                </Button>
                <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
                  <Select value={agentId} onValueChange={setAgentId}>
                    <SelectTrigger
                      aria-label="Agent profile"
                      size="sm"
                      className="max-w-40 shrink-0 border-0 bg-transparent shadow-none"
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
                  <Separator orientation="vertical" className="hidden h-4 shrink-0 sm:block" />
                  <Select value={modelKey} onValueChange={setModelKey}>
                    <SelectTrigger
                      aria-label="Model"
                      size="sm"
                      className="max-w-52 shrink-0 border-0 bg-transparent shadow-none"
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
                  <Separator orientation="vertical" className="hidden h-4 shrink-0 sm:block" />
                  <Select
                    value={thinkingLevel}
                    onValueChange={(value) => setThinkingLevel(value as AgentThinkingLevel)}
                  >
                    <SelectTrigger
                      aria-label="Thinking level"
                      size="sm"
                      className="shrink-0 border-0 bg-transparent shadow-none"
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
                </div>
                <Button
                  type="submit"
                  size="icon-lg"
                  className="ml-auto shrink-0 rounded-full"
                  title="Start session (⌘Enter)"
                  disabled={
                    submitting ||
                    (!prompt.trim() && attachments.length === 0) ||
                    !agentId ||
                    !cwd.trim() ||
                    (executionMode === 'worktree' && !worktreeId)
                  }
                >
                  <ArrowUpIcon />
                  <span className="sr-only">Start session</span>
                </Button>
              </div>
            </motion.div>
          </motion.form>
          <div className="mt-4 flex flex-wrap items-center gap-1" aria-label="Task starters">
            {TASK_STARTERS.map((starter) => (
              <Button
                key={starter.label}
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-full"
                onClick={() => setPrompt(starter.prompt)}
              >
                {starter.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function ProjectPathAutocomplete({
  id,
  projects,
  path,
  onPathChange,
  disabled,
  placeholder = '/path/to/project',
  required = false,
  autoFocus = false,
}: {
  id: string;
  projects: ManagedProjectResponse[];
  path: string;
  onPathChange(path: string): void;
  disabled?: boolean;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const suggestions = useMemo(() => {
    const query = path.trim().toLowerCase();
    return projects
      .filter(
        (project) =>
          !query ||
          project.name.toLowerCase().includes(query) ||
          project.path.toLowerCase().includes(query),
      )
      .slice(0, 8);
  }, [path, projects]);

  function selectPath(nextPath: string) {
    onPathChange(nextPath);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          id={id}
          value={path}
          disabled={disabled}
          required={required}
          placeholder={placeholder}
          autoFocus={autoFocus}
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
          role="combobox"
          className="font-mono text-sm"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            onPathChange(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && open && suggestions.length === 1) {
              event.preventDefault();
              selectPath(suggestions[0].path);
            }
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-72 p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <Command shouldFilter={false} aria-label="Project path suggestions">
          <CommandList>
            {suggestions.length > 0 ? (
              <CommandGroup heading="Saved project paths">
                {suggestions.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={project.path}
                    onSelect={() => selectPath(project.path)}
                  >
                    <FolderIcon aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{project.name}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {project.path}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              <CommandEmpty>No saved paths match.</CommandEmpty>
            )}
          </CommandList>
          <p className="border-t px-2 py-2 text-[0.7rem] text-muted-foreground">
            Type any existing directory, or choose a saved path.
          </p>
        </Command>
      </PopoverContent>
    </Popover>
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
    <div className="relative min-w-40 flex-1">
      <Popover open={open} onOpenChange={setOpen} modal={false}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label="Choose project"
            className="h-7 max-w-full justify-start gap-2 rounded-md bg-transparent px-2 text-left hover:bg-background/70 dark:bg-transparent dark:hover:bg-background/40"
          >
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 truncate">
              <span className="font-medium">{selectedName}</span>
              <span className="ml-2 hidden font-mono text-[0.68rem] font-normal text-muted-foreground md:inline">
                {path}
              </span>
            </span>
            <ChevronDownIcon
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </PopoverTrigger>

        {/* Keep the menu below the full composer instead of letting it cover the textarea. */}
        <PopoverContent
          role="dialog"
          aria-label="Choose project"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          onInteractOutside={(event) => {
            const target = event.target;
            if (
              target instanceof Element &&
              target.closest('[data-slot="dialog-content"], [data-slot="dialog-overlay"]')
            ) {
              event.preventDefault();
            }
          }}
          className="max-h-[calc(100dvh-1.5rem)] w-[min(34rem,calc(100vw-2rem))] overflow-x-hidden overflow-y-auto rounded-2xl bg-popover p-2 text-popover-foreground shadow-xl ring-1 ring-foreground/10"
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
                <ProjectPathAutocomplete
                  id="new-project-path"
                  projects={projects}
                  path={draftPath}
                  onPathChange={setDraftPath}
                  placeholder="/path/to/project"
                  autoFocus
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
                <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <input
                  data-project-search
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search projects"
                  aria-label="Search projects"
                  autoFocus={!newProjectOpen}
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
                          <span className="block truncate text-sm font-medium">{project.name}</span>
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
        </PopoverContent>
      </Popover>
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

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
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

function ImageAttachmentCard({
  name,
  src,
  description,
  className,
  state = 'done',
  onRemove,
}: {
  name: string;
  src: string;
  description: string;
  className?: string;
  state?: 'idle' | 'uploading' | 'processing' | 'error' | 'done';
  onRemove?: () => void;
}) {
  return (
    <Dialog>
      <Attachment state={state} size="sm" orientation="vertical" className={className}>
        <DialogTrigger asChild>
          <AttachmentTrigger aria-label={`Open ${name}`} />
        </DialogTrigger>
        <AttachmentMedia variant="image">
          <img src={src} alt={name} />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle title={name}>{name}</AttachmentTitle>
          <AttachmentDescription>{description}</AttachmentDescription>
        </AttachmentContent>
        {onRemove ? (
          <AttachmentActions>
            <AttachmentAction type="button" aria-label={`Remove ${name}`} onClick={onRemove}>
              <XIcon />
            </AttachmentAction>
          </AttachmentActions>
        ) : null}
      </Attachment>
      <DialogContent
        className="max-w-[min(92vw,64rem)] gap-3 border-white/10 bg-zinc-950/95 p-2 text-zinc-100 shadow-2xl sm:max-w-[min(92vw,64rem)] sm:p-3"
        overlayClassName="bg-black/80 supports-backdrop-filter:backdrop-blur-sm"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>Full-size preview of {name}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[min(78vh,48rem)] min-h-0 items-center justify-center overflow-hidden rounded-lg bg-black/30">
          <img src={src} alt={name} className="max-h-[min(78vh,48rem)] max-w-full object-contain" />
        </div>
        <div className="flex min-w-0 items-center justify-between gap-3 px-1 text-xs text-zinc-400">
          <span className="truncate" title={name}>
            {name}
          </span>
          <span className="shrink-0">Click outside or press Esc to close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PromptAttachments({ attachments }: { attachments: AgentImageAttachment[] }) {
  if (attachments.length === 0) return null;

  return (
    <AttachmentGroup
      role="group"
      aria-label="Prompt attachments"
      className="max-w-full justify-end gap-2"
    >
      {attachments.map((attachment) => (
        <ImageAttachmentCard
          key={`${attachment.name}-${attachment.mimeType}`}
          name={attachment.name}
          src={`data:${attachment.mimeType};base64,${attachment.data}`}
          description={`${attachment.mimeType.split('/')[1]?.toUpperCase() ?? 'IMAGE'} · Prompt attachment`}
          className="w-28"
        />
      ))}
    </AttachmentGroup>
  );
}

function Conversation({
  client,
  agent,
  run,
  models,
  serverName,
  projectLabel,
  branchLabel,
  transcript,
  hasOlderEvents,
  loadingOlderEvents,
  onLoadOlderEvents,
  promptAttachments,
  submitting,
  runIsActive,
  connectionState,
  onCancel,
  onSteer,
  onSendMessage,
}: {
  client: SupervisorClientApi;
  agent: ManagedAgentResponse | undefined;
  run: ManagedAgentRunResponse;
  models: ManagedAgentModelsResponse | undefined;
  serverName: string;
  projectLabel: string;
  branchLabel: string;
  transcript: ReturnType<typeof mapPiEvents>;
  hasOlderEvents: boolean;
  loadingOlderEvents: boolean;
  onLoadOlderEvents(): Promise<void>;
  promptAttachments: AgentImageAttachment[];
  submitting: boolean;
  runIsActive: boolean;
  connectionState: StreamConnectionState;
  onCancel(): Promise<void>;
  onSteer(message: string, attachments?: AgentImageAttachment[]): Promise<void>;
  onSendMessage(message: string, attachments?: AgentImageAttachment[]): Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [dragActive, setDragActive] = useState(false);
  const [inspector, setInspector] = useState<'changes' | 'terminal'>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptViewportRef = useRef<HTMLDivElement>(null);
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

  async function prepareImageAttachments(): Promise<AgentImageAttachment[] | undefined> {
    if (attachments.length === 0) return undefined;
    const unsupported = attachments.filter(
      (attachment) =>
        !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.file.type),
    );
    if (unsupported.length > 0) {
      setAttachmentError(
        'Only PNG, JPEG, GIF, and WebP images can be sent to Pi. Remove other files first.',
      );
      return undefined;
    }
    if (
      attachments.length > 4 ||
      attachments.some((attachment) => attachment.file.size > 6_000_000)
    ) {
      setAttachmentError('Use at most four images, each smaller than 6 MB.');
      return undefined;
    }
    return Promise.all(
      attachments.map(async (attachment) => ({
        name: attachment.file.name,
        mimeType: attachment.file.type as AgentImageAttachment['mimeType'],
        data: await fileToBase64(attachment.file),
      })),
    );
  }

  async function submitMessage(event: FormEvent) {
    event.preventDefault();
    const value = message.trim();
    if ((!value && attachments.length === 0) || submitting || !canChat) return;
    try {
      const imageAttachments = await prepareImageAttachments();
      if (attachments.length > 0 && !imageAttachments) return;
      await onSendMessage(value || 'Please inspect the attached image.', imageAttachments);
      setMessage('');
      setAttachmentError(undefined);
      clearAttachments();
    } catch {
      // Keep the draft and attachments visible while the app-level error explains what failed.
    }
  }

  async function loadOlderTranscript() {
    const viewport = transcriptViewportRef.current;
    const previousHeight = viewport?.scrollHeight ?? 0;
    const previousTop = viewport?.scrollTop ?? 0;
    await onLoadOlderEvents();
    if (!viewport) return;
    requestAnimationFrame(() => {
      const heightDelta = viewport.scrollHeight - previousHeight;
      viewport.scrollTop = previousTop + heightDelta;
    });
  }

  async function submitSteer() {
    const value = message.trim();
    if (!value || submitting || !runIsActive) return;
    try {
      const imageAttachments = await prepareImageAttachments();
      if (attachments.length > 0 && !imageAttachments) return;
      await onSteer(value, imageAttachments);
      setMessage('');
      setAttachmentError(undefined);
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
        className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b px-3 py-2 sm:px-4"
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.16, delay: 0.04 }}
      >
        <motion.div
          className="flex min-w-0 flex-col gap-0.5"
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.14, delay: 0.05 }}
        >
          <h1 className="truncate text-sm font-semibold">{sessionTitle(run.prompt)}</h1>
          <p
            className="flex min-w-0 items-center gap-1.5 truncate text-[0.7rem] text-muted-foreground"
            title={run.cwd}
          >
            <FolderIcon className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{projectLabel}</span>
            <span aria-hidden="true">/</span>
            <GitBranchIcon className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{branchLabel}</span>
            <span className="hidden sm:inline" aria-hidden="true">
              ·
            </span>
            <span className="hidden sm:inline">{serverName}</span>
            <span className="hidden lg:inline" aria-hidden="true">
              ·
            </span>
            <span className="hidden lg:inline">
              {agent?.name ?? 'Agent'} · {modelDisplayName(run.model, models)}
            </span>
          </p>
        </motion.div>
        <motion.div
          className="flex shrink-0 items-center gap-1.5"
          initial={{ opacity: 0, x: 6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.14, delay: 0.08 }}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Open changes"
            onClick={() => setInspector('changes')}
          >
            <FileDiffIcon />
            <span className="hidden lg:inline">Changes</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Open terminal"
            onClick={() => setInspector('terminal')}
          >
            <SquareTerminalIcon />
            <span className="hidden lg:inline">Terminal</span>
          </Button>
          <RunStatus status={run.status} />
          <span
            role="status"
            aria-label={`Event stream ${connectionState}`}
            className="flex items-center gap-1 text-[11px] text-muted-foreground"
            title={`Event stream: ${connectionState}`}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                connectionState === 'connected' ? 'bg-emerald-500' : 'bg-muted-foreground/60',
              )}
              aria-hidden="true"
            />
            <span className="hidden sm:inline">{titleCase(connectionState)}</span>
          </span>
          <AnimatePresence initial={false}>
            {runIsActive ? (
              <motion.div
                key="cancel-run"
                initial={{ opacity: 0, scale: 0.88 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.88 }}
                transition={{ duration: 0.12 }}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
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
      <Dialog
        open={inspector !== undefined}
        onOpenChange={(open) => {
          if (!open) setInspector(undefined);
        }}
      >
        <DialogContent className="flex h-[min(48rem,calc(100svh-2rem))] max-w-[min(72rem,calc(100vw-2rem))] flex-col overflow-hidden p-0 sm:max-w-[min(72rem,calc(100vw-2rem))]">
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>
              {inspector === 'changes' ? 'Workspace changes' : 'Terminal session'}
            </DialogTitle>
            <DialogDescription>
              {inspector === 'changes'
                ? 'Diffs are read from the run workspace by the supervisor.'
                : 'Commands run as bounded argv processes inside the managed workspace.'}
            </DialogDescription>
          </DialogHeader>
          {inspector === 'changes' ? (
            <ChangesPanel client={client} runId={run.id} />
          ) : (
            <TerminalPanel client={client} cwd={run.cwd} />
          )}
        </DialogContent>
      </Dialog>
      <AnimatePresence>
        {dragActive ? (
          <motion.div
            className="pointer-events-none absolute inset-x-3 top-15 bottom-3 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/90 px-6 text-center shadow-lg"
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
          <MessageScrollerViewport
            ref={transcriptViewportRef}
            aria-label={`${agent?.name ?? 'Agent'} conversation`}
          >
            <MessageScrollerContent className="mx-auto w-[calc(100vw-2.5rem)] max-w-4xl px-5 py-8 md:w-full md:px-8">
              {hasOlderEvents ? (
                <MessageScrollerItem messageId="load-older-transcript">
                  <div className="flex justify-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={loadOlderTranscript}
                      disabled={loadingOlderEvents}
                    >
                      {loadingOlderEvents ? 'Loading older activity…' : 'Load older activity'}
                    </Button>
                  </div>
                </MessageScrollerItem>
              ) : null}
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
                        <BubbleContent>
                          <MarkdownContent content={run.prompt} />
                        </BubbleContent>
                      </Bubble>
                      <PromptAttachments attachments={promptAttachments} />
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
                  transition={{
                    duration: 0.18,
                    delay: 0.06,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                >
                  <Marker variant="separator">
                    <MarkerContent>Activity</MarkerContent>
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
            className="border-t bg-background/95 px-3 py-3 md:px-6"
            onSubmit={submitMessage}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div className="mx-auto flex max-w-4xl flex-col gap-2">
              {attachmentError ? (
                <p role="alert" className="text-xs text-destructive">
                  {attachmentError}
                </p>
              ) : null}
              {attachments.length > 0 ? (
                <AttachmentGroup aria-label="Attached files">
                  {attachments.map((attachment) => {
                    const isImage = attachment.file.type.startsWith('image/');
                    if (isImage && attachment.previewUrl) {
                      return (
                        <ImageAttachmentCard
                          key={attachment.id}
                          name={attachment.file.name}
                          src={attachment.previewUrl}
                          description={`${attachmentTypeLabel(attachment.file)} · ${formatFileSize(attachment.file.size)} · Ready to send`}
                          state="idle"
                          onRemove={() => removeAttachment(attachment.id)}
                        />
                      );
                    }

                    return (
                      <Attachment
                        key={attachment.id}
                        state="idle"
                        size="sm"
                        orientation={isImage ? 'vertical' : 'horizontal'}
                      >
                        <AttachmentMedia variant={isImage ? 'image' : 'icon'}>
                          {isImage ? (
                            <ImageIcon aria-hidden="true" />
                          ) : (
                            attachmentIcon(attachment.file)
                          )}
                        </AttachmentMedia>
                        <AttachmentContent>
                          <AttachmentTitle>{attachment.file.name}</AttachmentTitle>
                          <AttachmentDescription>
                            {attachmentTypeLabel(attachment.file)} {'·'}
                            {formatFileSize(attachment.file.size)} {'·'} Ready to send
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
              <div className="overflow-hidden rounded-2xl border border-border/80 bg-card transition-[border-color] focus-within:border-foreground/30">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="sr-only"
                  aria-label="Files to attach"
                  onChange={handleFileInput}
                  tabIndex={-1}
                />
                <ComposerInput
                  ariaLabel="Message agent"
                  value={message}
                  onChange={setMessage}
                  cwd={run.cwd}
                  client={client}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Send a message to Pi…"
                  disabled={submitting}
                  rows={1}
                  placement="top"
                  className="max-h-32 min-h-14 resize-none rounded-none border-0 bg-transparent px-3.5 py-3 shadow-none focus-visible:ring-0"
                />
                <div className="flex items-center gap-1 px-2 pb-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Attach files"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={submitting}
                    className="rounded-full"
                  >
                    <PaperclipIcon />
                  </Button>
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    {runIsActive ? 'Steer or queue a follow-up' : 'Continue this session'}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    {runIsActive ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void submitSteer()}
                        disabled={submitting || !message.trim()}
                        aria-label="Steer now"
                        className="rounded-full"
                      >
                        Steer now
                      </Button>
                    ) : null}
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
              </div>
            </div>
            <p className="mx-auto mt-1.5 flex max-w-4xl items-center justify-between gap-3 px-1 text-[11px] text-muted-foreground">
              <span>
                {runIsActive
                  ? 'Send queues a follow-up · Steer interrupts at the next safe point'
                  : 'Continue this session with a follow-up'}
              </span>
              <span className="hidden shrink-0 sm:inline">
                Enter to send · Shift+Enter for a new line
              </span>
            </p>
          </motion.form>
        ) : null}
      </MessageScrollerProvider>
    </motion.div>
  );
}

function AgentSettingsDialog({
  client,
  connectionManager,
  servers,
  activeServerId,
  section,
  onSectionChange,
  onServersChange,
  open,
  onOpenChange,
  agents,
  projects,
  submitting,
  darkMode,
  onDarkModeChange,
  appLayout,
  onAppLayoutChange,
  onCreate,
  onUpdate,
  onDelete,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
}: {
  client: Pick<SupervisorClientApi, 'listExtensions' | 'updateExtensions'>;
  connectionManager: ServerConnectionManager;
  servers: ServerDefinition[];
  activeServerId: string | undefined;
  section: SettingsSection;
  onSectionChange(section: SettingsSection): void;
  onServersChange(servers: ServerDefinition[], snapshots: Record<string, ServerSnapshot>): void;
  open: boolean;
  onOpenChange(open: boolean): void;
  agents: ManagedAgentResponse[];
  projects: ManagedProjectResponse[];
  submitting: boolean;
  darkMode: boolean;
  onDarkModeChange(darkMode: boolean): void;
  appLayout: AppLayout;
  onAppLayoutChange(layout: AppLayout): void;
  onCreate(name: string, systemPrompt: string): Promise<ManagedAgentResponse | undefined>;
  onUpdate(agentId: string, name: string, systemPrompt: string): Promise<void>;
  onDelete(agentId: string): Promise<void>;
  onCreateProject(input: {
    name?: string;
    path: string;
  }): Promise<ManagedProjectResponse | undefined>;
  onUpdateProject(
    projectId: string,
    input: { name?: string; path?: string },
  ): Promise<ManagedProjectResponse | undefined>;
  onDeleteProject(project: ManagedProjectResponse): Promise<boolean>;
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
                  variant={section === 'servers' ? 'secondary' : 'ghost'}
                  className="w-full justify-start"
                  aria-current={section === 'servers' ? 'page' : undefined}
                  onClick={() => onSectionChange('servers')}
                >
                  <ServerIcon data-icon="inline-start" />
                  Servers
                  <Badge variant="outline" className="ml-auto">
                    {servers.length}
                  </Badge>
                </Button>
                <Button
                  variant={section === 'appearance' ? 'secondary' : 'ghost'}
                  className="w-full justify-start"
                  aria-current={section === 'appearance' ? 'page' : undefined}
                  onClick={() => onSectionChange('appearance')}
                >
                  <SunIcon data-icon="inline-start" />
                  Appearance
                </Button>
                <Button
                  variant={section === 'projects' ? 'secondary' : 'ghost'}
                  className="w-full justify-start"
                  aria-current={section === 'projects' ? 'page' : undefined}
                  onClick={() => onSectionChange('projects')}
                >
                  <FolderIcon data-icon="inline-start" />
                  Projects
                  <Badge variant="outline" className="ml-auto">
                    {projects.length}
                  </Badge>
                </Button>
                <Button
                  variant={section === 'agents' ? 'secondary' : 'ghost'}
                  className="w-full justify-start"
                  aria-current={section === 'agents' ? 'page' : undefined}
                  onClick={() => onSectionChange('agents')}
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
                  onClick={() => onSectionChange('skills')}
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
                  onClick={() => onSectionChange('extensions')}
                >
                  <PuzzleIcon data-icon="inline-start" />
                  Extensions
                  <Badge variant="outline" className="ml-auto">
                    Pi
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
              {section === 'servers' ? (
                <ServersSettingsPage
                  servers={servers}
                  activeServerId={activeServerId}
                  connectionManager={connectionManager}
                  onServersChange={onServersChange}
                />
              ) : section === 'projects' ? (
                <KnownProjectsSettingsPage
                  projects={projects}
                  submitting={submitting}
                  onCreate={onCreateProject}
                  onUpdate={onUpdateProject}
                  onDelete={onDeleteProject}
                />
              ) : section === 'agents' ? (
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
                            transition={{
                              duration: 0.16,
                              delay: Math.min(index, 6) * 0.03,
                            }}
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
                <AppearanceSettingsPage
                  darkMode={darkMode}
                  onDarkModeChange={onDarkModeChange}
                  appLayout={appLayout}
                  onAppLayoutChange={onAppLayoutChange}
                />
              ) : (
                <ExtensionsSettingsPage client={client} />
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

function ServersSettingsPage({
  servers,
  activeServerId,
  connectionManager,
  onServersChange,
}: {
  servers: ServerDefinition[];
  activeServerId: string | undefined;
  connectionManager: ServerConnectionManager;
  onServersChange(servers: ServerDefinition[], snapshots: Record<string, ServerSnapshot>): void;
}) {
  const [editing, setEditing] = useState<ServerDefinition | 'new'>();
  const [removing, setRemoving] = useState<ServerDefinition>();
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState<string>();

  async function refreshConnections() {
    const nextServers = await connectionManager.list();
    const results = await Promise.allSettled(
      nextServers.map(async (server) => {
        const nextClient = connectionManager.client(server);
        return loadServerSnapshot(server, nextClient);
      }),
    );
    const nextSnapshots: Record<string, ServerSnapshot> = {};
    const failures: string[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        nextSnapshots[result.value.server.id] = result.value;
        const degraded = Object.entries(result.value.resources)
          .filter(([, resource]) => resource.status !== 'live')
          .map(([name, resource]) => `${name}: ${resource.error ?? 'stale'}`);
        if (degraded.length > 0)
          failures.push(`${result.value.server.name}: ${degraded.join(', ')}`);
      } else
        failures.push(`${nextServers[index]?.name ?? 'Server'}: ${errorMessage(result.reason)}`);
    });
    onServersChange(nextServers, nextSnapshots);
    setPageError(failures.length > 0 ? failures.join('\n') : undefined);
  }

  async function saveServer(input: ServerInput) {
    setBusy(true);
    setPageError(undefined);
    try {
      await connectionManager.save(input);
      await refreshConnections();
      setEditing(undefined);
    } catch (reason) {
      setPageError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function removeServer() {
    if (!removing) return;
    setBusy(true);
    setPageError(undefined);
    try {
      await connectionManager.remove(removing.id);
      await refreshConnections();
      setRemoving(undefined);
    } catch (reason) {
      setPageError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <motion.div
        className="mx-auto flex max-w-3xl flex-col gap-5"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="flex flex-col items-start gap-4 pr-8 sm:flex-row sm:justify-between">
          <div>
            <h3 className="text-xl font-semibold tracking-tight">Servers</h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              Connect piDeck to every supervisor you use. Sessions from connected servers appear
              together in the sidebar.
            </p>
          </div>
          <Button className="shrink-0" onClick={() => setEditing('new')}>
            <PlusIcon data-icon="inline-start" />
            Add server
          </Button>
        </div>

        {pageError ? (
          <Alert variant="destructive">
            <AlertTitle>Some servers could not connect</AlertTitle>
            <AlertDescription className="whitespace-pre-line">{pageError}</AlertDescription>
          </Alert>
        ) : null}

        {servers.length === 0 ? (
          <Empty className="min-h-72 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ServerIcon />
              </EmptyMedia>
              <EmptyTitle>No servers configured</EmptyTitle>
              <EmptyDescription>
                Add a server address and access token to load sessions from that supervisor.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setEditing('new')}>Add your first server</Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ul className="overflow-hidden rounded-xl border" aria-label="Configured servers">
            {servers.map((server, index) => (
              <li key={server.id}>
                {index > 0 ? <Separator /> : null}
                <div className="flex items-center gap-3 px-4 py-3.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <ServerIcon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">{server.name}</span>
                      {server.id === activeServerId ? (
                        <Badge variant="secondary">Active</Badge>
                      ) : null}
                      {server.isBuiltin ? <Badge variant="outline">Built-in</Badge> : null}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                      {server.address}
                    </span>
                    <span className="mt-1 block text-[0.7rem] text-muted-foreground/75">
                      {server.isBuiltin
                        ? 'Runs inside this Electron app'
                        : server.hasToken
                          ? 'Access token stored securely'
                          : 'No access token'}
                    </span>
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit server ${server.name}`}
                      title="Edit server"
                      disabled={busy || server.isBuiltin}
                      onClick={() => setEditing(server)}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove server ${server.name}`}
                      title="Remove server"
                      disabled={busy || server.isBuiltin}
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setRemoving(server)}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </motion.div>

      <ServerEditorDialog
        server={editing === 'new' ? undefined : editing}
        open={editing !== undefined}
        busy={busy}
        onOpenChange={(open) => {
          if (!open && !busy) setEditing(undefined);
        }}
        onSave={saveServer}
      />

      <Dialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove server?</DialogTitle>
            <DialogDescription>
              {removing
                ? `Remove “${removing.name}” and its saved credentials from this client. The server and its sessions will not be changed.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void removeServer()}
            >
              Remove server
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ServerEditorDialog({
  server,
  open,
  busy,
  onOpenChange,
  onSave,
}: {
  server: ServerDefinition | undefined;
  open: boolean;
  busy: boolean;
  onOpenChange(open: boolean): void;
  onSave(input: ServerInput): Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <ServerEditorForm key={server?.id ?? 'new'} server={server} busy={busy} onSave={onSave} />
      ) : null}
    </Dialog>
  );
}

function ServerEditorForm({
  server,
  busy,
  onSave,
}: {
  server: ServerDefinition | undefined;
  busy: boolean;
  onSave(input: ServerInput): Promise<void>;
}) {
  const [name, setName] = useState(server?.name ?? '');
  const [address, setAddress] = useState(
    server?.address.startsWith('/') ? window.location.origin : (server?.address ?? ''),
  );
  const [token, setToken] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !address.trim()) return;
    await onSave({
      ...(server ? { id: server.id } : {}),
      name: name.trim(),
      address: address.trim(),
      ...(token ? { token } : {}),
    });
  }

  return (
    <DialogContent className="sm:max-w-xl">
      <form onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{server ? 'Edit server' : 'Add server'}</DialogTitle>
          <DialogDescription>
            Use the origin where the piDeck server listens. Credentials stay in this Electron client
            and are never exposed to the page.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="py-6">
          <Field>
            <FieldLabel htmlFor="server-name">Name</FieldLabel>
            <Input
              id="server-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Build machine"
              autoFocus
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="server-address">Server address</FieldLabel>
            <Input
              id="server-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="https://agents.example.com"
              inputMode="url"
              autoComplete="url"
              required
            />
            <FieldDescription>
              Enter an http:// or https:// origin without an API path.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="server-token">Access token</FieldLabel>
            <Input
              id="server-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={
                server?.hasToken ? 'Leave blank to keep the saved token' : 'Server token'
              }
              autoComplete="off"
            />
            <FieldDescription>
              {server?.hasToken
                ? 'A token is already stored. Enter a new value only to replace it.'
                : 'Optional for local servers; required for connections from another machine.'}
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" disabled={busy || !name.trim() || !address.trim()}>
            {busy ? 'Connecting…' : server ? 'Save changes' : 'Add server'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function KnownProjectsSettingsPage({
  projects,
  submitting,
  onCreate,
  onUpdate,
  onDelete,
}: {
  projects: ManagedProjectResponse[];
  submitting: boolean;
  onCreate(input: { name?: string; path: string }): Promise<ManagedProjectResponse | undefined>;
  onUpdate(
    projectId: string,
    input: { name?: string; path?: string },
  ): Promise<ManagedProjectResponse | undefined>;
  onDelete(project: ManagedProjectResponse): Promise<boolean>;
}) {
  const [editing, setEditing] = useState<ManagedProjectResponse | 'new'>();
  const [projectToDelete, setProjectToDelete] = useState<ManagedProjectResponse>();

  async function confirmDelete() {
    if (!projectToDelete) return;
    const deleted = await onDelete(projectToDelete);
    if (deleted) setProjectToDelete(undefined);
  }

  return (
    <>
      <motion.div
        className="mx-auto flex max-w-3xl flex-col gap-5"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="flex items-start justify-between gap-4 pr-8">
          <div>
            <h3 className="text-xl font-semibold tracking-tight">Known projects</h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              Save the workspaces you return to often. They will be ready in the new-session project
              picker.
            </p>
          </div>
          <Button onClick={() => setEditing('new')}>
            <PlusIcon data-icon="inline-start" />
            Add project
          </Button>
        </div>

        {projects.length === 0 ? (
          <Empty className="min-h-72 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderIcon />
              </EmptyMedia>
              <EmptyTitle>No known projects</EmptyTitle>
              <EmptyDescription>
                Add a workspace once and it will stay available across new sessions.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setEditing('new')}>Add your first project</Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ul className="overflow-hidden rounded-xl border" aria-label="Known projects">
            <AnimatePresence initial={false} mode="popLayout">
              {projects.map((project, index) => (
                <motion.li
                  key={project.id}
                  layout
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{
                    duration: 0.16,
                    delay: Math.min(index, 6) * 0.03,
                  }}
                >
                  {index > 0 ? <Separator /> : null}
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <FolderIcon className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{project.name}</span>
                      <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                        {project.path}
                      </span>
                      <span className="mt-1 block text-[0.7rem] text-muted-foreground/75">
                        Last used {formatRelativeDate(project.lastUsedAt)}
                      </span>
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit project ${project.name}`}
                        title="Edit project"
                        disabled={submitting}
                        onClick={() => setEditing(project)}
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete project ${project.name}`}
                        title="Delete project"
                        disabled={submitting}
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setProjectToDelete(project)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </motion.div>

      <ProjectEditorDialog
        projects={projects}
        project={editing === 'new' ? undefined : editing}
        open={editing !== undefined}
        submitting={submitting}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
        onCreate={async (name, path) => {
          const created = await onCreate({ name, path });
          if (created) setEditing(undefined);
        }}
        onUpdate={async (projectId, name, path) => {
          const updated = await onUpdate(projectId, { name, path });
          if (updated) setEditing(undefined);
        }}
      />

      <Dialog
        open={projectToDelete !== undefined}
        onOpenChange={(open) => {
          if (!open && !submitting) setProjectToDelete(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove known project?</DialogTitle>
            <DialogDescription>
              {projectToDelete
                ? `Remove “${projectToDelete.name}” from piDeck. Files on disk will not be changed.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={submitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={submitting}
              onClick={() => void confirmDelete()}
            >
              Remove project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProjectEditorDialog({
  projects,
  project,
  open,
  submitting,
  onOpenChange,
  onCreate,
  onUpdate,
}: {
  projects: ManagedProjectResponse[];
  project: ManagedProjectResponse | undefined;
  open: boolean;
  submitting: boolean;
  onOpenChange(open: boolean): void;
  onCreate(name: string, path: string): Promise<void>;
  onUpdate(projectId: string, name: string, path: string): Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ProjectEditorForm
        key={project?.id ?? 'new'}
        projects={projects}
        project={project}
        submitting={submitting}
        onCreate={onCreate}
        onUpdate={onUpdate}
      />
    </Dialog>
  );
}

function ProjectEditorForm({
  projects,
  project,
  submitting,
  onCreate,
  onUpdate,
}: {
  projects: ManagedProjectResponse[];
  project: ManagedProjectResponse | undefined;
  submitting: boolean;
  onCreate(name: string, path: string): Promise<void>;
  onUpdate(projectId: string, name: string, path: string): Promise<void>;
}) {
  const [name, setName] = useState(project?.name ?? '');
  const [path, setPath] = useState(project?.path ?? '');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const nextPath = path.trim();
    const nextName = name.trim() || projectNameFromPath(nextPath);
    if (!nextPath || !nextName) return;
    if (project) await onUpdate(project.id, nextName, nextPath);
    else await onCreate(nextName, nextPath);
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
          <DialogTitle>{project ? 'Edit known project' : 'Add known project'}</DialogTitle>
          <DialogDescription>
            Save a workspace for quick access from the new-session project picker. Removing it never
            deletes files on disk.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="py-6">
          <Field>
            <FieldLabel htmlFor="project-name">Display name</FieldLabel>
            <Input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="piDeck"
            />
            <FieldDescription>Leave blank to use the folder name.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="project-path">Working directory</FieldLabel>
            <ProjectPathAutocomplete
              id="project-path"
              projects={projects}
              path={path}
              onPathChange={setPath}
              disabled={submitting}
              required
              placeholder="/path/to/project"
            />
            <FieldDescription>
              The directory must exist on the machine running the supervisor.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={submitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" disabled={submitting || !path.trim()}>
            {project ? 'Save changes' : 'Add project'}
          </Button>
        </DialogFooter>
      </motion.form>
    </DialogContent>
  );
}

function AppearanceSettingsPage({
  darkMode,
  onDarkModeChange,
  appLayout,
  onAppLayoutChange,
}: {
  darkMode: boolean;
  onDarkModeChange(darkMode: boolean): void;
  appLayout: AppLayout;
  onAppLayoutChange(layout: AppLayout): void;
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

      <div className="rounded-xl border p-4">
        <div>
          <h4 className="font-medium">Workspace layout</h4>
          <p className="mt-1 text-sm text-muted-foreground">
            Keep every session in a navigation rail, or move active work into a compact tab bar.
          </p>
        </div>
        <div
          className="mt-4 grid gap-2 sm:grid-cols-2"
          role="radiogroup"
          aria-label="Workspace layout"
        >
          <Button
            type="button"
            role="radio"
            aria-checked={appLayout === 'sidebar'}
            variant={appLayout === 'sidebar' ? 'secondary' : 'outline'}
            className="h-auto justify-start gap-3 p-3 text-left"
            onClick={() => onAppLayoutChange('sidebar')}
          >
            <span className="flex size-12 shrink-0 overflow-hidden rounded-lg border bg-background p-1.5">
              <span className="w-3 rounded-sm bg-muted" />
              <span className="ml-1 flex flex-1 flex-col gap-1 pt-0.5">
                <span className="h-1 rounded-full bg-muted-foreground/35" />
                <span className="h-1 w-3/4 rounded-full bg-muted-foreground/20" />
              </span>
            </span>
            <span className="min-w-0">
              <span className="block font-medium">Sidebar</span>
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                Scan full session context
              </span>
            </span>
          </Button>
          <Button
            type="button"
            role="radio"
            aria-checked={appLayout === 'tabs'}
            variant={appLayout === 'tabs' ? 'secondary' : 'outline'}
            className="h-auto justify-start gap-3 p-3 text-left"
            onClick={() => onAppLayoutChange('tabs')}
          >
            <span className="flex size-12 shrink-0 flex-col overflow-hidden rounded-lg border bg-background p-1.5">
              <span className="flex h-2 gap-1">
                <span className="w-3 rounded-sm bg-muted-foreground/35" />
                <span className="w-4 rounded-sm bg-muted" />
                <span className="w-3 rounded-sm bg-muted" />
              </span>
              <span className="mt-1 flex-1 rounded-sm bg-muted/60" />
            </span>
            <span className="min-w-0">
              <span className="block font-medium">Tabs</span>
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                OpenCode-style compact sessions
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
  const [query, setQuery] = useState('');
  const visibleSkills = AVAILABLE_SKILLS.filter((skill) =>
    `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <>
      <motion.div
        className="mx-auto flex max-w-3xl flex-col gap-5"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="flex items-start justify-between gap-4 pr-8">
          <div>
            <h3 className="text-xl font-semibold tracking-tight">Skills</h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              Browse the skill catalog bundled with this piDeck build and inspect its source files.
            </p>
          </div>
          <Badge variant="outline" className="mt-1 shrink-0">
            {AVAILABLE_SKILLS.length} available
          </Badge>
        </div>

        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter skills…"
            aria-label="Filter skills"
            className="pl-9"
          />
        </div>

        {visibleSkills.length > 0 ? (
          <ul className="overflow-hidden rounded-xl border" aria-label="Available skills">
            {visibleSkills.map((skill, index) => (
              <li key={skill.name}>
                {index > 0 ? <Separator /> : null}
                <button
                  type="button"
                  className="group flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50"
                  onClick={() => setSelectedSkill(skill)}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                    <BookOpenIcon className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{skill.name}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      {skill.description}
                    </span>
                  </span>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {skill.files.length} files
                  </span>
                  <ChevronRightIcon
                    className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed px-5 py-10 text-center">
            <p className="text-sm font-medium">No matching skills</p>
            <p className="mt-1 text-sm text-muted-foreground">Try a broader name or workflow.</p>
          </div>
        )}
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

function ExtensionsSettingsPage({
  client,
}: {
  client: Pick<SupervisorClientApi, 'listExtensions' | 'updateExtensions'>;
}) {
  const [data, setData] = useState<ManagedAgentExtensionsResponse>();
  const [loadError, setLoadError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatingSource, setUpdatingSource] = useState<string>();

  const loadExtensions = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setLoadError(undefined);
      try {
        setData(await client.listExtensions());
      } catch (reason) {
        setLoadError(errorMessage(reason));
      } finally {
        if (refresh) setRefreshing(false);
        else setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void loadExtensions();
  }, [loadExtensions]);

  async function updateExtensions(source?: string) {
    const updateKey = source ?? '__all__';
    setUpdatingSource(updateKey);
    setLoadError(undefined);
    try {
      setData(await client.updateExtensions(source));
    } catch (reason) {
      setLoadError(errorMessage(reason));
    } finally {
      setUpdatingSource(undefined);
    }
  }

  const extensions = data?.extensions ?? [];
  const updateCount = extensions.filter(
    (extension) => extension.status === 'update_available',
  ).length;
  const unknownCount = extensions.filter((extension) => extension.status === 'unknown').length;
  const updateSummary = data?.updateCheckError
    ? 'Check failed'
    : updateCount > 0
      ? `${updateCount} update${updateCount === 1 ? '' : 's'}`
      : unknownCount > 0
        ? `${unknownCount} unchecked`
        : 'All current';

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
            Every extension Pi resolves for this environment, including local files and installed
            packages.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {data ? (
            <Badge variant={updateCount > 0 ? 'secondary' : 'outline'}>{updateSummary}</Badge>
          ) : null}
          {updateCount > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void updateExtensions()}
              disabled={updatingSource !== undefined}
            >
              {updatingSource === '__all__' ? (
                <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
              ) : (
                <DownloadIcon data-icon="inline-start" />
              )}
              {updatingSource === '__all__' ? 'Updating…' : 'Update all'}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void loadExtensions(true)}
            disabled={loading || refreshing}
          >
            <LoaderCircleIcon
              className={cn(refreshing && 'animate-spin')}
              data-icon="inline-start"
            />
            Refresh
          </Button>
        </div>
      </div>

      {data?.updateCheckError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not check for extension updates</AlertTitle>
          <AlertDescription>{data.updateCheckError}</AlertDescription>
        </Alert>
      ) : null}
      {loadError ? (
        <Alert variant="destructive">
          <AlertTitle>Extension discovery failed</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <div
          className="flex min-h-72 items-center justify-center rounded-xl border text-sm text-muted-foreground"
          role="status"
        >
          <LoaderCircleIcon className="mr-2 size-4 animate-spin" />
          Discovering Pi extensions…
        </div>
      ) : extensions.length === 0 ? (
        <Empty className="min-h-72 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PuzzleIcon />
            </EmptyMedia>
            <EmptyTitle>No extensions found</EmptyTitle>
            <EmptyDescription>
              Pi has no enabled extension files in its global or project extension locations.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="overflow-hidden rounded-xl border" aria-label="Installed extensions">
          {extensions.map((extension, index) => (
            <ExtensionRow
              key={extension.id}
              extension={extension}
              index={index}
              updating={updatingSource === extension.source}
              onUpdate={() => void updateExtensions(extension.source)}
            />
          ))}
        </ul>
      )}
    </motion.div>
  );
}

function ExtensionRow({
  extension,
  index,
  updating,
  onUpdate,
}: {
  extension: ManagedAgentExtension;
  index: number;
  updating: boolean;
  onUpdate(): void;
}) {
  const status = extensionStatusLabel(extension);
  const isUpdateAvailable = extension.status === 'update_available';

  return (
    <li>
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
          <span
            className="mt-1 block truncate font-mono text-xs text-muted-foreground"
            title={extension.path}
          >
            {extension.version ? `v${extension.version}` : extension.relativePath} ·{' '}
            {extension.scope}
          </span>
        </span>
        <span className="flex shrink-0 items-center justify-end">
          {isUpdateAvailable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onUpdate}
              disabled={updating}
              aria-label={`Update ${extension.name}`}
            >
              {updating ? (
                <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
              ) : (
                <DownloadIcon data-icon="inline-start" />
              )}
              {updating ? 'Updating…' : 'Update'}
            </Button>
          ) : (
            <Badge
              variant="outline"
              className={cn(
                extension.status === 'up_to_date' || extension.status === 'local'
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-muted-foreground',
              )}
            >
              {status}
            </Badge>
          )}
        </span>
      </div>
    </li>
  );
}

function extensionStatusLabel(extension: ManagedAgentExtension): string {
  switch (extension.status) {
    case 'up_to_date':
      return 'Up to date';
    case 'local':
      return 'Local';
    case 'disabled':
      return 'Disabled';
    case 'unknown':
      return 'Update status unavailable';
    case 'update_available':
      return 'Update available';
  }
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
  transition: {
    duration: number;
    delay: number;
    ease: readonly [number, number, number, number];
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const hasError = item.events.some((event) => event.kind === 'error');
  const visibleEvents = collapseThinkingMarkers(item.events);
  const summary = visibleEvents.at(-1);
  const fileEvent = [...visibleEvents]
    .reverse()
    .find((event) => event.kind === 'marker' && event.filePath);

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
          className="group/event flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronRightIcon
            className="size-3.5 shrink-0 transition-transform duration-150 group-aria-expanded/event:rotate-90"
            aria-hidden="true"
          />
          <span
            className={cn(
              'min-w-0 truncate font-medium',
              hasError ? 'text-destructive' : 'text-foreground',
              summary?.kind === 'marker' && summary.shimmer && 'shimmer',
            )}
          >
            {summary?.label ?? 'Activity'}
          </span>
          {item.events.length > 1 ? (
            <span className="shrink-0 text-muted-foreground/70">{item.events.length} events</span>
          ) : null}
          {fileEvent?.kind === 'marker' && fileEvent.filePath ? (
            <FileNameBadge filePath={fileEvent.filePath} />
          ) : null}
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
              className="mt-1 ml-4 flex flex-col border-l pl-3"
            >
              {visibleEvents.map((event) => (
                <div key={event.id} className="py-1">
                  <EventMarker item={event} />
                </div>
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

function FileNameBadge({ filePath }: { filePath: string }) {
  const normalizedPath = filePath.replaceAll('\\', '/');
  const fileName = normalizedPath.split('/').at(-1) || filePath;

  return (
    <Badge variant="outline" title={filePath}>
      {fileName}
    </Badge>
  );
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
        {item.kind === 'marker' && item.filePath ? (
          <>
            {' '}
            <FileNameBadge filePath={item.filePath} />
          </>
        ) : null}
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
          <section aria-label="Tool call arguments">
            <pre className="overflow-x-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words">
              {formatToolArguments(item.toolArguments)}
            </pre>
          </section>
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
        <Badge
          variant={status === 'failed' ? 'destructive' : 'secondary'}
          className="h-5 px-1.5 text-[10px]"
        >
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
  return {
    provider: value.slice(0, separator),
    id: value.slice(separator + 1),
  };
}

function sessionTitle(prompt: string): string {
  const firstLine = prompt.split('\n', 1)[0]?.trim() ?? '';
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine || 'Untitled session';
}

function sessionKey(serverId: string, runId: string): string {
  return `${serverId}:${runId}`;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message;
  return 'The supervisor could not complete the request.';
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatRelativeDate(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return formatTime(value);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date);
}
