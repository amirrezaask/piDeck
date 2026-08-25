import { describe, expect, it } from 'vitest';

import { normalizeServerAddress } from './server-connections';

describe('normalizeServerAddress', () => {
  it('keeps the same-origin browser endpoint', () => {
    expect(normalizeServerAddress('/')).toBe('/');
  });

  it('normalizes an HTTP server origin', () => {
    expect(normalizeServerAddress(' https://agents.example.com/ ')).toBe(
      'https://agents.example.com',
    );
  });

  it('rejects credentials and API paths', () => {
    expect(() => normalizeServerAddress('https://token@agents.example.com')).toThrow(
      'without credentials',
    );
    expect(() => normalizeServerAddress('https://agents.example.com/v1')).toThrow(
      'without credentials',
    );
  });

  it('rejects non-HTTP protocols', () => {
    expect(() => normalizeServerAddress('file:///tmp/server')).toThrow(
      'must use http:// or https://',
    );
  });
});
