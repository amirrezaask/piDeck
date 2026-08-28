import { CheckIcon, CopyIcon } from 'lucide-react';
import { type ElementType, type ReactNode, useEffect, useRef, useState } from 'react';
import type { HighlighterCore, LanguageInput } from 'shiki/types';

import { cn } from '@/lib/utils';

type MarkdownVariant = 'conversation' | 'preview';

type MarkdownContentProps = {
  content: string;
  className?: string;
  variant?: MarkdownVariant;
};

type CodeBlockProps = {
  code: string;
  language: string;
};

const highlightedCodeCache = new Map<string, string>();
const pendingHighlights = new Map<string, Promise<string>>();
const pendingLanguageLoads = new Map<string, Promise<HighlighterCore>>();
let highlighterPromise: Promise<HighlighterCore> | undefined;

const LANGUAGE_ALIASES: Record<string, string> = {
  cjs: 'javascript',
  'c++': 'cpp',
  'c#': 'csharp',
  'c-sharp': 'csharp',
  cs: 'csharp',
  dockerfile: 'docker',
  js: 'javascript',
  jsx: 'jsx',
  md: 'markdown',
  plain: 'text',
  plaintext: 'text',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  txt: 'text',
  yml: 'yaml',
};

type LanguageLoader = () => Promise<LanguageInput>;

const LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
  bash: () => import('@shikijs/langs/bash').then((module) => module.default),
  c: () => import('@shikijs/langs/c').then((module) => module.default),
  cpp: () => import('@shikijs/langs/cpp').then((module) => module.default),
  csharp: () => import('@shikijs/langs/csharp').then((module) => module.default),
  css: () => import('@shikijs/langs/css').then((module) => module.default),
  diff: () => import('@shikijs/langs/diff').then((module) => module.default),
  docker: () => import('@shikijs/langs/docker').then((module) => module.default),
  go: () => import('@shikijs/langs/go').then((module) => module.default),
  graphql: () => import('@shikijs/langs/graphql').then((module) => module.default),
  html: () => import('@shikijs/langs/html').then((module) => module.default),
  java: () => import('@shikijs/langs/java').then((module) => module.default),
  javascript: () => import('@shikijs/langs/javascript').then((module) => module.default),
  jsx: () => import('@shikijs/langs/jsx').then((module) => module.default),
  json: () => import('@shikijs/langs/json').then((module) => module.default),
  jsonc: () => import('@shikijs/langs/jsonc').then((module) => module.default),
  markdown: () => import('@shikijs/langs/markdown').then((module) => module.default),
  php: () => import('@shikijs/langs/php').then((module) => module.default),
  python: () => import('@shikijs/langs/python').then((module) => module.default),
  ruby: () => import('@shikijs/langs/ruby').then((module) => module.default),
  rust: () => import('@shikijs/langs/rust').then((module) => module.default),
  sql: () => import('@shikijs/langs/sql').then((module) => module.default),
  swift: () => import('@shikijs/langs/swift').then((module) => module.default),
  tsx: () => import('@shikijs/langs/tsx').then((module) => module.default),
  typescript: () => import('@shikijs/langs/typescript').then((module) => module.default),
  xml: () => import('@shikijs/langs/xml').then((module) => module.default),
  yaml: () => import('@shikijs/langs/yaml').then((module) => module.default),
};

type ListItem = {
  content: string;
  extraLines: string[];
  checked?: boolean;
};

type ListMarker = {
  indent: number;
  ordered: boolean;
  start?: number;
  content: string;
};

type TableAlignment = 'start' | 'left' | 'center' | 'right';

export function MarkdownContent({
  content,
  className,
  variant = 'conversation',
}: MarkdownContentProps) {
  return (
    <article
      data-slot="markdown-content"
      dir="auto"
      className={cn(
        'min-w-0 text-start text-sm',
        variant === 'conversation'
          ? 'leading-6 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0'
          : 'text-foreground',
        className,
      )}
    >
      {renderMarkdownBlocks(content, variant)}
    </article>
  );
}

