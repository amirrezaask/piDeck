import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MarkdownContent } from './markdown-content';

describe('MarkdownContent', () => {
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
