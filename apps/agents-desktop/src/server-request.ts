export interface ServerInput {
  readonly id?: string;
  readonly name: string;
  readonly address: string;
  readonly token?: string;
}

export interface ServerRequest {
  readonly serverId: string;
  readonly path: string;
  readonly method: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface PreparedServerRequest {
  readonly target: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body?: string;
}

const allowedMethods = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
const maximumBodyBytes = 32 * 1024 * 1024;
const allowedPath = /^\/agents\/v1\/[A-Za-z0-9_~!$&'()*+,;=:@%./-]*$/;
const forwardedHeaders = ['accept', 'content-type', 'idempotency-key'] as const;

export function parseServerInput(value: unknown): ServerInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid server');
  }
  const input = value as Partial<ServerInput>;
  if (
    (input.id !== undefined && (typeof input.id !== 'string' || !input.id)) ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    typeof input.address !== 'string' ||
    (input.token !== undefined && typeof input.token !== 'string')
  ) {
    throw new Error('Invalid server');
  }
  return input as ServerInput;
}

export function parseServerRequest(value: unknown): ServerRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid server request');
  }
  const request = value as Partial<ServerRequest>;
  if (
    typeof request.serverId !== 'string' ||
    !request.serverId ||
    typeof request.path !== 'string' ||
    typeof request.method !== 'string' ||
    (request.headers !== undefined &&
      (request.headers === null ||
        typeof request.headers !== 'object' ||
        Array.isArray(request.headers) ||
        Object.values(request.headers).some((item) => typeof item !== 'string'))) ||
    (request.body !== undefined && typeof request.body !== 'string')
  ) {
    throw new Error('Invalid server request');
  }
  return request as ServerRequest;
}

export function prepareServerRequest(
  request: ServerRequest,
  serverAddress: string,
): PreparedServerRequest {
  const method = request.method.toUpperCase();
  if (!allowedMethods.has(method)) throw new Error('Unsupported server request method');
  if (!request.path.startsWith('/agents/v1/')) {
    throw new Error('Unsupported server request path');
  }

  const target = new URL(request.path, serverAddress);
  if (
    target.origin !== serverAddress ||
    !allowedPath.test(target.pathname) ||
    target.hash ||
    request.path.includes('\\')
  ) {
    throw new Error('Unsupported server request path');
  }
  if ((request.body?.length ?? 0) > maximumBodyBytes) {
    throw new Error('Server request is too large');
  }

  const headers = new Headers();
  for (const name of forwardedHeaders) {
    const value = request.headers?.[name];
    if (value) headers.set(name, value);
  }
  return {
    target,
    method,
    headers,
    ...(request.body === undefined ? {} : { body: request.body }),
  };
}
