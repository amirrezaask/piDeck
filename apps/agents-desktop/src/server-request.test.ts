import { describe, expect, it } from 'vitest';

import { parseServerInput, parseServerRequest, prepareServerRequest } from './server-request.js';

describe('Electron server request broker', () => {
  it('accepts valid server and request payloads', () => {
    expect(
      parseServerInput({
        id: 'remote',
        name: 'Build host',
        address: 'https://agents.example.com',
        token: 'secret',
      }),
    ).toMatchObject({ id: 'remote', name: 'Build host' });
    expect(
      parseServerRequest({
        serverId: 'remote',
        path: '/agents/v1/agents?limit=25',
        method: 'get',
        headers: { accept: 'application/json' },
      }),
    ).toMatchObject({ serverId: 'remote', method: 'get' });
  });

  it.each([
    null,
    [],
    { name: '', address: 'https://agents.example.com' },
    { id: '', name: 'Build host', address: 'https://agents.example.com' },
    { name: 'Build host', address: 42 },
  ])('rejects malformed server input %#', (value) => {
    expect(() => parseServerInput(value)).toThrow('Invalid server');
  });

  it.each([
    null,
    [],
    { serverId: '', path: '/agents/v1/health', method: 'GET' },
    { serverId: 'remote', path: '/agents/v1/health', method: 'GET', headers: null },
    { serverId: 'remote', path: '/agents/v1/health', method: 'GET', headers: [] },
    { serverId: 'remote', path: '/agents/v1/health', method: 'GET', body: 42 },
  ])('rejects malformed server requests %#', (value) => {
    expect(() => parseServerRequest(value)).toThrow('Invalid server request');
  });

  it('resolves API paths and forwards only explicitly allowed headers', () => {
    const prepared = prepareServerRequest(
      {
        serverId: 'remote',
        path: '/agents/v1/agents?limit=25',
        method: 'post',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': 'run-1',
          authorization: 'Bearer renderer-controlled-token',
          cookie: 'renderer-cookie',
          'x-forwarded-for': '203.0.113.10',
        },
        body: '{}',
      },
      'https://agents.example.com',
    );

    expect(prepared.target.toString()).toBe('https://agents.example.com/agents/v1/agents?limit=25');
    expect(prepared.method).toBe('POST');
    expect(Object.fromEntries(prepared.headers.entries())).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': 'run-1',
    });
    expect(prepared.body).toBe('{}');
  });

  it.each([
    'https://evil.example/agents/v1/agents',
    '//evil.example/agents/v1/agents',
    '/agents/v1/../../admin',
    '/agents/v1/%2e%2e/admin',
    '/v1\\health',
    '/agents/v1/health#fragment',
    '/v10/agents',
    'v1/agents',
  ])('rejects a request path that escapes the configured API: %s', (path) => {
    expect(() =>
      prepareServerRequest(
        { serverId: 'remote', path, method: 'GET' },
        'https://agents.example.com',
      ),
    ).toThrow('Unsupported server request path');
  });

  it('rejects unsupported methods and oversized bodies', () => {
    expect(() =>
      prepareServerRequest(
        { serverId: 'remote', path: '/agents/v1/health', method: 'CONNECT' },
        'https://agents.example.com',
      ),
    ).toThrow('Unsupported server request method');

    expect(() =>
      prepareServerRequest(
        {
          serverId: 'remote',
          path: '/agents/v1/runs',
          method: 'POST',
          body: 'x'.repeat(32 * 1024 * 1024 + 1),
        },
        'https://agents.example.com',
      ),
    ).toThrow('Server request is too large');
  });
});
