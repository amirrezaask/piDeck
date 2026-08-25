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

  it('does not create unsafe links from Markdown', () => {
    const { container } = render(
      <MarkdownContent content={'[Do not run](javascript:alert(1)) and **stay safe**.'} />,
    );

    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('Do not run');
    expect(container.querySelector('strong')).toHaveTextContent('stay safe');
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
