import { type ReactNode, useEffect, useState } from 'react';
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

export function MarkdownContent({
  content,
  className,
  variant = 'conversation',
}: MarkdownContentProps) {
  return (
    <article
      data-slot="markdown-content"
      className={cn(
        'min-w-0 text-sm',
        variant === 'conversation'
          ? 'space-y-2 leading-5 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0'
          : 'text-foreground',
        className,
      )}
    >
      {renderMarkdownBlocks(content, variant)}
    </article>
  );
}

function renderMarkdownBlocks(content: string, variant: MarkdownVariant): ReactNode[] {
  const lines = content.split('\n');
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

    if (line.startsWith('- ') || line.startsWith('* ')) {
      const items: string[] = [];
      while (index < lines.length) {
        const listLine = lines[index] ?? '';
        if (!listLine.startsWith('- ') && !listLine.startsWith('* ')) break;
        items.push(listLine.slice(2));
        index += 1;
      }
      blocks.push(
        <ul
          key={`list-${index}`}
          className={cn(
            'list-disc pl-5',
            variant === 'conversation' ? 'my-3 space-y-1' : 'my-4 space-y-2 leading-6',
          )}
        >
          {items.map((item) => (
            <li key={item}>{renderMarkdownInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const Heading = heading[1].length === 1 ? 'h1' : heading[1].length === 2 ? 'h2' : 'h3';
      blocks.push(
        <Heading
          key={`heading-${index}`}
          className={cn(
            'font-semibold tracking-tight',
            variant === 'conversation'
              ? Heading === 'h1'
                ? 'mt-2 mb-2 text-lg'
                : Heading === 'h2'
                  ? 'mt-4 mb-1 text-base'
                  : 'mt-3 mb-1 text-sm'
              : Heading === 'h1'
                ? 'mb-4 text-2xl'
                : Heading === 'h2'
                  ? 'mt-8 mb-3 text-lg'
                  : 'mt-6 mb-2 text-base',
          )}
        >
          {renderMarkdownInline(heading[2])}
        </Heading>,
      );
      index += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const paragraphLine = lines[index] ?? '';
      if (
        !paragraphLine.trim() ||
        parseFenceStart(paragraphLine.trimEnd()) ||
        /^(#{1,3})\s+/.test(paragraphLine) ||
        paragraphLine.startsWith('- ') ||
        paragraphLine.startsWith('* ')
      ) {
        break;
      }
      paragraph.push(paragraphLine);
      index += 1;
    }

    blocks.push(
      <p
        key={`paragraph-${index}`}
        className={cn(
          variant === 'conversation'
            ? 'm-0 whitespace-pre-wrap text-current'
            : 'my-4 max-w-2xl leading-7 text-muted-foreground',
        )}
      >
        {renderMarkdownInline(paragraph.join(' '))}
      </p>,
    );
  }

  return blocks;
}

function MarkdownCodeBlock({ code, language }: CodeBlockProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string>();

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

  return (
    <div
      data-slot="code-block"
      data-language={language || 'text'}
      className="my-3 min-w-0 max-w-full overflow-hidden rounded-lg border border-border/70 bg-background/80 shadow-xs"
    >
      <div className="flex items-center border-b border-border/60 bg-muted/45 px-3 py-1.5">
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {language || 'code'}
        </span>
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
        light: 'github-light',
        dark: 'github-dark',
      },
      defaultColor: false,
      rootStyle: false,
      tabindex: false,
    });
  } catch {
    return highlighter.codeToHtml(code, {
      lang: 'text',
      themes: {
        light: 'github-light',
        dark: 'github-dark',
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
    import('@shikijs/themes/github-dark'),
    import('@shikijs/themes/github-light'),
  ]).then(([engine, core, githubDark, githubLight]) =>
    core.createHighlighterCore({
      engine: engine.createJavaScriptRegexEngine(),
      themes: [githubLight.default, githubDark.default],
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
  const occurrences = new Map<string, number>();
  return value.split(/(`[^`]+`)/g).map((part) => {
    const occurrence = occurrences.get(part) ?? 0;
    occurrences.set(part, occurrence + 1);
    const key = `${part}-${occurrence}`;

    return part.startsWith('`') && part.endsWith('`') ? (
      <code
        key={key}
        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-current"
      >
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    );
  });
}
