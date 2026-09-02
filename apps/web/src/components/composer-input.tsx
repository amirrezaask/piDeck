import type { ComposerSuggestion, ComposerSuggestionsRequest } from '@nextflow/contracts';
import { CheckIcon, ChevronRightIcon, FileIcon, FolderIcon, SlashIcon } from 'lucide-react';
import {
  type ChangeEvent,
  type KeyboardEvent,
  type SVGProps,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const EMPTY_COMPOSER_COMMANDS: readonly ComposerCommand[] = [];

const FALLBACK_COMMANDS: readonly ComposerSuggestion[] = [
  ['settings', 'Open settings menu'],
  ['model', 'Select model (opens selector UI)', '<provider/model>'],
  ['tree', 'Navigate session tree (switch branches)'],
  ['thinking', 'Set thinking level', '<level>'],
  ['scoped-models', 'Enable/disable models for Ctrl+P cycling'],
  ['export', 'Export session (HTML default, or specify path: .html/.jsonl)'],
  ['import', 'Import and resume a session from a JSONL file'],
  ['share', 'Share session as a secret GitHub gist'],
  ['copy', 'Copy last agent message to clipboard'],
  ['name', 'Set session display name'],
  ['session', 'Show session info and stats'],
  ['changelog', 'Show changelog entries'],
  ['hotkeys', 'Show all keyboard shortcuts'],
  ['fork', 'Create a new fork from a previous user message'],
  ['clone', 'Duplicate the current session at the current position'],
  ['trust', 'Save project trust decision for future sessions'],
  ['login', 'Configure provider authentication', '<provider>'],
  ['logout', 'Remove provider authentication'],
  ['new', 'Start a new session'],
  ['compact', 'Manually compact the session context'],
  ['resume', 'Resume a different session'],
  ['reload', 'Reload keybindings, extensions, skills, prompts, themes, and context files'],
  ['quit', 'Quit Pi'],
].map(([name, description, argumentHint]) => ({
  value: name,
  label: `/${name}`,
  description: argumentHint ? `${argumentHint} — ${description}` : description,
  kind: 'command' as const,
}));

interface ComposerSuggestionClient {
  listComposerSuggestions?(
    request: ComposerSuggestionsRequest,
  ): Promise<{ suggestions: ComposerSuggestion[] }>;
}

export interface ComposerCommandOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface ComposerCommand {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly options: readonly ComposerCommandOption[];
  readonly currentValue?: string;
  readonly onSelect: (value: string) => void;
}

type CompletionContext =
  | {
      readonly kind: 'file' | 'command';
      readonly prefix: string;
      readonly start: number;
    }
  | {
      readonly kind: 'command-option';
      readonly prefix: string;
      readonly start: number;
      readonly command: ComposerCommand;
    };

interface ComposerInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly cwd: string;
  readonly client?: ComposerSuggestionClient;
  readonly placeholder?: string;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  readonly rows?: number;
  readonly maxLength?: number;
  readonly className?: string;
  readonly placement?: 'top' | 'bottom';
  readonly commands?: readonly ComposerCommand[];
  readonly onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function ComposerInput({
  value,
  onChange,
  cwd,
  client,
  placeholder,
  ariaLabel,
  disabled,
  rows,
  maxLength,
  className,
  placement = 'top',
  commands = EMPTY_COMPOSER_COMMANDS,
  onKeyDown,
}: ComposerInputProps) {
  const [cursor, setCursor] = useState(value.length);
  const [suggestions, setSuggestions] = useState<ComposerSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const context = useMemo(
    () => completionContext(value, cursor, commands),
    [commands, cursor, value],
  );
  const open = suggestions.length > 0 && context !== null && !disabled;

  useEffect(() => {
    const fallback =
      context?.kind === 'command'
        ? filterCommands(context.prefix, commands)
        : context?.kind === 'command-option'
          ? filterCommandOptions(context.command, context.prefix)
          : [];
    setSuggestions(fallback);
    setActiveIndex(0);
    if (
      !context ||
      context.kind === 'command-option' ||
      !cwd.trim() ||
      !client?.listComposerSuggestions
    ) {
      return;
    }

    const controller = new AbortController();
    let active = true;
    void client
      .listComposerSuggestions({ cwd: cwd.trim(), kind: context.kind, prefix: context.prefix })
      .then((response) => {
        if (active && !controller.signal.aborted) {
          setSuggestions(
            context.kind === 'command'
              ? mergeCommandSuggestions(fallback, response.suggestions)
              : response.suggestions.length > 0
                ? response.suggestions
                : fallback,
          );
          setActiveIndex(0);
        }
      })
      .catch(() => {
        // Local command fallbacks stay available when a remote supervisor is offline.
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [client, commands, context, cwd]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  function syncCursor(target: HTMLTextAreaElement) {
    setCursor(target.selectionStart);
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    syncCursor(event.currentTarget);
    onChange(event.currentTarget.value);
  }

  function applySuggestion(suggestion: ComposerSuggestion) {
    if (!context) return;
    const safeCursor = Math.min(cursor, value.length);
    const beforePrefix = value.slice(0, context.start);
    const afterCursor = value.slice(safeCursor);

    if (context.kind === 'command-option') {
      const option = context.command.options.find(
        (candidate) => candidate.value === suggestion.value,
      );
      if (!option) return;
      onChange(`${beforePrefix}${afterCursor}`);
      setCursor(beforePrefix.length);
      setSuggestions([]);
      context.command.onSelect(option.value);
      setAnnouncement(`${context.command.label} set to ${option.label}`);
      return;
    }

    let nextValue: string;
    let nextCursor: number;
    if (context.kind === 'command') {
      const command = suggestion.value.replace(/^\//, '');
      nextValue = `${beforePrefix}/${command} ${afterCursor}`;
      nextCursor = beforePrefix.length + command.length + 2;
    } else {
      const suffix = suggestion.kind === 'directory' ? '' : ' ';
      nextValue = `${beforePrefix}${suggestion.value}${suffix}${afterCursor}`;
      nextCursor = beforePrefix.length + suggestion.value.length + suffix.length;
    }

    onChange(nextValue);
    setCursor(nextCursor);
    setSuggestions([]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((current) => Math.min(current + 1, suggestions.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const suggestion = suggestions[activeIndex];
        if (suggestion) applySuggestion(suggestion);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSuggestions([]);
        return;
      }
    }

    onKeyDown?.(event);
  }

  return (
    <Popover open={open} onOpenChange={(nextOpen) => !nextOpen && setSuggestions([])}>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      <PopoverAnchor asChild>
        <div className="min-w-0 flex-1">
          <Textarea
            aria-label={ariaLabel}
            placeholder={placeholder}
            value={value}
            disabled={disabled}
            rows={rows}
            maxLength={maxLength}
            className={className}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onClick={(event) => syncCursor(event.currentTarget)}
            onKeyUp={(event) => syncCursor(event.currentTarget)}
            onSelect={(event) => syncCursor(event.currentTarget)}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        side={placement}
        align="start"
        sideOffset={8}
        collisionPadding={{ top: 56, right: 12, bottom: 12, left: 12 }}
        className="w-[min(36rem,calc(100vw-1.5rem))] max-w-[calc(100vw-1.5rem)] gap-0 overflow-hidden rounded-2xl p-1.5 shadow-xl ring-1 ring-foreground/10"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div
          role="listbox"
          aria-label={completionLabel(context)}
          className="max-h-[min(22rem,calc(var(--radix-popover-content-available-height)-0.75rem))] overflow-y-auto p-0.5"
        >
          <div className="sticky top-0 flex items-center gap-1.5 bg-popover/95 px-2 py-2 text-xs font-medium text-muted-foreground backdrop-blur-sm">
            {context?.kind === 'command' || context?.kind === 'command-option' ? (
              <>
                <SlashIcon className="size-3" aria-hidden="true" />
                {context.kind === 'command-option' ? context.command.label : 'Composer commands'}
              </>
            ) : (
              <>
                <AtIcon aria-hidden="true" />
                Reference a file
              </>
            )}
          </div>
          {suggestions.map((suggestion, index) => (
            <button
              key={`${suggestion.kind}:${suggestion.value}`}
              type="button"
              role="option"
              aria-label={suggestionLabel(context, suggestion)}
              aria-selected={index === activeIndex}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              className={cn(
                'flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
              )}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => applySuggestion(suggestion)}
            >
              <SuggestionIcon kind={suggestion.kind} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {suggestionLabel(context, suggestion)}
                </span>
                {suggestion.description ? (
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {suggestion.description}
                  </span>
                ) : null}
              </span>
              {context?.kind === 'command-option' &&
              context.command.currentValue === suggestion.value ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <CheckIcon className="size-3.5" aria-hidden="true" />
                  Current
                </span>
              ) : suggestion.kind === 'directory' ? (
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function completionContext(
  value: string,
  cursor: number,
  commands: readonly ComposerCommand[],
): CompletionContext | null {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const lineStart = value.lastIndexOf('\n', safeCursor - 1) + 1;
  const beforeCursor = value.slice(lineStart, safeCursor);
  const optionMatch = beforeCursor.match(/^\/([^\s]+)\s+(.*)$/);
  const command = optionMatch
    ? commands.find((candidate) => candidate.name === optionMatch[1])
    : undefined;

  if (command && optionMatch) {
    return { kind: 'command-option', prefix: optionMatch[2] ?? '', start: lineStart, command };
  }

  if (/^\/[^\s]*$/.test(beforeCursor)) {
    return { kind: 'command', prefix: beforeCursor, start: lineStart };
  }

  const match = beforeCursor.match(/(?:^|[\s"'=])(@(?:"[^"\n]*|[^\s]*)?)$/);
  if (match?.[1]) {
    return { kind: 'file', prefix: match[1], start: safeCursor - match[1].length };
  }
  return null;
}

function filterCommands(
  prefix: string,
  commands: readonly ComposerCommand[],
): ComposerSuggestion[] {
  const query = prefix.replace(/^\//, '').toLowerCase();
  const localCommands: ComposerSuggestion[] = commands.map((command) => ({
    value: command.name,
    label: `/${command.name}`,
    description: command.description,
    kind: 'command',
  }));
  return mergeCommandSuggestions(localCommands, FALLBACK_COMMANDS)
    .filter((command) => {
      const name = command.value.toLowerCase();
      return !query || name.includes(query);
    })
    .slice(0, 50);
}

function filterCommandOptions(command: ComposerCommand, prefix: string): ComposerSuggestion[] {
  const query = prefix.trim().toLowerCase();
  return command.options
    .filter((option) => {
      if (!query) return true;
      return (
        option.value.toLowerCase().includes(query) || option.label.toLowerCase().includes(query)
      );
    })
    .map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      kind: 'command' as const,
    }));
}

function mergeCommandSuggestions(
  primary: readonly ComposerSuggestion[],
  secondary: readonly ComposerSuggestion[],
): ComposerSuggestion[] {
  const merged = new Map<string, ComposerSuggestion>();
  for (const suggestion of [...primary, ...secondary]) {
    const key = `${suggestion.kind}:${suggestion.value.replace(/^\//, '')}`;
    if (!merged.has(key)) merged.set(key, suggestion);
  }
  return [...merged.values()];
}

function completionLabel(context: CompletionContext | null): string {
  if (context?.kind === 'command-option') return `${context.command.label} options`;
  if (context?.kind === 'command') return 'Composer commands';
  return 'Files';
}

function suggestionLabel(
  context: CompletionContext | null,
  suggestion: ComposerSuggestion,
): string {
  return context?.kind === 'command' && !suggestion.label.startsWith('/')
    ? `/${suggestion.label}`
    : suggestion.label;
}

function SuggestionIcon({ kind }: { kind: ComposerSuggestion['kind'] }) {
  if (kind === 'command') return <SlashIcon className="size-4 shrink-0" aria-hidden="true" />;
  if (kind === 'directory') return <FolderIcon className="size-4 shrink-0" aria-hidden="true" />;
  return <FileIcon className="size-4 shrink-0" aria-hidden="true" />;
}

function AtIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      aria-hidden="true"
      className={cn('size-3', className)}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M15.5 9.5v4.1a2.4 2.4 0 0 0 4.8 0V12a8.3 8.3 0 1 0-2.4 5.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
