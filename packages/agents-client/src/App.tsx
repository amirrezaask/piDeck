import type {
  AgentImageAttachment,
  AgentModel,
  AgentSystemPromptMode,
  AgentThinkingLevel,
  InboxItemResponse,
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
  ArrowUpIcon,
  BookOpenIcon,
  BotIcon,
  BrainIcon,
  BugIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleStopIcon,
  DownloadIcon,
  FileDiffIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  ImageIcon,
  InboxIcon,
  ListEndIcon,
  LoaderCircleIcon,
  MoonIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  PuzzleIcon,
  RouteIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SquareTerminalIcon,
  SunIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from 'motion/react';
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  lazy,
  Suspense,
  type SVGProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { type ComposerCommand, ComposerInput } from '@agents/components/composer-input';
import { MarkdownContent } from '@agents/components/markdown-content';
import { CommandPalette, type ServerOperationsClient } from '@agents/components/operations';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@agents/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@agents/components/ui/alert';
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
} from '@agents/components/ui/attachment';
import { Avatar, AvatarFallback } from '@agents/components/ui/avatar';
import { Badge } from '@agents/components/ui/badge';
import { Bubble, BubbleContent } from '@agents/components/ui/bubble';
import { Button } from '@agents/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@agents/components/ui/card';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@agents/components/ui/command';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@agents/components/ui/dialog';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@agents/components/ui/empty';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@agents/components/ui/field';
import { Input } from '@agents/components/ui/input';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@agents/components/ui/resizable';

const ChangesPanel = lazy(() =>
  import('@agents/components/changes-panel').then(({ ChangesPanel: Component }) => ({
    default: Component,
  })),
);

const DebugPanel = lazy(() =>
  import('@agents/components/debug-panel').then(({ DebugPanel: Component }) => ({
    default: Component,
  })),
);

const GhosttyMultiplexer = lazy(() =>
  import('@pideck/terminal-multiplexer/client').then(({ GhosttyMultiplexer: Component }) => ({
    default: Component,
  })),
);

import { Marker, MarkerContent } from '@agents/components/ui/marker';
import { Message, MessageContent, MessageFooter, MessageHeader } from '@agents/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@agents/components/ui/message-scroller';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@agents/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@agents/components/ui/select';
import { Separator } from '@agents/components/ui/separator';
import { Switch } from '@agents/components/ui/switch';
import { Textarea } from '@agents/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@agents/components/ui/toggle-group';
import { TooltipProvider } from '@agents/components/ui/tooltip';
import { activitySince, readCheckedActivity, writeCheckedActivity } from '@agents/lib/activity-state';
import { ApiError } from '@agents/lib/api-error';
import { useComposerDraft } from '@agents/lib/composer-draft';
import { LruCache } from '@agents/lib/lru';
import {
  type ServerConnectionManager,
  type ServerDefinition,
  type ServerInput,
  serverConnectionManager,
} from '@agents/lib/server-connections';
import { AVAILABLE_SKILLS } from '@agents/lib/skills';
import {
  beginSubmission,
  completeSubmission,
  isUncertainSubmissionError,
  markSubmissionFailed,
  markSubmissionUncertain,
  readSubmissions,
  rememberSubmissionReceipt,
  type SubmissionRecord,
} from '@agents/lib/submissions';
import {
  modelDisplayName,
  type StreamConnectionState,
  type SupervisorClient,
  supervisorClient,
} from '@agents/lib/supervisor-client';
import {
  collapseThinkingMarkers,
  mapPiEvents,
  mergeTranscriptEvents,
  prependTranscriptEvents,
  TRANSCRIPT_EVENT_WINDOW,
  type TranscriptEvent,
} from '@agents/lib/transcript';
import { cn } from '@agents/lib/utils';

const DEFAULT_AGENT_INSTRUCTIONS =
  'Inspect the workspace carefully, explain consequential decisions, and verify your work before finishing.';

interface AgentEditorSettings {
  readonly name: string;
  readonly systemPrompt: string;
  readonly systemPromptMode: AgentSystemPromptMode;
  readonly toolCallsEnabled: boolean;
}
const THINKING_LEVELS: readonly AgentThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

type SettingsSection = 'servers' | 'agents' | 'projects' | 'skills' | 'extensions' | 'appearance';

const THEME_STORAGE_KEY = 'pideck-theme';
const CHANGES_PANEL_SIZE_STORAGE_KEY = 'pideck-changes-panel-size';
const TERMINAL_PANEL_SIZE_STORAGE_KEY = 'pideck-terminal-panel-size';
const RUN_ATTACHMENT_CACHE_LIMIT = 24;
const LATEST_TRANSCRIPT_PAGE_SIZE = 500;
const MAX_COMPOSER_CHARACTERS = 1_000_000;
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_ATTACHMENT_BYTES = 6_000_000;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_INPUT_ACCEPT = [...SUPPORTED_IMAGE_MIME_TYPES].join(',');

type AppRoute =
  | { kind: 'default' }
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

function agentRoutePath(): string {
  if (typeof window === 'undefined') return '/';
  const path = window.location.pathname;
  if (path === '/agents') return '/';
  return path.startsWith('/agents/') ? path.slice('/agents'.length) : path;
}

function agentRouteBasePath(): string {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/agents')
    ? '/agents'
    : '';
}

function readAppRoute(): AppRoute {
  if (typeof window === 'undefined') return { kind: 'default' };
  const pathname = agentRoutePath();

  const serverMatch = pathname.match(/^\/servers\/([^/]+)\/sessions\/([^/]+)\/?$/);
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

  const legacyMatch = pathname.match(/^\/sessions\/([^/]+)\/?$/);
  if (legacyMatch?.[1]) {
    try {
      return { kind: 'session', runId: decodeURIComponent(legacyMatch[1]) };
    } catch {
      return { kind: 'default' };
    }
  }

  return pathname === '/new' ? { kind: 'new' } : { kind: 'default' };
}