function renderMarkdownBlocks(content: string, variant: MarkdownVariant): ReactNode[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trimEnd() ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = parseFenceStart(line);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !isFenceEnd(lines[index] ?? '', fence)) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;

      blocks.push(
        <MarkdownCodeBlock
          key={`code-${index}`}
          code={codeLines.join('\n')}
          language={fence.language}
        />,
      );
      continue;
    }

    const heading = /^(?: {0,3})(#{1,6})(?:\s+|$)(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push(renderHeading(heading[1].length, heading[2], variant, `heading-${index}`));
      index += 1;
      continue;
    }

    if (isThematicBreak(line)) {
      blocks.push(
        <hr
          key={`rule-${index}`}
          className={cn(
            'border-0 border-t border-border/70',
            variant === 'conversation' ? 'my-4' : 'my-6',
          )}
        />,
      );
      index += 1;
      continue;
    }

    if (isBlockquoteLine(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quoteLine = lines[index] ?? '';
        const match = /^(?: {0,3})> ?(.*)$/.exec(quoteLine);
        if (match) {
          quoteLines.push(match[1]);
          index += 1;
          continue;
        }
        if (!quoteLine.trim() && /^(?: {0,3})>/.test(lines[index + 1] ?? '')) {
          quoteLines.push('');
          index += 1;
          continue;
        }
        break;
      }
      blocks.push(
        <blockquote
          key={`quote-${index}`}
          dir={textDirection(quoteLines.join('\n'))}
          className={cn(
            'my-3 border-s border-border/80 ps-4 text-muted-foreground [&_[data-slot=markdown-content]]:my-0',
            variant === 'preview' && 'my-5',
          )}
        >
          {renderMarkdownBlocks(quoteLines.join('\n'), variant)}
        </blockquote>,
      );
      continue;
    }

    const list = parseListMarker(line);
    if (list) {
      const parsed = parseList(lines, index, list);
      blocks.push(renderList(parsed.items, parsed.ordered, parsed.start, variant, `list-${index}`));
      index = parsed.nextIndex;
      continue;
    }

    if (isTableStart(lines, index)) {
      const table = parseTable(lines, index);
      blocks.push(
        renderTable(table.headers, table.alignments, table.rows, variant, `table-${index}`),
      );
      index = table.nextIndex;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const paragraphLine = lines[index] ?? '';
      if (!paragraphLine.trim()) break;
      if (
        paragraph.length > 0 &&
        (parseFenceStart(paragraphLine.trimEnd()) ||
          /^(?: {0,3})(#{1,6})(?:\s+|$)/.test(paragraphLine) ||
          isThematicBreak(paragraphLine) ||
          isBlockquoteLine(paragraphLine) ||
          parseListMarker(paragraphLine) ||
          isTableStart(lines, index))
      ) {
        break;
      }
      paragraph.push(paragraphLine.trimEnd());
      index += 1;
    }

    // A soft Markdown line break is whitespace in a paragraph. Explicit hard
    // breaks (two spaces or a trailing slash) remain visible to chat readers.
    blocks.push(
      <p
        key={`paragraph-${index}`}
        dir="auto"
        className={cn(
          variant === 'conversation'
            ? 'mb-3 max-w-[75ch] whitespace-pre-wrap text-current'
            : 'my-4 max-w-2xl leading-7 text-muted-foreground',
        )}
      >
        {renderMarkdownInline(paragraph.join('\n'))}
      </p>,
    );
  }

  return blocks;
}

function renderHeading(
  level: number,
  content: string,
  variant: MarkdownVariant,
  key: string,
): ReactNode {
  const headingClasses =
    variant === 'conversation'
      ? level === 1
        ? 'mt-3 mb-2 text-xl'
        : level === 2
          ? 'mt-4 mb-1.5 text-lg'
          : level === 3
            ? 'mt-3 mb-1 text-base'
            : 'mt-3 mb-1 text-sm'
      : level === 1
        ? 'mb-5 text-3xl'
        : level === 2
          ? 'mt-9 mb-3 text-xl'
          : level === 3
            ? 'mt-7 mb-2 text-lg'
            : 'mt-5 mb-1 text-base';
  const Heading = `h${Math.min(level, 6)}` as ElementType;

  return (
    <Heading
      key={key}
      dir="auto"
      className={cn('font-semibold tracking-tight text-foreground', headingClasses)}
    >
      {renderMarkdownInline(content)}
    </Heading>
  );
}

