import { describe, expect, it } from 'vitest';

import { normalizeServerAddress } from './server-connections';

describe('normalizeServerAddress', () => {
  it('keeps the same-origin browser endpoint', () => {
    expect(normalizeServerAddress('/')).toBe('/');
    expect(normalizeServerAddress('/', true)).toBe('/');
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

  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'allows token-bearing loopback HTTP at %s',
    (host) => {
      expect(normalizeServerAddress(`http://${host}:4101`, true)).toBe(`http://${host}:4101`);
    },
  );

  it.each(['192.168.1.2', 'example.com', 'localhost.example.com', '127.0.0.1.example.com'])(
    'rejects token-bearing remote HTTP at %s',
    (host) => {
      expect(() => normalizeServerAddress(`http://${host}:4101`, true)).toThrow('must use HTTPS');
    },
  );

  it('allows tokenless remote HTTP and token-bearing remote HTTPS', () => {
    expect(normalizeServerAddress('http://agents.example.com', false)).toBe(
      'http://agents.example.com',
    );
    expect(normalizeServerAddress('https://agents.example.com', true)).toBe(
      'https://agents.example.com',
    );
  });
});