function writeAppRoute(route: AppRoute, replace = false) {
  if (typeof window === 'undefined') return;

  const relativePath =
    route.kind === 'session'
      ? route.serverId
        ? `/servers/${encodeURIComponent(route.serverId)}/sessions/${encodeURIComponent(route.runId)}`
        : `/sessions/${encodeURIComponent(route.runId)}`
      : route.kind === 'new'
        ? '/new'
        : '/';
  const path = `${agentRouteBasePath()}${relativePath}`;
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
  | 'getRunDebugLog'
  | 'createWorktree'
  | 'listWorktrees'
  | 'releaseWorktree'
  | 'listSessionTerminals'
  | 'createSessionTerminal'
  | 'closeSessionTerminal'
  | 'openSessionTerminalSocket'
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
  const initialRouteRef = useRef(initialRoute);
  const [workspaceView, setWorkspaceView] = useState<'overview' | 'new'>(() =>
    initialRoute.kind === 'new' ? 'new' : 'overview',
  );
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
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [connectionState, setConnectionState] = useState<StreamConnectionState>('stale');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [checkedActivity, setCheckedActivity] = useState(readCheckedActivity);
  const [inboxBySession, setInboxBySession] = useState<Record<string, InboxItemResponse[]>>({});
  const agentCommandLockRef = useRef(false);

  const sessions = useMemo<ServerSession[]>(
    () =>
      Object.values(snapshots).flatMap((snapshot) =>
        snapshot.runs.map((run) => ({ serverId: snapshot.server.id, run })),
      ),
    [snapshots],
  );
  const visibleSessions = sessions;
  const run = runs.find((candidate) => candidate.id === selectedRunId);
  const selectedAgent = agents.find((agent) => agent.id === run?.agentId);
  const activeServer = servers.find((server) => server.id === activeServerId);
  const selectedSessionKey =
    activeServerId && selectedRunId ? sessionKey(activeServerId, selectedRunId) : undefined;
  const uncheckedSessionCount = useMemo(
    () =>
      visibleSessions.filter((session) => {
        const key = sessionKey(session.serverId, session.run.id);
        return (
          key !== selectedSessionKey &&
          (activitySince(session.run.latestEventSequence, checkedActivity[key] ?? 0) > 0 ||
            (inboxBySession[key]?.length ?? 0) > 0)
        );
      }).length,
    [checkedActivity, inboxBySession, selectedSessionKey, visibleSessions],
  );
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
  const globalInboxRequest = useMemo(() => {
    for (const [key, items] of Object.entries(inboxBySession)) {
      if (key === selectedSessionKey || items.length === 0) continue;
      const session = sessions.find(
        (candidate) => sessionKey(candidate.serverId, candidate.run.id) === key,
      );
      const request = items[0];
      const requestClient = session ? snapshots[session.serverId]?.client : undefined;
      if (request && requestClient) return { key, request, client: requestClient };
    }
    return undefined;
  }, [inboxBySession, selectedSessionKey, sessions, snapshots]);
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
    writeCheckedActivity(checkedActivity);
  }, [checkedActivity]);

  useEffect(() => {
    const handlePopState = () => {
      const route = readAppRoute();
      if (route.kind !== 'session') {
        setSelectedRunId(undefined);
        setWorkspaceView(route.kind === 'new' ? 'new' : 'overview');
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
          .at(0);
        const targetSnapshot =
          routeSnapshot ?? firstSession?.snapshot ?? Object.values(nextSnapshots)[0];
        if (targetSnapshot) {
          activateSnapshot(targetSnapshot, routeRunId);
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
    let timer: number | undefined;

    const schedule = (delay: number) => {
      if (!active) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), delay);
    };

    const refresh = async () => {
      if (!active) return;
      if (document.hidden || window.navigator.onLine === false) {
        schedule(document.hidden ? 30_000 : 10_000);
        return;
      }
      const currentSnapshots = Object.values(snapshotsRef.current);
      if (currentSnapshots.length === 0) {
        schedule(5_000);
        return;
      }

      const results = await Promise.all(
        currentSnapshots.map(async (snapshot) => {
          const [runPage, inbox] = await Promise.allSettled([
            snapshot.client.listRuns({ limit: 100 }),
            snapshot.client.listInbox(),
          ]);
          return { snapshot, runPage, inbox };
        }),
      );
      if (!active) return;

      let failures = 0;
      const refreshedInbox: Array<{ serverId: string; items: InboxItemResponse[] }> = [];
      const nextSnapshots = { ...snapshotsRef.current };
      for (const { snapshot, runPage, inbox } of results) {
        if (runPage.status === 'rejected' || inbox.status === 'rejected') failures += 1;
        const nextRuns =
          runPage.status === 'fulfilled'
            ? mergeRuns(runPage.value.runs, snapshot.runs)
            : snapshot.runs;
        if (inbox.status === 'fulfilled') {
          refreshedInbox.push({
            serverId: snapshot.server.id,
            items: inbox.value.items.filter((item) => item.status === 'pending'),
          });
        }
        nextSnapshots[snapshot.server.id] = {
          ...snapshot,
          runs: nextRuns,
          resources: {
            ...snapshot.resources,
            runs:
              runPage.status === 'fulfilled'
                ? { status: 'live', checkedAt: new Date().toISOString() }
                : {
                    status: 'stale',
                    checkedAt: new Date().toISOString(),
                    error: errorMessage(runPage.reason),
                  },
          },
        };
        if (snapshot.server.id === activeServerId) setRuns(nextRuns);
      }
      snapshotsRef.current = nextSnapshots;
      setSnapshots(nextSnapshots);
      setInboxBySession((current) => {
        const next = { ...current };
        for (const { serverId, items } of refreshedInbox) {
          for (const key of Object.keys(next)) {
            if (key.startsWith(`${serverId}:`)) delete next[key];
          }
          for (const item of items) {
            if (!item.runId) continue;
            const key = sessionKey(serverId, item.runId);
            next[key] = [...(next[key] ?? []), item];
          }
        }
        return next;
      });
      schedule(failures > 0 ? 8_000 : 4_000);
    };

    const handleVisibility = () => schedule(document.hidden ? 30_000 : 0);
    document.addEventListener('visibilitychange', handleVisibility);
    schedule(0);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [activeServerId, servers]);

  useEffect(() => {
    document.title = uncheckedSessionCount > 0 ? `(${uncheckedSessionCount}) piDeck` : 'piDeck';
  }, [uncheckedSessionCount]);

  useEffect(() => {
    if (!selectedSessionKey || !run) return;
    const latestSequence = Math.max(run.latestEventSequence ?? 0, events.at(-1)?.sequence ?? 0);
    setCheckedActivity((current) =>
      (current[selectedSessionKey] ?? 0) >= latestSequence
        ? current
        : { ...current, [selectedSessionKey]: latestSequence },
    );
  }, [events, run, selectedSessionKey]);

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
      void getReceipt(submission.key)
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
    let flushTimer: number | undefined;
    let pendingEvents: ManagedAgentEvent[] = [];
    const flushPendingEvents = () => {
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!active || pendingEvents.length === 0) return;
      const batch = pendingEvents;
      pendingEvents = [];
      setEvents((current) =>
        mergeTranscriptEvents(
          current,
          batch,
          historyExpandedRef.current ? current.length + batch.length : TRANSCRIPT_EVENT_WINDOW,
        ),
      );
    };
    const queueEvent = (event: ManagedAgentEvent) => {
      pendingEvents.push(event);
      if (pendingEvents.length >= 50) {
        flushPendingEvents();
      } else if (flushTimer === undefined) {
        flushTimer = window.setTimeout(flushPendingEvents, 16);
      }
    };
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
          queueEvent(event);
        }
      } catch (reason) {
        if (active && !controller.signal.aborted) setError(errorMessage(reason));
      }
    })();

    return () => {
      active = false;
      controller.abort();
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      pendingEvents = [];
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
    writeAppRoute({ kind: 'new' });
  }

  async function createAgent(settings: AgentEditorSettings) {
    setSubmitting(true);
    setError(undefined);
    try {
      const agent = await client.createAgent({
        name: settings.name,
        systemPrompt: settings.systemPrompt,
        systemPromptMode: settings.systemPromptMode,
        ...(settings.toolCallsEnabled ? {} : { tools: [] }),
      });
      setAgents((current) => [agent, ...current]);
      return agent;
    } catch (reason) {
      setError(errorMessage(reason));
      return undefined;
    } finally {
      setSubmitting(false);
    }
  }

  async function updateAgent(agentId: string, settings: AgentEditorSettings) {
    setSubmitting(true);
    setError(undefined);
    try {
      const agent = await client.renameAgent(agentId, {
        name: settings.name,
        systemPrompt: settings.systemPrompt,
        systemPromptMode: settings.systemPromptMode,
        tools: settings.toolCallsEnabled ? null : [],
      });
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
    if (agentCommandLockRef.current) {
      throw new Error('Another Pi command is being submitted. Wait for its acknowledgement.');
    }
    agentCommandLockRef.current = true;
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
      agentCommandLockRef.current = false;
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
    if (agentCommandLockRef.current) {
      setError('Another Pi command is waiting for acknowledgement. Cancel again after it settles.');
      return;
    }
    agentCommandLockRef.current = true;
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
      agentCommandLockRef.current = false;
      setSubmitting(false);
    }
  }

  async function steerRun(message: string, attachments?: AgentImageAttachment[]) {
    if (!run) return;
    if (agentCommandLockRef.current) {
      throw new Error('Another Pi command is being submitted. Wait for its acknowledgement.');
    }
    agentCommandLockRef.current = true;
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
      agentCommandLockRef.current = false;
      setSubmitting(false);
    }
  }

  async function followUpRun(message: string, attachments?: AgentImageAttachment[]) {
    if (!run) return;
    if (agentCommandLockRef.current) {
      throw new Error('Another Pi command is being submitted. Wait for its acknowledgement.');
    }
    agentCommandLockRef.current = true;
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
      agentCommandLockRef.current = false;
      setSubmitting(false);
    }
  }

  function markSessionChecked(serverId: string, runId: string, observedSequence = 0) {
    const key = sessionKey(serverId, runId);
    const latestSequence = Math.max(
      observedSequence,
      snapshotsRef.current[serverId]?.runs.find((candidate) => candidate.id === runId)
        ?.latestEventSequence ?? 0,
    );
    setCheckedActivity((current) =>
      (current[key] ?? 0) >= latestSequence ? current : { ...current, [key]: latestSequence },
    );
  }

  function handleInboxItem(sessionId: string, itemId: string) {
    setInboxBySession((current) => {
      const remaining = (current[sessionId] ?? []).filter((item) => item.id !== itemId);
      if (remaining.length === (current[sessionId]?.length ?? 0)) return current;
      const next = { ...current };
      if (remaining.length > 0) next[sessionId] = remaining;
      else delete next[sessionId];
      return next;
    });
  }

  function openOverview() {
    if (activeServerId && selectedRunId) {
      markSessionChecked(activeServerId, selectedRunId, events.at(-1)?.sequence);
    }
    setSelectedRunId(undefined);
    setEvents([]);
    setWorkspaceView('overview');
    writeAppRoute({ kind: 'default' });
  }

  function openRun(serverId: string, runId: string) {
    const snapshot = snapshotsRef.current[serverId];
    if (!snapshot) return;
    if (activeServerId && selectedRunId) {
      markSessionChecked(activeServerId, selectedRunId, events.at(-1)?.sequence);
    }
    const target = snapshot.runs.find((candidate) => candidate.id === runId);
    markSessionChecked(serverId, runId, target?.latestEventSequence);
    activateSnapshot(snapshot, runId);
    const nextRoute = {
      kind: 'session' as const,
      serverId: injectedClient ? undefined : serverId,
      runId,
    };
    writeAppRoute(nextRoute);
  }

  function openNewSession() {
    if (activeServerId && selectedRunId) {
      markSessionChecked(activeServerId, selectedRunId, events.at(-1)?.sequence);
    }
    setSelectedRunId(undefined);
    setEvents([]);
    setWorkspaceView('new');
    writeAppRoute({ kind: 'new' });
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
            className="grid h-svh grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background text-foreground"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
          >
            <AppToolbar
              darkMode={darkMode}
              onOverview={openOverview}
              onNew={openNewSession}
              onSearch={() => setPaletteOpen(true)}
              onSettings={() => setSettingsOpen(true)}
              onDarkModeChange={setDarkMode}
            />
            <section className="flex h-full min-h-0 min-w-0 flex-col">
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
                    <Alert variant="destructive" className="m-4 mb-0 w-auto pr-12">
                      <AlertTitle>Request not completed</AlertTitle>
                      <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute top-2.5 right-2.5"
                        aria-label="Dismiss error"
                        onClick={() => setError(undefined)}
                      >
                        <XIcon aria-hidden="true" />
                      </Button>
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
                      inboxItems={
                        selectedSessionKey ? (inboxBySession[selectedSessionKey] ?? []) : []
                      }
                      onInboxHandled={(itemId) => {
                        if (selectedSessionKey) handleInboxItem(selectedSessionKey, itemId);
                      }}
                      onCancel={cancelRun}
                      onSteer={steerRun}
                      onSendMessage={followUpRun}
                    />
                  </motion.div>
                ) : workspaceView === 'overview' ? (
                  <Overview
                    sessions={visibleSessions}
                    snapshots={snapshots}
                    checkedActivity={checkedActivity}
                    inboxBySession={inboxBySession}
                    canLoadMore={Object.values(snapshots).some(
                      (snapshot) => snapshot.historyCursor,
                    )}
                    historyLoading={historyLoading}
                    historyError={historyError}
                    onLoadMore={() => void loadMoreHistory()}
                    onOpenRun={openRun}
                    onNew={openNewSession}
                  />
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
                      key={`new-session-${activeServerId ?? 'unassigned'}`}
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

            {globalInboxRequest ? (
              <ExtensionRequestDialog
                key={globalInboxRequest.request.id}
                request={globalInboxRequest.request}
                client={globalInboxRequest.client}
                onHandled={() =>
                  handleInboxItem(globalInboxRequest.key, globalInboxRequest.request.id)
                }
              />
            ) : null}

            <CommandPalette
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              servers={operationsServers}
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

function ExtensionRequestDialog({
  request,
  client,
  onHandled,
}: {
  request: InboxItemResponse;
  client: Pick<SupervisorClientApi, 'resolveInbox' | 'cancelInbox'>;
  onHandled(): void;
}) {
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function resolve(value: string) {
    if (!value.trim() || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await client.resolveInbox(request.id, value.trim());
      onHandled();
    } catch (reason) {
      setError(errorMessage(reason));
      setSubmitting(false);
    }
  }

  async function cancel() {
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await client.cancelInbox(request.id);
      onHandled();
    } catch (reason) {
      setError(errorMessage(reason));
      setSubmitting(false);
    }
  }

  return (
    <Dialog open>
      <DialogContent
        className="max-w-md"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap leading-5">
            {request.body || 'PI needs your response before it can continue.'}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {request.options.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {request.options.map((option) => (
              <Button
                key={option}
                type="button"
                variant={option.toLowerCase() === 'cancel' ? 'outline' : 'default'}
                disabled={submitting}
                onClick={() => void resolve(option)}
              >
                {option}
              </Button>
            ))}
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              value={response}
              onChange={(event) => setResponse(event.target.value)}
              placeholder="Type your response"
              aria-label={`Response to ${request.title}`}
              disabled={submitting}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void resolve(response);
              }}
            />
            <Button
              type="button"
              disabled={submitting || !response.trim()}
              onClick={() => void resolve(response)}
            >
              Submit
            </Button>
          </div>
        )}
        {request.options.some((option) => option.toLowerCase() === 'cancel') ? null : (
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={submitting}
              onClick={() => void cancel()}
            >
              Cancel request
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AppToolbar({
  darkMode,
  onOverview,
  onNew,
  onSearch,
  onSettings,
  onDarkModeChange,
}: {
  darkMode: boolean;
  onOverview(): void;
  onNew(): void;
  onSearch(): void;
  onSettings(): void;
  onDarkModeChange(darkMode: boolean): void;
}) {
  return (
    <motion.header
      className="flex h-11 min-w-0 items-center border-b px-2"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
    >
      <Button
        type="button"
        variant="ghost"
        className="gap-2 px-2 font-semibold tracking-tight"
        style={{ color: 'var(--foreground)' }}
        aria-label="piDeck overview"
        onClick={onOverview}
      >
        <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <PiIcon className="size-3.5" />
        </span>
        <span>piDeck</span>
      </Button>
      <div className="ml-auto flex items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          style={{ color: 'var(--foreground)' }}
          aria-label="New session"
          onClick={onNew}
        >
          <PlusIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          style={{ color: 'var(--foreground)' }}
          aria-label="Search and commands"
          title="Search and commands (⌘K)"
          onClick={onSearch}
        >
          <SearchIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          style={{ color: 'var(--foreground)' }}
          aria-label="Settings"
          onClick={onSettings}
        >
          <SettingsIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="hidden sm:inline-flex"
          style={{ color: 'var(--foreground)' }}
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

function Overview({
  sessions,
  snapshots,
  checkedActivity,
  inboxBySession,
  canLoadMore,
  historyLoading,
  historyError,
  onLoadMore,
  onOpenRun,
  onNew,
}: {
  sessions: ServerSession[];
  snapshots: Record<string, ServerSnapshot>;
  checkedActivity: Record<string, number>;
  inboxBySession: Record<string, InboxItemResponse[]>;
  canLoadMore: boolean;
  historyLoading: boolean;
  historyError: string | undefined;
  onLoadMore(): void;
  onOpenRun(serverId: string, runId: string): void;
  onNew(): void;
}) {
  const activeSessions = sessions.filter(
    ({ run: candidate }) => candidate.status === 'running' || candidate.status === 'queued',
  );
  const runningCount = activeSessions.filter(
    ({ run: candidate }) => candidate.status === 'running',
  ).length;
  const attentionCount = activeSessions.filter(({ serverId, run: candidate }) => {
    const key = sessionKey(serverId, candidate.id);
    return (inboxBySession[key]?.length ?? 0) > 0;
  }).length;

  return (
    <motion.div
      key="overview"
      className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="mx-auto w-full max-w-[96rem] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <header className="flex flex-col gap-5 border-b pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-balance text-3xl font-semibold tracking-[-0.03em]">
              Running agents
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Scan active work, spot runs waiting on you, and open any agent without losing the
              fleet view.
            </p>
          </div>
          <div className="flex items-center gap-4">
            <dl className="flex items-center gap-4 text-sm tabular-nums">
              <div>
                <dt className="text-xs text-muted-foreground">Running</dt>
                <dd className="font-semibold">{runningCount}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Needs input</dt>
                <dd className="font-semibold">{attentionCount}</dd>
              </div>
            </dl>
            <Button onClick={onNew}>
              <PlusIcon data-icon="inline-start" />
              New session
            </Button>
          </div>
        </header>

        {activeSessions.length === 0 ? (
          <Empty className="mt-8 min-h-80 border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BotIcon />
              </EmptyMedia>
              <EmptyTitle>No agents are running</EmptyTitle>
              <EmptyDescription>
                Start a session and it will appear here while Pi is working or waiting to begin.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={onNew}>
                <PlusIcon data-icon="inline-start" />
                Start a session
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div
            className="mt-7 grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-4"
            role="region"
            aria-label="Running agents"
          >
            {activeSessions.map(({ serverId, run: candidate }, index) => {
              const snapshot = snapshots[serverId];
              const agent = snapshot?.agents.find((item) => item.id === candidate.agentId);
              const projectLabel = sessionProjectLabel(candidate.cwd, snapshot?.projects ?? []);
              const branchLabel = sessionBranchLabel(candidate.cwd, snapshot?.projects ?? []);
              const key = sessionKey(serverId, candidate.id);
              const requests = inboxBySession[key]?.length ?? 0;
              const uncheckedEvents = activitySince(
                candidate.latestEventSequence,
                checkedActivity[key] ?? 0,
              );
              return (
                <motion.div
                  key={key}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.16, delay: Math.min(index, 7) * 0.025 }}
                >
                  <Card className="relative h-full min-h-56 transition-[box-shadow,transform] hover:-translate-y-0.5 hover:shadow-lg hover:shadow-foreground/5 focus-within:ring-2 focus-within:ring-ring">
                    <a
                      className="absolute inset-0 rounded-xl focus:outline-none"
                      href={`/servers/${encodeURIComponent(serverId)}/sessions/${encodeURIComponent(candidate.id)}`}
                      aria-label={`Open ${sessionTitle(candidate.prompt)}`}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                          return;
                        event.preventDefault();
                        onOpenRun(serverId, candidate.id);
                      }}
                    />
                    <CardHeader className="pointer-events-none">
                      <div className="flex min-w-0 items-center gap-3">
                        <SessionAvatar
                          model={candidate.model}
                          models={snapshot?.models}
                          className="size-9 rounded-lg"
                        />
                        <div className="min-w-0">
                          <CardTitle className="truncate">{agent?.name ?? 'Agent'}</CardTitle>
                          <CardDescription className="truncate">
                            {snapshot?.server.name ?? 'Server'} · {projectLabel}
                          </CardDescription>
                        </div>
                      </div>
                      <CardAction>
                        <Badge variant={requests > 0 ? 'destructive' : 'secondary'}>
                          {requests > 0
                            ? `${requests} need${requests === 1 ? 's' : ''} input`
                            : titleCase(candidate.status)}
                        </Badge>
                      </CardAction>
                    </CardHeader>
                    <CardContent className="pointer-events-none flex flex-1 flex-col gap-4">
                      <p className="line-clamp-3 text-base leading-6 font-medium tracking-[-0.01em]">
                        {sessionTitle(candidate.prompt)}
                      </p>
                      <dl className="mt-auto grid gap-2 text-xs text-muted-foreground">
                        <div className="flex min-w-0 items-center gap-2">
                          <GitBranchIcon className="size-3.5 shrink-0" aria-hidden="true" />
                          <dt className="sr-only">Branch</dt>
                          <dd className="truncate" title={branchLabel}>
                            {branchLabel}
                          </dd>
                        </div>
                        <div className="flex min-w-0 items-center gap-2">
                          <BrainIcon className="size-3.5 shrink-0" aria-hidden="true" />
                          <dt className="sr-only">Model</dt>
                          <dd className="truncate">
                            {modelDisplayName(candidate.model, snapshot?.models)} ·{' '}
                            {titleCase(candidate.thinkingLevel ?? 'default')} thinking
                          </dd>
                        </div>
                      </dl>
                    </CardContent>
                    <CardFooter className="pointer-events-none justify-between text-xs text-muted-foreground">
                      <span className="flex items-center gap-2 font-medium text-foreground">
                        <RunDot status={candidate.status} />
                        {candidate.status === 'queued' ? 'Queued' : 'Working'}
                      </span>
                      <span className="tabular-nums">
                        {uncheckedEvents > 0
                          ? `${uncheckedEvents} new event${uncheckedEvents === 1 ? '' : 's'}`
                          : `Started ${formatRelativeDate(candidate.startedAt ?? candidate.createdAt)}`}
                      </span>
                    </CardFooter>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        )}
        {canLoadMore || historyError ? (
          <div className="mt-8 flex flex-col items-center gap-2">
            {canLoadMore ? (
              <Button variant="outline" disabled={historyLoading} onClick={onLoadMore}>
                {historyLoading ? 'Loading sessions…' : 'Load older sessions'}
              </Button>
            ) : null}
            {historyError ? (
              <p className="text-sm text-destructive" role="alert">
                {historyError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </motion.div>
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
  const draftId = `new-session:${serverId ?? 'unassigned'}`;
  const [prompt, setPrompt, clearPromptDraft] = useComposerDraft(draftId);
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
  const sendInFlightRef = useRef(false);

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
    const files = Array.from(fileList);
    const validationError = imageAttachmentValidationError([
      ...attachments.map((attachment) => attachment.file),
      ...files,
    ]);
    setAttachmentError(validationError);
    if (validationError) return;
    const nextAttachments = files.map((file) => ({
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
    const validationError = imageAttachmentValidationError(
      attachments.map((attachment) => attachment.file),
    );
    if (validationError) {
      setAttachmentError(validationError);
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

  const composerCommands = useMemo<readonly ComposerCommand[]>(() => {
    const projectOptions = projects.map((project) => ({
      value: project.path,
      label: project.name,
      description: project.path,
    }));
    if (!projectOptions.some((option) => option.value === cwd)) {
      projectOptions.unshift({
        value: cwd,
        label: projectNameFromPath(cwd),
        description: cwd,
      });
    }
    const readyWorktrees = worktrees.filter((worktree) => worktree.status === 'ready');

    return [
      {
        name: 'host',
        label: 'Remote host',
        description: 'Choose the supervisor that will run this session',
        currentValue: serverId,
        options: servers.map((server) => ({
          value: server.id,
          label: server.name,
          description: server.address,
        })),
        onSelect: (value) => {
          if (value !== serverId) {
            clearPromptDraft();
            onServerChange(value);
          }
        },
      },
      {
        name: 'project',
        label: 'Project',
        description: 'Choose the working directory for this session',
        currentValue: cwd,
        options: projectOptions,
        onSelect: setCwd,
      },
      {
        name: 'agent',
        label: 'Agent profile',
        description: 'Choose the agent profile for this session',
        currentValue: agentId,
        options: agents.map((agent) => ({
          value: agent.id,
          label: agent.name,
          description: agent.cwd,
        })),
        onSelect: setAgentId,
      },
      {
        name: 'model',
        label: 'Model',
        description: 'Choose the model for this session',
        currentValue: modelKey,
        options:
          models?.models.map((model) => ({
            value: encodeModel(model),
            label: model.name,
            description: `${model.provider}/${model.id}`,
          })) ?? [],
        onSelect: setModelKey,
      },
      {
        name: 'think',
        label: 'Thinking level',
        description: 'Choose how much reasoning effort Pi should use',
        currentValue: thinkingLevel,
        options: THINKING_LEVELS.map((level) => ({
          value: level,
          label: titleCase(level),
        })),
        onSelect: (value) => setThinkingLevel(value as AgentThinkingLevel),
      },
      {
        name: 'checkout',
        label: 'Execution mode',
        description: 'Run in the current checkout or an isolated worktree',
        currentValue: executionMode,
        options: [
          { value: 'local', label: 'Local checkout', description: cwd },
          ...(readyWorktrees.length > 0
            ? [
                {
                  value: 'worktree',
                  label: 'Worktree',
                  description: 'Use an isolated managed worktree',
                },
              ]
            : []),
        ],
        onSelect: (value) => setExecutionMode(value as 'local' | 'worktree'),
      },
      ...(readyWorktrees.length > 0
        ? [
            {
              name: 'worktree',
              label: 'Worktree',
              description: 'Choose the managed worktree for this session',
              currentValue: worktreeId,
              options: readyWorktrees.map((worktree) => ({
                value: worktree.id,
                label: worktree.branch,
                description: worktree.path,
              })),
              onSelect: (value: string) => {
                setWorktreeId(value);
                setExecutionMode('worktree');
              },
            },
          ]
        : []),
    ];
  }, [
    agentId,
    agents,
    clearPromptDraft,
    cwd,
    executionMode,
    modelKey,
    models,
    onServerChange,
    projects,
    serverId,
    servers,
    thinkingLevel,
    worktreeId,
    worktrees,
  ]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (
      (!value && attachments.length === 0) ||
      !agentId ||
      !cwd.trim() ||
      submitting ||
      sendInFlightRef.current
    ) {
      return;
    }
    sendInFlightRef.current = true;
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
      clearPromptDraft();
      setAttachmentError(undefined);
      clearAttachments();
    } catch {
      // Keep the draft and attachments visible while the app-level error explains what failed.
    } finally {
      sendInFlightRef.current = false;
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
      <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 py-8 md:px-8">
        <div className="w-full max-w-3xl">
          <motion.form
            aria-label="New session composer"
            className="group/composer relative w-full overflow-hidden rounded-2xl border border-border/70 bg-muted/60 shadow-sm transition-[border-color,box-shadow] focus-within:border-foreground/25 focus-within:shadow-md"
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
                    <p className="font-medium">Drop images to attach</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      PNG, JPEG, GIF, or WebP · up to 4 images, 6 MB each
                    </p>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
            <fieldset
              aria-label="Agent settings"
              className="flex min-h-11 min-w-0 items-center gap-1 overflow-x-auto px-3 py-1.5 [scrollbar-width:none] md:px-4"
            >
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger
                  aria-label="Agent profile"
                  size="sm"
                  className="max-w-44 shrink-0 border-0 bg-transparent font-mono text-xs shadow-none"
                >
                  <span className="text-muted-foreground max-sm:hidden" aria-hidden="true">
                    /agent
                  </span>
                  <SelectValue placeholder="select" />
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
              <Select value={modelKey} onValueChange={setModelKey}>
                <SelectTrigger
                  aria-label="Model"
                  size="sm"
                  className="max-w-52 shrink-0 border-0 bg-transparent font-mono text-xs shadow-none"
                >
                  <span className="text-muted-foreground max-sm:hidden" aria-hidden="true">
                    /model
                  </span>
                  <SelectValue placeholder="default" />
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
              <Select
                value={thinkingLevel}
                onValueChange={(value) => setThinkingLevel(value as AgentThinkingLevel)}
              >
                <SelectTrigger
                  aria-label="Thinking level"
                  size="sm"
                  className="shrink-0 border-0 bg-transparent font-mono text-xs shadow-none"
                >
                  <span className="text-muted-foreground max-sm:hidden" aria-hidden="true">
                    /think
                  </span>
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
            </fieldset>

            <div className="relative z-[1] mx-2 overflow-hidden rounded-xl bg-card shadow-md">
              <ComposerInput
                ariaLabel="Session task"
                placeholder="Message Pi"
                value={prompt}
                onChange={setPrompt}
                cwd={cwd}
                client={client}
                commands={composerCommands}
                disabled={submitting}
                maxLength={MAX_COMPOSER_CHARACTERS}
                className="min-h-20 resize-none rounded-none border-0 bg-transparent px-4 py-3.5 text-base leading-6 shadow-none focus-visible:ring-0 md:min-h-24 md:px-5 md:py-4"
                placement="top"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <motion.div
                className="flex flex-col"
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
                <div className="flex items-center justify-between px-3 pb-3 pt-1 md:px-4">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={IMAGE_INPUT_ACCEPT}
                    className="sr-only"
                    aria-label="Images to attach"
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
                  <Button
                    type="submit"
                    size="icon-lg"
                    className="shrink-0 rounded-full"
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
            </div>

            <fieldset
              aria-label="Project settings"
              className="flex min-h-11 min-w-0 items-center gap-1 overflow-x-auto px-3 py-1.5 [scrollbar-width:none] md:px-4"
            >
              <Select value={serverId} onValueChange={onServerChange}>
                <SelectTrigger
                  aria-label="Remote host"
                  size="sm"
                  className="max-w-40 shrink-0 border-0 bg-transparent font-mono text-xs shadow-none"
                >
                  <span className="text-muted-foreground max-sm:hidden" aria-hidden="true">
                    /host
                  </span>
                  <SelectValue placeholder="select" />
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
              <ProjectPicker
                projects={projects}
                path={cwd}
                onPathChange={setCwd}
                onDeleteProject={onDeleteProject}
                disabled={submitting}
              />
              <Select
                value={executionMode}
                onValueChange={(value) => setExecutionMode(value as 'local' | 'worktree')}
              >
                <SelectTrigger
                  aria-label="Execution mode"
                  size="sm"
                  className="shrink-0 border-0 bg-transparent font-mono text-xs shadow-none"
                >
                  <span className="text-muted-foreground max-sm:hidden" aria-hidden="true">
                    /checkout
                  </span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="local">Local checkout</SelectItem>
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
                    className="max-w-48 shrink-0 border-0 bg-transparent font-mono text-xs shadow-none"
                  >
                    <span className="text-muted-foreground" aria-hidden="true">
                      /worktree
                    </span>
                    <SelectValue placeholder="select" />
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
            </fieldset>
          </motion.form>
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
    <div className="relative shrink-0">
      <Popover open={open} onOpenChange={setOpen} modal={false}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label="Choose project"
            className="h-8 max-w-48 justify-start gap-1.5 rounded-md bg-transparent px-2 font-mono text-xs hover:bg-background/70 dark:bg-transparent dark:hover:bg-background/40"
          >
            <span className="text-muted-foreground max-sm:hidden" aria-hidden="true">
              /project
            </span>
            <span className="truncate">{selectedName}</span>
          </Button>
        </PopoverTrigger>

        {/* Keep the menu below the full composer instead of letting it cover the textarea. */}
        <PopoverContent
          role="dialog"
          aria-label="Choose project"
          side="bottom"
          align="start"
          sideOffset={18}
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

function imageAttachmentValidationError(files: readonly File[]): string | undefined {
  if (files.some((file) => !SUPPORTED_IMAGE_MIME_TYPES.has(file.type))) {
    return 'Pi accepts PNG, JPEG, GIF, and WebP images only.';
  }
  if (files.length > MAX_IMAGE_ATTACHMENTS) {
    return `Attach at most ${MAX_IMAGE_ATTACHMENTS} images.`;
  }
  if (files.some((file) => file.size > MAX_IMAGE_ATTACHMENT_BYTES)) {
    return 'Each image must be smaller than 6 MB.';
  }
  return undefined;
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
  inboxItems,
  onInboxHandled,
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
  inboxItems: InboxItemResponse[];
  onInboxHandled(itemId: string): void;
  onCancel(): Promise<void>;
  onSteer(message: string, attachments?: AgentImageAttachment[]): Promise<void>;
  onSendMessage(message: string, attachments?: AgentImageAttachment[]): Promise<void>;
}) {
  const reducedMotion = useReducedMotion();
  const [message, setMessage, clearMessageDraft] = useComposerDraft(`run:${run.id}`);
  const [deliveryMode, setDeliveryMode] = useState<'follow-up' | 'steer'>('follow-up');
  const [inboxResponse, setInboxResponse] = useState('');
  const [inboxError, setInboxError] = useState<string>();
  const [respondingToInbox, setRespondingToInbox] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [dragActive, setDragActive] = useState(false);
  const [inspector, setInspector] = useState<'changes' | 'debug'>();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const changesOpen = inspector === 'changes';
  const debugOpen = inspector === 'debug';
  const [changesPanelSize, setChangesPanelSize] = useState(() => {
    const storedValue = window.localStorage.getItem(CHANGES_PANEL_SIZE_STORAGE_KEY);
    if (storedValue === null) return 42;
    const stored = Number(storedValue);
    return Number.isFinite(stored) ? Math.max(20, Math.min(70, stored)) : 42;
  });
  const [terminalPanelSize, setTerminalPanelSize] = useState(() => {
    const storedValue = window.localStorage.getItem(TERMINAL_PANEL_SIZE_STORAGE_KEY);
    if (storedValue === null) return 40;
    const stored = Number(storedValue);
    return Number.isFinite(stored) ? Math.max(20, Math.min(70, stored)) : 40;
  });
  const changesLayout = useMemo<Record<string, number>>(
    () =>
      (inspector
        ? { workspace: 100 - changesPanelSize, changes: changesPanelSize }
        : { workspace: 100 }) as Record<string, number>,
    [inspector, changesPanelSize],
  );
  const terminalLayout = useMemo<Record<string, number>>(
    () =>
      (terminalOpen
        ? { chat: 100 - terminalPanelSize, terminal: terminalPanelSize }
        : { chat: 100 }) as Record<string, number>,
    [terminalOpen, terminalPanelSize],
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptViewportRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  const attachmentSequenceRef = useRef(0);
  const attachmentsRef = useRef(attachments);
  const sendInFlightRef = useRef(false);
  const canChat = run.status === 'queued' || run.status === 'running' || run.status === 'completed';
  const activeInboxItem = inboxItems[0];
  const composerBlocked = activeInboxItem !== undefined;

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(revokeAttachmentPreview);
    };
  }, []);

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    const validationError = imageAttachmentValidationError([
      ...attachments.map((attachment) => attachment.file),
      ...files,
    ]);
    setAttachmentError(validationError);
    if (validationError) return;
    const nextAttachments = files.map((file) => ({
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
    const validationError = imageAttachmentValidationError(
      attachments.map((attachment) => attachment.file),
    );
    if (validationError) {
      setAttachmentError(validationError);
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
    if (
      (!value && attachments.length === 0) ||
      submitting ||
      !canChat ||
      composerBlocked ||
      sendInFlightRef.current
    ) {
      return;
    }
    sendInFlightRef.current = true;
    try {
      const imageAttachments = await prepareImageAttachments();
      if (attachments.length > 0 && !imageAttachments) return;
      const content = value || 'Please inspect the attached image.';
      if (runIsActive && deliveryMode === 'steer') await onSteer(content, imageAttachments);
      else await onSendMessage(content, imageAttachments);
      clearMessageDraft();
      setAttachmentError(undefined);
      clearAttachments();
    } catch {
      // Keep the draft and attachments visible while the app-level error explains what failed.
    } finally {
      sendInFlightRef.current = false;
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

  async function respondToInbox(response: string) {
    if (!activeInboxItem || !response.trim() || respondingToInbox) return;
    setRespondingToInbox(true);
    setInboxError(undefined);
    try {
      await client.resolveInbox(activeInboxItem.id, response.trim());
      onInboxHandled(activeInboxItem.id);
      setInboxResponse('');
    } catch (reason) {
      setInboxError(errorMessage(reason));
    } finally {
      setRespondingToInbox(false);
    }
  }

  async function cancelInboxItem() {
    if (!activeInboxItem || respondingToInbox) return;
    setRespondingToInbox(true);
    setInboxError(undefined);
    try {
      await client.cancelInbox(activeInboxItem.id);
      onInboxHandled(activeInboxItem.id);
      setInboxResponse('');
    } catch (reason) {
      setInboxError(errorMessage(reason));
    } finally {
      setRespondingToInbox(false);
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
            aria-label={changesOpen ? 'Close changes' : 'Open changes'}
            aria-pressed={changesOpen}
            onClick={() => setInspector(changesOpen ? undefined : 'changes')}
          >
            <FileDiffIcon />
            <span className="hidden lg:inline">Changes</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={debugOpen ? 'Close debug log' : 'Open debug log'}
            aria-pressed={debugOpen}
            onClick={() => setInspector(debugOpen ? undefined : 'debug')}
          >
            <BugIcon />
            <span className="hidden lg:inline">Debug</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={terminalOpen ? 'Close terminal' : 'Open terminal'}
            aria-pressed={terminalOpen}
            onClick={() => setTerminalOpen((open) => !open)}
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
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={changesLayout}
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction || !inspector) return;
          const nextSize = layout.changes;
          if (nextSize === undefined) return;
          setChangesPanelSize(nextSize);
          window.localStorage.setItem(CHANGES_PANEL_SIZE_STORAGE_KEY, String(nextSize));
        }}
      >
        <ResizablePanel id="workspace" minSize="25" className="min-h-0 min-w-0">
          <ResizablePanelGroup
            orientation="vertical"
            className="min-h-0"
            defaultLayout={terminalLayout}
            onLayoutChanged={(layout, meta) => {
              if (!meta.isUserInteraction || !terminalOpen) return;
              const nextSize = layout.terminal;
              if (nextSize === undefined) return;
              setTerminalPanelSize(nextSize);
              window.localStorage.setItem(TERMINAL_PANEL_SIZE_STORAGE_KEY, String(nextSize));
            }}
          >
            <ResizablePanel id="chat" minSize="25" className="min-h-0">
              <div className="relative flex h-full min-h-0 flex-col">
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
                        <p className="font-medium">Drop images to attach</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          PNG, JPEG, GIF, or WebP · up to 4 images, 6 MB each
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
                                {loadingOlderEvents
                                  ? 'Loading older activity…'
                                  : 'Load older activity'}
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
                      className="bg-background px-3 pb-3 pt-2 md:px-6 md:pb-4"
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
                        <div className="overflow-hidden rounded-[1.75rem] border border-border/70 bg-card transition-colors focus-within:border-foreground/25">
                          <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            accept={IMAGE_INPUT_ACCEPT}
                            className="sr-only"
                            aria-label="Images to attach"
                            onChange={handleFileInput}
                            tabIndex={-1}
                          />
                          {activeInboxItem ? (
                            <section
                              className="border-b border-border/60 px-5 py-4"
                              aria-live="polite"
                            >
                              <div className="flex items-start gap-3">
                                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                                  <InboxIcon className="size-3.5" aria-hidden="true" />
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-sm font-semibold">{activeInboxItem.title}</p>
                                    <Badge variant="outline">
                                      {inboxItems.length > 1
                                        ? `1 of ${inboxItems.length}`
                                        : activeInboxItem.kind}
                                    </Badge>
                                  </div>
                                  {activeInboxItem.body ? (
                                    <p className="mt-1.5 whitespace-pre-wrap text-sm leading-5 text-muted-foreground">
                                      {activeInboxItem.body}
                                    </p>
                                  ) : null}
                                  {inboxError ? (
                                    <p role="alert" className="mt-2 text-xs text-destructive">
                                      {inboxError}
                                    </p>
                                  ) : null}
                                  <div className="mt-3 flex flex-wrap items-center gap-2">
                                    {(activeInboxItem.options.length > 0
                                      ? activeInboxItem.options
                                      : activeInboxItem.kind === 'approval'
                                        ? ['Approve', 'Reject']
                                        : []
                                    ).map((option) => (
                                      <Button
                                        key={option}
                                        type="button"
                                        size="sm"
                                        variant={
                                          option.toLowerCase() === 'reject'
                                            ? 'destructive'
                                            : 'outline'
                                        }
                                        disabled={respondingToInbox}
                                        onClick={() => void respondToInbox(option)}
                                      >
                                        {option}
                                      </Button>
                                    ))}
                                    {activeInboxItem.kind === 'question' &&
                                    activeInboxItem.options.length === 0 ? (
                                      <>
                                        <Input
                                          aria-label={`Answer ${activeInboxItem.title}`}
                                          value={inboxResponse}
                                          onChange={(event) => setInboxResponse(event.target.value)}
                                          className="min-w-52 flex-1"
                                          placeholder="Type your answer"
                                        />
                                        <Button
                                          type="button"
                                          size="sm"
                                          disabled={respondingToInbox || !inboxResponse.trim()}
                                          onClick={() => void respondToInbox(inboxResponse)}
                                        >
                                          Answer
                                        </Button>
                                      </>
                                    ) : null}
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      disabled={respondingToInbox}
                                      onClick={() => void cancelInboxItem()}
                                    >
                                      Cancel request
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            </section>
                          ) : null}
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
                            placeholder={
                              composerBlocked
                                ? 'Resolve the request above to continue'
                                : runIsActive && deliveryMode === 'steer'
                                  ? 'Steer the active run at the next safe point'
                                  : 'Ask for follow-up changes or attach images'
                            }
                            disabled={submitting || composerBlocked}
                            rows={1}
                            maxLength={MAX_COMPOSER_CHARACTERS}
                            placement="top"
                            className="max-h-48 min-h-24 resize-none rounded-none border-0 bg-transparent px-5 py-4 text-base leading-6 shadow-none focus-visible:ring-0 md:min-h-28"
                          />
                          <div className="flex min-w-0 items-center gap-1 px-4 pb-4 md:px-5">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Attach images"
                              title="Attach images"
                              onClick={() => fileInputRef.current?.click()}
                              disabled={submitting || composerBlocked}
                              className="rounded-full"
                            >
                              <PaperclipIcon />
                            </Button>
                            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
                              <span className="hidden shrink-0 items-center gap-2 px-2 text-sm text-muted-foreground sm:flex">
                                <ModelLogo provider={modelProvider(run.model)} />
                                <span>{modelDisplayName(run.model, models)}</span>
                              </span>
                              <Separator
                                orientation="vertical"
                                className="hidden h-5 shrink-0 sm:block"
                              />
                              <span className="hidden shrink-0 items-center gap-2 px-2 text-sm text-muted-foreground sm:flex">
                                <BrainIcon className="size-4" aria-hidden="true" />
                                {titleCase(run.thinkingLevel ?? 'default')}
                              </span>
                              <Separator
                                orientation="vertical"
                                className="hidden h-5 shrink-0 sm:block"
                              />
                              {runIsActive ? (
                                <Select
                                  value={deliveryMode}
                                  onValueChange={(value) =>
                                    setDeliveryMode(value as 'follow-up' | 'steer')
                                  }
                                >
                                  <SelectTrigger
                                    aria-label="Message delivery"
                                    size="sm"
                                    className="shrink-0 border-0 bg-transparent shadow-none"
                                  >
                                    {deliveryMode === 'steer' ? <RouteIcon /> : <ListEndIcon />}
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectGroup>
                                      <SelectItem value="follow-up">Queue follow-up</SelectItem>
                                      <SelectItem value="steer">Steer now</SelectItem>
                                    </SelectGroup>
                                  </SelectContent>
                                </Select>
                              ) : (
                                <span className="flex shrink-0 items-center gap-2 px-2 text-sm text-muted-foreground">
                                  <ListEndIcon className="size-4" aria-hidden="true" />
                                  Follow-up
                                </span>
                              )}
                            </div>
                            <Button
                              type="submit"
                              size="icon-lg"
                              className="ml-auto shrink-0 rounded-full"
                              aria-label={
                                deliveryMode === 'steer' && runIsActive
                                  ? 'Steer run'
                                  : 'Send follow-up'
                              }
                              title={
                                deliveryMode === 'steer' && runIsActive
                                  ? 'Steer run'
                                  : 'Send follow-up'
                              }
                              disabled={
                                submitting ||
                                composerBlocked ||
                                (!message.trim() && attachments.length === 0)
                              }
                            >
                              <ArrowUpIcon />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </motion.form>
                  ) : null}
                </MessageScrollerProvider>
              </div>
            </ResizablePanel>
            {terminalOpen ? (
              <>
                <ResizableHandle
                  orientation="vertical"
                  aria-label="Resize chat and terminal"
                  onDoubleClick={() => {
                    setTerminalPanelSize(40);
                    window.localStorage.setItem(TERMINAL_PANEL_SIZE_STORAGE_KEY, '40');
                  }}
                />
                <ResizablePanel id="terminal" defaultSize="40" minSize="20" className="min-h-0">
                  <motion.div
                    role="region"
                    aria-label="Session terminals"
                    className="h-full min-h-0 bg-neutral-950"
                    initial={
                      reducedMotion
                        ? { opacity: 0.86 }
                        : { opacity: 0.82, y: 10, clipPath: 'inset(7% 0 0 0)' }
                    }
                    animate={{ opacity: 1, y: 0, clipPath: 'inset(0% 0 0 0)' }}
                    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <Suspense
                      fallback={
                        <div
                          className="grid h-full place-items-center text-xs text-neutral-400"
                          role="status"
                        >
                          Loading terminal renderer…
                        </div>
                      }
                    >
                      <GhosttyMultiplexer
                        key={run.id}
                        client={client}
                        sessionId={run.id}
                        cwd={run.cwd}
                        onClosePanel={() => setTerminalOpen(false)}
                      />
                    </Suspense>
                  </motion.div>
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>
        </ResizablePanel>
        {inspector ? (
          <>
            <ResizableHandle
              orientation="horizontal"
              aria-label={`Resize workspace and ${inspector === 'changes' ? 'changes' : 'debug log'}`}
              onDoubleClick={() => {
                setChangesPanelSize(42);
                window.localStorage.setItem(CHANGES_PANEL_SIZE_STORAGE_KEY, '42');
              }}
            />
            <ResizablePanel id="changes" defaultSize="42" minSize="20" className="min-h-0 min-w-0">
              <motion.div
                key={inspector}
                className="h-full min-h-0 overflow-hidden"
                initial={
                  reducedMotion
                    ? { opacity: 0.86 }
                    : { opacity: 0.82, x: 14, clipPath: 'inset(0 0 0 5%)' }
                }
                animate={{ opacity: 1, x: 0, clipPath: 'inset(0 0 0 0%)' }}
                transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
              >
                <Suspense
                  fallback={
                    <div
                      className="grid h-full place-items-center text-xs text-muted-foreground"
                      role="status"
                    >
                      Loading {inspector} renderer…
                    </div>
                  }
                >
                  {inspector === 'changes' ? (
                    <ChangesPanel
                      key={run.id}
                      client={client}
                      runId={run.id}
                      onClose={() => setInspector(undefined)}
                    />
                  ) : (
                    <DebugPanel
                      key={run.id}
                      client={client}
                      runId={run.id}
                      runIsActive={runIsActive}
                      onClose={() => setInspector(undefined)}
                    />
                  )}
                </Suspense>
              </motion.div>
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
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
  onCreate(settings: AgentEditorSettings): Promise<ManagedAgentResponse | undefined>;
  onUpdate(agentId: string, settings: AgentEditorSettings): Promise<void>;
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
                        Reusable agent profiles with explicit prompt and tool-call behavior.
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
                <AppearanceSettingsPage darkMode={darkMode} onDarkModeChange={onDarkModeChange} />
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
        onCreate={async (settings) => {
          const created = await onCreate(settings);
          if (created) setEditing(undefined);
        }}
        onUpdate={async (agentId, settings) => {
          await onUpdate(agentId, settings);
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
              together as agent tabs and in the overview.
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
  onCreate(settings: AgentEditorSettings): Promise<void>;
  onUpdate(agentId: string, settings: AgentEditorSettings): Promise<void>;
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
  onCreate(settings: AgentEditorSettings): Promise<void>;
  onUpdate(agentId: string, settings: AgentEditorSettings): Promise<void>;
  onDelete(agentId: string): Promise<void>;
}) {
  const [name, setName] = useState(agent?.name ?? 'Coding agent');
  const [systemPrompt, setSystemPrompt] = useState(
    agent?.systemPrompt ?? DEFAULT_AGENT_INSTRUCTIONS,
  );
  const [systemPromptMode, setSystemPromptMode] = useState<AgentSystemPromptMode>(
    agent?.systemPromptMode ?? 'append',
  );
  const [toolCallsEnabled, setToolCallsEnabled] = useState(
    agent ? agent.tools === null || agent.tools.length > 0 : true,
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const settings: AgentEditorSettings = {
      name: name.trim(),
      systemPrompt: systemPrompt.trim(),
      systemPromptMode,
      toolCallsEnabled,
    };
    if (!settings.name || !settings.systemPrompt) return;
    if (agent) await onUpdate(agent.id, settings);
    else await onCreate(settings);
  }

  return (
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      >
        <DialogHeader>
          <DialogTitle>{agent ? 'Edit agent' : 'New agent'}</DialogTitle>
          <DialogDescription>
            Define exactly which prompt and capabilities this profile gives Pi.
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
            <FieldSet>
              <FieldLegend>System prompt</FieldLegend>
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={0}
                value={systemPromptMode}
                onValueChange={(value) => {
                  if (value === 'append' || value === 'replace') setSystemPromptMode(value);
                }}
                aria-label="System prompt behavior"
                className="w-full"
              >
                <ToggleGroupItem value="append" className="flex-1">
                  Pi default + this prompt
                </ToggleGroupItem>
                <ToggleGroupItem value="replace" className="flex-1">
                  This prompt only
                </ToggleGroupItem>
              </ToggleGroup>
              <Field>
                <FieldLabel htmlFor="agent-instructions">Agent prompt</FieldLabel>
                <Textarea
                  id="agent-instructions"
                  dir="auto"
                  value={systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                  rows={10}
                  placeholder="Describe this agent’s role, priorities, and constraints."
                  className="field-sizing-fixed min-h-48 max-h-[min(28rem,42dvh)] resize-y overflow-y-auto text-start"
                  required
                />
                <FieldDescription>
                  {systemPromptMode === 'append'
                    ? 'Added after Pi’s maintained system prompt, including its coding guidance and context.'
                    : 'Replaces Pi’s maintained system prompt. The text above becomes the complete system prompt.'}
                </FieldDescription>
              </Field>
            </FieldSet>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.14, delay: 0.12 }}
          >
            <FieldSet>
              <FieldLegend>Tools</FieldLegend>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="agent-tool-calls">Allow tool calls</FieldLabel>
                  <FieldDescription>
                    Let this agent inspect files, run commands, and use other available tools.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="agent-tool-calls"
                  checked={toolCallsEnabled}
                  onCheckedChange={setToolCallsEnabled}
                  aria-label="Allow tool calls"
                />
              </Field>
            </FieldSet>
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
