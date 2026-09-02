import { describe, expect, it } from 'vitest';

import { normalizeServerOrigin } from './server-origin.js';

describe('normalizeServerOrigin', () => {
  it.each([
    ['https://agents.example.com', 'https://agents.example.com'],
    ['http://localhost:4101', 'http://localhost:4101'],
    ['http://127.0.0.1:4101', 'http://127.0.0.1:4101'],
    ['http://[::1]:4101', 'http://[::1]:4101'],
  ])('accepts token transport to %s', (address, expected) => {
    expect(normalizeServerOrigin(address, true)).toBe(expected);
  });

  it.each([
    'http://192.168.1.2:4101',
    'http://example.com',
    'http://localhost.example.com',
    'http://127.0.0.1.example.com',
  ])('rejects token transport to plaintext remote origin %s', (address) => {
    expect(() => normalizeServerOrigin(address, true)).toThrow('must use HTTPS');
  });

  it.each([
    'https://user@example.com',
    'https://example.com/v1',
    'https://example.com?query=1',
    'https://example.com#fragment',
    'file:///tmp/server',
  ])('rejects a non-origin address %s', (address) => {
    expect(() => normalizeServerOrigin(address, true)).toThrow();
  });

  it('allows a tokenless plaintext remote origin', () => {
    expect(normalizeServerOrigin('http://192.168.1.2:4101', false)).toBe('http://192.168.1.2:4101');
  });
});
