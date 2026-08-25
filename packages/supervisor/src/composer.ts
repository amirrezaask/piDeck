import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import type {
  ComposerSuggestion,
  ComposerSuggestionsRequest,
  ComposerSuggestionsResponse,
} from '@nextflow/contracts';
import { resolveWorkingDirectory } from './working-directory.js';

const MAX_FILE_RESULTS = 20;
const MAX_WALK_ENTRIES = 2_500;
const IGNORED_DIRECTORY_NAMES = new Set(['.git']);

export interface ComposerCatalogOptions {
  readonly defaultCwd: string;
}

interface FileEntry {
  readonly path: string;
  readonly isDirectory: boolean;
}

interface PathPrefix {
  readonly raw: string;
  readonly isQuoted: boolean;
}

const BUILTIN_COMMANDS = [
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
] as const;

export class ComposerCatalog {
  private readonly defaultCwd: string;

  constructor(options: ComposerCatalogOptions) {
    this.defaultCwd = resolveWorkingDirectory(options.defaultCwd);
  }

  async list(request: ComposerSuggestionsRequest): Promise<ComposerSuggestionsResponse> {
    const cwd = resolveWorkingDirectory(request.cwd, this.defaultCwd);
    const suggestions =
      request.kind === 'command'
        ? listCommandSuggestions(request.prefix)
        : await listFileSuggestions(cwd, request.prefix);

    return { cwd, suggestions };
  }
}

function listCommandSuggestions(prefix: string): ComposerSuggestion[] {
  const query = prefix.startsWith('/') ? prefix.slice(1) : prefix;
  return BUILTIN_COMMANDS.map(([name, description, argumentHint]) => ({
    value: name,
    label: `/${name}`,
    description: argumentHint ? `${argumentHint} — ${description}` : description,
    kind: 'command' as const,
    score: scoreMatch(name, query),
  }))
    .filter((suggestion) => suggestion.score > 0)
    .sort((left, right) => right.score - left.score || left.value.localeCompare(right.value))
    .slice(0, 50)
    .map(({ score: _score, ...suggestion }) => suggestion);
}

async function listFileSuggestions(cwd: string, prefix: string): Promise<ComposerSuggestion[]> {
  const pathPrefix = parsePathPrefix(prefix);
  const rawPath = pathPrefix.raw;
  if (!rawPath) {
    return listDirectorySuggestions(cwd, cwd, '', pathPrefix);
  }

  const isPathLike =
    rawPath.includes('/') ||
    rawPath.includes('\\') ||
    rawPath.startsWith('.') ||
    rawPath.startsWith('~') ||
    rawPath.startsWith('/');
  if (isPathLike) {
    return listDirectoryPathSuggestions(cwd, rawPath, pathPrefix);
  }

  const entries = await walkFiles(cwd);
  const scored = entries
    .map((entry) => ({ entry, score: scoreMatch(entry.path, rawPath) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(right.entry.isDirectory) - Number(left.entry.isDirectory) ||
        left.entry.path.localeCompare(right.entry.path),
    )
    .slice(0, MAX_FILE_RESULTS);

  return scored.map(({ entry }) => toFileSuggestion(entry, cwd, pathPrefix));
}

async function listDirectoryPathSuggestions(
  cwd: string,
  rawPath: string,
  prefix: PathPrefix,
): Promise<ComposerSuggestion[]> {
  const expandedPath = expandHomePath(rawPath);
  const trailingSeparator = rawPath.endsWith('/') || rawPath.endsWith('\\');
  const directoryPath = trailingSeparator
    ? resolve(cwd, expandedPath)
    : resolve(cwd, dirname(expandedPath));
  const filePrefix = trailingSeparator ? '' : basename(expandedPath);

  return listDirectorySuggestions(cwd, directoryPath, filePrefix, prefix, rawPath);
}

async function listDirectorySuggestions(
  cwd: string,
  directoryPath: string,
  filePrefix: string,
  prefix: PathPrefix,
  rawPath = '',
): Promise<ComposerSuggestion[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const normalizedPrefix = filePrefix.toLowerCase();
  return entries
    .filter((entry) => !IGNORED_DIRECTORY_NAMES.has(entry.name))
    .filter((entry) => entry.name.toLowerCase().startsWith(normalizedPrefix))
    .map((entry) => {
      const isDirectory = entry.isDirectory();
      const path = pathForEntry(rawPath, entry.name);
      return toFileSuggestion({ path, isDirectory }, cwd, prefix, isDirectory);
    })
    .sort(
      (left, right) =>
        Number(right.kind === 'directory') - Number(left.kind === 'directory') ||
        left.label.localeCompare(right.label),
    )
    .slice(0, MAX_FILE_RESULTS);
}

async function walkFiles(cwd: string): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  const pending = [cwd];

  while (pending.length > 0 && results.length < MAX_WALK_ENTRIES) {
    const directory = pending.shift();
    if (!directory) break;

    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      const isDirectory = entry.isDirectory();
      const relativePath = toDisplayPath(relative(cwd, absolutePath));
      results.push({ path: relativePath, isDirectory });
      if (isDirectory && results.length < MAX_WALK_ENTRIES) pending.push(absolutePath);
      if (results.length >= MAX_WALK_ENTRIES) break;
    }
  }

  return results;
}

function toFileSuggestion(
  entry: FileEntry,
  cwd: string,
  prefix: PathPrefix,
  isDirectory = entry.isDirectory,
): ComposerSuggestion {
  const normalizedPath = toDisplayPath(entry.path);
  const displayPath = normalizedPath || '.';
  const pathValue = `${displayPath}${isDirectory ? '/' : ''}`;
  const needsQuotes = prefix.isQuoted || pathValue.includes(' ');
  const value = `@${needsQuotes ? `"${pathValue}"` : pathValue}`;
  const absolutePath = resolve(cwd, expandHomePath(normalizedPath));

  return {
    value,
    label: `${basename(displayPath)}${isDirectory ? '/' : ''}`,
    description: absolutePath,
    kind: isDirectory ? 'directory' : 'file',
  };
}

function parsePathPrefix(prefix: string): PathPrefix {
  const withoutAt = prefix.startsWith('@') ? prefix.slice(1) : prefix;
  if (withoutAt.startsWith('"')) {
    return {
      raw: withoutAt.slice(1).replace(/"$/, ''),
      isQuoted: true,
    };
  }
  return { raw: withoutAt, isQuoted: false };
}

function pathForEntry(rawPath: string, entryName: string): string {
  const normalized = toDisplayPath(rawPath);
  if (normalized.endsWith('/')) return `${normalized}${entryName}`;
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex === -1) return entryName;
  return `${normalized.slice(0, slashIndex + 1)}${entryName}`;
}

function expandHomePath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function scoreMatch(value: string, query: string): number {
  if (!query) return 1;
  const lowerValue = value.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerValue === lowerQuery) return 100;
  if (basename(lowerValue) === lowerQuery) return 95;
  if (basename(lowerValue).startsWith(lowerQuery)) return 80;
  if (basename(lowerValue).includes(lowerQuery)) return 60;
  if (lowerValue.includes(lowerQuery)) return 30;

  let queryIndex = 0;
  for (const character of lowerValue) {
    if (character === lowerQuery[queryIndex]) queryIndex += 1;
    if (queryIndex === lowerQuery.length) return 10;
  }
  return 0;
}

function toDisplayPath(value: string): string {
  return value.replace(/\\/g, '/');
}