function parseList(
  lines: string[],
  startIndex: number,
  first: ListMarker,
): { items: ListItem[]; ordered: boolean; start?: number; nextIndex: number } {
  const items: ListItem[] = [];
  let index = startIndex;
  let current: ListItem | undefined;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const marker = parseListMarker(line);

    if (marker && marker.indent === first.indent && marker.ordered === first.ordered) {
      const task = /^\[([ xX])\]\s+(.+)$/.exec(marker.content);
      current = {
        content: task?.[2] ?? marker.content,
        extraLines: [],
        ...(task ? { checked: task[1].toLowerCase() === 'x' } : {}),
      };
      items.push(current);
      index += 1;
      continue;
    }

    if (!current) break;
    if (!line.trim()) {
      const next = parseListMarker(lines[index + 1] ?? '');
      if (next && next.indent === first.indent && next.ordered === first.ordered) {
        index += 1;
        continue;
      }
      break;
    }

    const indentation = line.length - line.trimStart().length;
    if (indentation > first.indent) {
      const strip = Math.min(line.length, first.indent + 2);
      current.extraLines.push(line.slice(strip).trimEnd());
      index += 1;
      continue;
    }
    break;
  }

  return {
    items,
    ordered: first.ordered,
    start: first.start,
    nextIndex: index,
  };
}

function renderList(
  items: ListItem[],
  ordered: boolean,
  start: number | undefined,
  variant: MarkdownVariant,
  key: string,
): ReactNode {
  const List = ordered ? 'ol' : 'ul';
  return (
    <List
      key={key}
      start={ordered ? start : undefined}
      dir="auto"
      className={cn(
        ordered ? 'list-decimal' : 'list-disc',
        'my-3 space-y-1 ps-5 marker:text-muted-foreground',
        variant === 'preview' && 'my-5 space-y-2 leading-6',
      )}
    >
      {(() => {
        const itemKeys = stableKeys(
          items,
          `${key}-item`,
          (item) => `${item.content}\u0000${item.extraLines.join('\n')}`,
        );
        return items.map((item) => {
          const itemKey = itemKeys.shift() ?? `${key}-item`;
          return (
            <li key={itemKey} dir="auto" className="ps-1">
              {item.checked !== undefined ? (
                <span className="inline-flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={item.checked}
                    readOnly
                    tabIndex={-1}
                    aria-label={item.checked ? 'Completed task' : 'Incomplete task'}
                    className="mt-1 size-3.5 accent-primary"
                  />
                  <span>{renderMarkdownInline(item.content)}</span>
                </span>
              ) : (
                renderMarkdownInline(item.content)
              )}
              {item.extraLines.length > 0 ? (
                <div className="mt-2">
                  {renderMarkdownBlocks(item.extraLines.join('\n'), variant)}
                </div>
              ) : null}
            </li>
          );
        });
      })()}
    </List>
  );
}

