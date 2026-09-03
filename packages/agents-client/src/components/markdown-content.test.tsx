import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MarkdownContent } from './markdown-content';

describe('MarkdownContent', () => {
  it('renders common inline and block Markdown as semantic elements', () => {
    const { container } = render(
      <MarkdownContent
        content={`# This repo configures:\n\n- **Neovim** — \`nvim/\`\n- [Open the docs](https://example.com/docs)\n\n> Keep the setup focused.\n\n| Tool | Path |\n| :--- | ---: |\n| Git | \`.gitconfig\` |`}
      />,
    );

    expect(container.querySelector('h1')).toHaveTextContent('This repo configures:');
    expect(container.querySelector('strong')).toHaveTextContent('Neovim');
    expect(container.querySelector('code')).toHaveTextContent('nvim/');
    expect(container.querySelector('blockquote')).toHaveTextContent('Keep the setup focused.');
    expect(container.querySelector('table')).toHaveTextContent('Git');
    expect(container.querySelector('a')).toHaveAttribute('href', 'https://example.com/docs');
  });

  it('uses each Markdown block’s natural direction while isolating code', () => {
    const { container } = render(
      <MarkdownContent
        variant="preview"
        content={`# خلاصه\n\nاین متن فارسی شامل \`npm run build\` است.\n\n- مورد اول\n- مورد دوم\n\n> متن نقل‌قول\n\n| نام | مقدار |\n| --- | ---: |\n| وضعیت | Ready |\n\n\`شناسه-42\`\n\n\`\`\`ts\nconst status = 'آماده';\n\`\`\``}
      />,
    );

    expect(container.querySelector('article')).toHaveAttribute('dir', 'auto');
    expect(container.querySelector('h1')).toHaveAttribute('dir', 'auto');
    expect(container.querySelector('p')).toHaveAttribute('dir', 'auto');
    expect(container.querySelector('ul')).toHaveAttribute('dir', 'auto');
    expect(container.querySelector('li')).toHaveAttribute('dir', 'auto');
    expect(container.querySelector('blockquote')).toHaveAttribute('dir', 'rtl');
    expect(container.querySelector('table')).toHaveAttribute('dir', 'auto');
    expect(container.querySelector('th')).toHaveClass('text-start');
    expect(container.querySelector('code')).toHaveAttribute('dir', 'ltr');
    expect(container.querySelector('[data-slot="code-block"]')).toHaveAttribute('dir', 'ltr');
  });

  it('does not create unsafe links from Markdown', () => {
    const { container } = render(
      <MarkdownContent
        content={
          '[Script](javascript:alert(1)), [data](data:text/html,boom), and [protocol relative](//evil.example/path) stay inert.'
        }
      />,
    );

    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('Script');
    expect(container).toHaveTextContent('protocol relative');
  });

  it('renders trusted external links with opener isolation', () => {
    const { container } = render(
      <MarkdownContent content={'[Open the docs](https://example.com/docs)'} />,
    );

    expect(container.querySelector('a')).toHaveAttribute('href', 'https://example.com/docs');
    expect(container.querySelector('a')).toHaveAttribute('target', '_blank');
    expect(container.querySelector('a')).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders raw HTML as text instead of creating executable elements', () => {
    const { container } = render(
      <MarkdownContent
        content={'<script>globalThis.markdownXss = true</script><img src=x onerror=alert(1)>'}
      />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('<script>');
    expect(
      (globalThis as typeof globalThis & { markdownXss?: boolean }).markdownXss,
    ).toBeUndefined();
  });

  it('renders fenced code blocks with Shiki highlighting', async () => {
    const { container } = render(
      <MarkdownContent content={'Here is the change:\n\n```ts\nconst answer: number = 42;\n```'} />,
    );

    const codeBlock = container.querySelector('[data-slot="code-block"]');
    expect(codeBlock).not.toBeNull();
    expect(codeBlock).toHaveAttribute('data-language', 'ts');
    expect(codeBlock).toHaveTextContent('const answer: number = 42;');

    await waitFor(() => {
      expect(codeBlock?.querySelector('[data-slot="code-highlight"] .shiki')).not.toBeNull();
    });
    expect(codeBlock).toHaveTextContent('const answer: number = 42;');
  });
});
