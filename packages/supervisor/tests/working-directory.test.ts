import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertWorkingDirectory,
  type InvalidWorkingDirectoryError,
  resolveWorkingDirectory,
} from '../src/working-directory';

describe('working-directory helpers', () => {
  it('expands home-relative paths before resolving them', () => {
    expect(resolveWorkingDirectory('~/dev/consultation')).toBe(
      resolve(homedir(), 'dev/consultation'),
    );
    expect(resolveWorkingDirectory('~')).toBe(homedir());
  });

  it('resolves ordinary relative paths from the supplied base directory', () => {
    expect(resolveWorkingDirectory('workspace', '/tmp')).toBe('/tmp/workspace');
  });

  it('rejects missing or non-directory paths', async () => {
    await expect(assertWorkingDirectory('/definitely/missing/pideck-path')).rejects.toEqual(
      expect.objectContaining({
        name: 'InvalidWorkingDirectoryError',
        path: '/definitely/missing/pideck-path',
      } satisfies Partial<InvalidWorkingDirectoryError>),
    );
  });
});