function renderTable(
  headers: string[],
  alignments: TableAlignment[],
  rows: string[][],
  variant: MarkdownVariant,
  key: string,
): ReactNode {
  return (
    <div
      key={key}
      className={cn(
        'my-4 max-w-full overflow-x-auto rounded-lg border border-border/70',
        variant === 'preview' && 'my-6',
      )}
    >
      <table dir="auto" className="w-full min-w-max border-collapse text-start text-sm">
        <thead className="bg-muted/50">
          <tr>
            {stableKeys(headers, `${key}-header`, (header) => header).map((headerKey, index) => (
              <th
                key={headerKey}
                scope="col"
                className={cn(
                  'border-b border-border/70 px-3 py-2 font-semibold text-foreground',
                  tableAlignmentClass(alignments[index]),
                )}
              >
                {renderMarkdownInline(headers[index] ?? '')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(() => {
            const rowKeys = stableKeys(rows, `${key}-row`, (row) => row.join('\u0000'));
            return rows.map((row) => {
              const rowKey = rowKeys.shift() ?? `${key}-row`;
              const cellKeys = stableKeys(row, `${rowKey}-cell`, (cell) => cell);
              return (
                <tr key={rowKey} className="even:bg-muted/20">
                  {headers.map((_, cellIndex) => (
                    <td
                      key={cellKeys[cellIndex] ?? `${rowKey}-cell`}
                      className={cn(
                        'border-b border-border/50 px-3 py-2 align-top last:border-b-0',
                        tableAlignmentClass(alignments[cellIndex]),
                      )}
                    >
                      {renderMarkdownInline(row[cellIndex] ?? '')}
                    </td>
                  ))}
                </tr>
              );
            });
          })()}
        </tbody>
      </table>
    </div>
  );
}

function parseTable(
  lines: string[],
  startIndex: number,
): {
  headers: string[];
  alignments: TableAlignment[];
  rows: string[][];
  nextIndex: number;
} {
  const headers = splitTableCells(lines[startIndex] ?? '');
  const separators = splitTableCells(lines[startIndex + 1] ?? '');
  const alignments = headers.map((_, index) => {
    const separator = separators[index] ?? '';
    if (separator.startsWith(':') && separator.endsWith(':')) return 'center';
    if (separator.startsWith(':')) return 'left';
    if (separator.endsWith(':')) return 'right';
    return 'start';
  });
  const rows: string[][] = [];
  let index = startIndex + 2;

  while (index < lines.length && lines[index]?.trim() && lines[index]?.includes('|')) {
    rows.push(splitTableCells(lines[index] ?? ''));
    index += 1;
  }

  return { headers, alignments, rows, nextIndex: index };
}

function stableKeys<T>(
  values: readonly T[],
  prefix: string,
  keyValue: (value: T) => string,
): string[] {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const base = keyValue(value) || 'item';
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return `${prefix}-${base}-${occurrence}`;
  });
}

function tableAlignmentClass(alignment: TableAlignment | undefined): string {
  return alignment === 'center'
    ? 'text-center'
    : alignment === 'right'
      ? 'text-right'
      : alignment === 'left'
        ? 'text-left'
        : 'text-start';
}

function isTableStart(lines: string[], index: number): boolean {
  if (!lines[index]?.includes('|') || !lines[index + 1]?.includes('|')) return false;
  const separators = splitTableCells(lines[index + 1] ?? '');
  return separators.length > 0 && separators.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  let escaped = false;

  for (const character of trimmed) {
    if (character === '|' && !escaped) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    if (character === '\\' && !escaped) {
      escaped = true;
      current += character;
      continue;
    }
    escaped = false;
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function parseListMarker(line: string): ListMarker | undefined {
  const match = /^(\s{0,})([-+*]|(\d+)[.)])\s+(.+)$/.exec(line);
  if (!match) return undefined;
  return {
    indent: match[1].length,
    ordered: Boolean(match[3]),
    ...(match[3] ? { start: Number(match[3]) } : {}),
    content: match[4],
  };
}

function isThematicBreak(line: string): boolean {
  return /^(?: {0,3})(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function isBlockquoteLine(line: string): boolean {
  return /^(?: {0,3})>/.test(line);
}

function MarkdownCodeBlock({ code, language }: CodeBlockProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string>();
  const [copied, setCopied] = useState(false);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => clearTimeout(copyResetTimer.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const normalizedLanguage = normalizeLanguage(language);
    const cacheKey = `${normalizedLanguage}\u0000${code}`;
    const cachedHtml = highlightedCodeCache.get(cacheKey);

    if (cachedHtml) {
      setHighlightedHtml(cachedHtml);
      return () => {
        cancelled = true;
      };
    }

    void highlightCode(code, normalizedLanguage).then((html) => {
      if (!cancelled) setHighlightedHtml(html);
    });

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      clearTimeout(copyResetTimer.current);
      copyResetTimer.current = setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      data-slot="code-block"
      data-language={language || 'text'}
      dir="ltr"
      className="my-4 min-w-0 max-w-full overflow-hidden rounded-lg border border-border/80 bg-[var(--code-surface)] shadow-sm"
    >
      <div className="flex h-8 items-center justify-between border-b border-border/60 bg-[var(--code-header)] px-3">
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
          {language || 'code'}
        </span>
        <button
          type="button"
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[10px] font-medium text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => void copyCode()}
          aria-label={copied ? 'Code copied' : 'Copy code'}
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <div className="min-w-0 max-w-full overflow-x-auto">
        {highlightedHtml ? (
          <div
            data-slot="code-highlight"
            className="shiki-code"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki escapes source code before generating this highlighted HTML.
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <pre className="shiki-code-fallback">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

async function highlightCode(code: string, language: string): Promise<string> {
  const cacheKey = `${language}\u0000${code}`;
  const cachedHtml = highlightedCodeCache.get(cacheKey);
  if (cachedHtml) return cachedHtml;

  const pending = pendingHighlights.get(cacheKey);
  if (pending) return pending;

  const request = highlightCodeWithShiki(code, language)
    .then((html) => {
      highlightedCodeCache.set(cacheKey, html);
      return html;
    })
    .finally(() => {
      pendingHighlights.delete(cacheKey);
    });

  pendingHighlights.set(cacheKey, request);
  return request;
}

async function highlightCodeWithShiki(code: string, language: string): Promise<string> {
  const highlighter = await getHighlighterForLanguage(language);
  const loadedLanguage = LANGUAGE_LOADERS[language] ? language : 'text';

  try {
    return highlighter.codeToHtml(code, {
      lang: loadedLanguage,
      themes: {
        light: 'vitesse-light',
        dark: 'vitesse-dark',
      },
      defaultColor: false,
      rootStyle: false,
      tabindex: false,
    });
  } catch {
    return highlighter.codeToHtml(code, {
      lang: 'text',
      themes: {
        light: 'vitesse-light',
        dark: 'vitesse-dark',
      },
      defaultColor: false,
      rootStyle: false,
      tabindex: false,
    });
  }
}

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= Promise.all([
    import('@shikijs/engine-javascript'),
    import('shiki/core'),
    import('@shikijs/themes/vitesse-dark'),
    import('@shikijs/themes/vitesse-light'),
  ]).then(([engine, core, vitesseDark, vitesseLight]) =>
    core.createHighlighterCore({
      engine: engine.createJavaScriptRegexEngine(),
      themes: [vitesseLight.default, vitesseDark.default],
      warnings: false,
    }),
  );
  return highlighterPromise;
}

function getHighlighterForLanguage(language: string): Promise<HighlighterCore> {
  const loader = LANGUAGE_LOADERS[language];
  if (!loader) return getHighlighter();

  const pending = pendingLanguageLoads.get(language);
  if (pending) return pending;

  const request = getHighlighter().then(async (highlighter) => {
    if (!highlighter.getLoadedLanguages().includes(language)) {
      await highlighter.loadLanguage(await loader());
    }
    return highlighter;
  });
  pendingLanguageLoads.set(language, request);
  return request;
}

function parseFenceStart(
  line: string,
): { marker: '`' | '~'; length: number; language: string } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;

  const marker = match[1][0] as '`' | '~';
  const info = match[2].trim();
  return {
    marker,
    length: match[1].length,
    language: info.split(/\s+/, 1)[0] ?? '',
  };
}

function isFenceEnd(line: string, fence: { marker: '`' | '~'; length: number }): boolean {
  const escapedMarker = fence.marker === '`' ? '`' : '~';
  return new RegExp(`^ {0,3}${escapedMarker}{${fence.length},}\\s*$`).test(line);
}

function normalizeLanguage(language: string): string {
  const normalized = language
    .trim()
    .toLowerCase()
    .replace(/^language-/, '');
  return LANGUAGE_ALIASES[normalized] ?? (normalized || 'text');
}

function renderMarkdownInline(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  let textStart = 0;

  const pushText = (end: number) => {
    if (end > textStart) nodes.push(value.slice(textStart, end));
  };
  const pushToken = (node: ReactNode, end: number) => {
    pushText(index);
    nodes.push(node);
    index = end;
    textStart = index;
  };

  while (index < value.length) {
    const character = value[index];

    if (character === '\\' && isMarkdownPunctuation(value[index + 1])) {
      pushText(index);
      nodes.push(value[index + 1]);
      index += 2;
      textStart = index;
      continue;
    }

    if (character === '\n') {
      const hardBreak = / {2,}$/.test(value.slice(textStart, index));
      pushText(
        hardBreak
          ? index - (value.slice(textStart, index).match(/ {2,}$/)?.[0].length ?? 0)
          : index,
      );
      nodes.push(<br key={`break-${index}`} />);
      index += 1;
      textStart = index;
      continue;
    }

    if (character === '`') {
      const delimiter = value.slice(index).match(/^`+/)?.[0] ?? '`';
      const close = value.indexOf(delimiter, index + delimiter.length);
      if (close > index + delimiter.length) {
        const code = value
          .slice(index + delimiter.length, close)
          .replace(/\n/g, ' ')
          .trim();
        pushToken(
          <code
            key={`code-${index}`}
            dir="ltr"
            className="inline-block rounded-md border border-border/60 bg-muted/80 px-1.5 py-0.5 font-mono text-[0.85em] text-current [unicode-bidi:isolate]"
          >
            {code}
          </code>,
          close + delimiter.length,
        );
        continue;
      }
    }

    const link = parseInlineLink(value, index);
    if (link) {
      const safeHref = safeLinkHref(link.href);
      pushToken(
        safeHref ? (
          <a
            key={`link-${index}`}
            href={safeHref}
            target={safeHref.startsWith('http') ? '_blank' : undefined}
            rel={safeHref.startsWith('http') ? 'noreferrer' : undefined}
            className="font-medium text-primary underline decoration-primary/35 underline-offset-2 transition-colors hover:decoration-primary"
          >
            {renderMarkdownInline(link.label)}
          </a>
        ) : (
          <span key={`link-${index}`}>{renderMarkdownInline(link.label)}</span>
        ),
        link.end,
      );
      continue;
    }

    const autolink = /^<(https?:\/\/[^\s>]+|mailto:[^\s>]+)>/.exec(value.slice(index));
    if (autolink) {
      const href = autolink[1];
      pushToken(
        <a
          key={`autolink-${index}`}
          href={href}
          dir="ltr"
          target={href.startsWith('http') ? '_blank' : undefined}
          rel={href.startsWith('http') ? 'noreferrer' : undefined}
          className="font-medium text-primary underline decoration-primary/35 underline-offset-2 transition-colors hover:decoration-primary"
        >
          {href.replace(/^mailto:/, '')}
        </a>,
        index + autolink[0].length,
      );
      continue;
    }

    const strong = findInlineDelimiter(value, index, '**', '__');
    if (strong) {
      pushToken(
        <strong key={`strong-${index}`} className="font-semibold text-foreground">
          {renderMarkdownInline(value.slice(index + 2, strong.close))}
        </strong>,
        strong.close + 2,
      );
      continue;
    }

    const strike = findInlineDelimiter(value, index, '~~');
    if (strike) {
      pushToken(
        <del
          key={`strike-${index}`}
          className="text-muted-foreground line-through decoration-muted-foreground/70"
        >
          {renderMarkdownInline(value.slice(index + 2, strike.close))}
        </del>,
        strike.close + 2,
      );
      continue;
    }

    const emphasis = findEmphasisDelimiter(value, index);
    if (emphasis) {
      pushToken(
        <em key={`emphasis-${index}`} className="italic">
          {renderMarkdownInline(value.slice(index + 1, emphasis.close))}
        </em>,
        emphasis.close + 1,
      );
      continue;
    }

    index += 1;
  }

  pushText(value.length);
  return nodes;
}

type InlineLink = { label: string; href: string; end: number };

function parseInlineLink(value: string, index: number): InlineLink | undefined {
  if (value[index] !== '[') return undefined;
  const labelEnd = value.indexOf('](', index + 1);
  if (labelEnd < 0) return undefined;
  const close = value.indexOf(')', labelEnd + 2);
  if (close < 0) return undefined;
  const destination = value.slice(labelEnd + 2, close).trim();
  const match = /^(\S+?)(?:\s+["'].*["'])?$/.exec(destination);
  if (!match) return undefined;
  return { label: value.slice(index + 1, labelEnd), href: match[1], end: close + 1 };
}

function safeLinkHref(href: string): string | undefined {
  const normalized = href.trim();
  if (/^(?:\/\/|\/\\|\\\\)/.test(normalized)) return undefined;
  if (/^(?:https?:|mailto:|tel:|\/|#|\.\/|\.\.\/)/i.test(normalized)) return normalized;
  return undefined;
}

function findInlineDelimiter(
  value: string,
  index: number,
  ...delimiters: string[]
): { close: number } | undefined {
  const delimiter = delimiters.find((candidate) => value.startsWith(candidate, index));
  if (!delimiter) return undefined;
  const close = value.indexOf(delimiter, index + delimiter.length);
  if (close <= index + delimiter.length) return undefined;
  return { close };
}

function findEmphasisDelimiter(value: string, index: number): { close: number } | undefined {
  const delimiter = value[index];
  if (delimiter !== '*' && delimiter !== '_') return undefined;
  if (value.startsWith(`${delimiter}${delimiter}`, index)) return undefined;
  if (delimiter === '_' && isWordCharacter(value[index - 1]) && isWordCharacter(value[index + 1])) {
    return undefined;
  }
  const close = value.indexOf(delimiter, index + 1);
  if (
    close <= index + 1 ||
    (delimiter === '_' && isWordCharacter(value[close - 1]) && isWordCharacter(value[close + 1]))
  ) {
    return undefined;
  }
  return { close };
}

function isMarkdownPunctuation(value: string | undefined): value is string {
  return value !== undefined && /[\\`*_[\]{}()#+.!~<>-]/.test(value);
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

function textDirection(value: string): 'ltr' | 'rtl' | 'auto' {
  for (const character of value) {
    if (/[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(character)) return 'rtl';
    if (/\p{L}/u.test(character)) return 'ltr';
  }
  return 'auto';
}
