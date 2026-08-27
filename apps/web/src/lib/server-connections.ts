import { SupervisorClient } from './supervisor-client';

export interface ServerDefinition {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly hasToken: boolean;
  readonly isBuiltin?: boolean;
}

export interface ServerInput {
  readonly id?: string;
  readonly name: string;
  readonly address: string;
  readonly token?: string;
}

interface ServerRequest {
  readonly serverId: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

interface ServerResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface PiDeckServerBridge {
  list(): Promise<ServerDefinition[]>;
  save(input: ServerInput): Promise<ServerDefinition>;
  remove(serverId: string): Promise<void>;
  request(input: ServerRequest): Promise<ServerResponse>;
}

declare global {
  interface Window {
    piDeckServers?: PiDeckServerBridge;
  }
}

export interface ServerConnectionManager {
  list(): Promise<ServerDefinition[]>;
  save(input: ServerInput): Promise<ServerDefinition>;
  remove(serverId: string): Promise<void>;
  client(server: ServerDefinition): SupervisorClient;
}

const STORAGE_KEY = 'pideck-servers-v1';
const DEFAULT_BROWSER_SERVER: StoredServer = {
  id: 'local',
  name: 'Local',
  address: '/',
  token: '',
};

interface StoredServer {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly token: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normalizeServerAddress(address: string, sendsToken = false): string {
  const trimmed = address.trim();
  if (trimmed === '/' || trimmed === '/supervisor') {
    if (sendsToken) {
      const pageOrigin = globalThis.location?.origin;
      if (!pageOrigin) throw new Error('Cannot validate token transport without a page origin');
      normalizeServerAddress(pageOrigin, true);
    }
    return trimmed;
  }
  const value = trimmed.replace(/\/+$/, '');
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Server address must use http:// or https://');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enter the server origin only, without credentials, query, or path');
  }
  if (sendsToken && url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('Servers outside this computer must use HTTPS when an access token is saved');
  }
  return url.origin;
}

class BrowserServerConnectionManager implements ServerConnectionManager {
  async list(): Promise<ServerDefinition[]> {
    return this.read().map(publicServer);
  }

  async save(input: ServerInput): Promise<ServerDefinition> {
    const servers = this.read();
    const id = input.id ?? crypto.randomUUID();
    const existing = servers.find((server) => server.id === id);
    const token = input.token === undefined ? (existing?.token ?? '') : input.token.trim();
    const server: StoredServer = {
      id,
      name: input.name.trim(),
      address: normalizeServerAddress(input.address, Boolean(token)),
      token,
    };
    if (!server.name) throw new Error('Server name is required');
    const next = [server, ...servers.filter((candidate) => candidate.id !== id)];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return publicServer(server);
  }

  async remove(serverId: string): Promise<void> {
    const next = this.read().filter((server) => server.id !== serverId);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  client(server: ServerDefinition): SupervisorClient {
    const stored = this.read().find((candidate) => candidate.id === server.id);
    const baseUrl = normalizeServerAddress(server.address, Boolean(stored?.token));
    return new SupervisorClient({
      baseUrl,
      ...(stored?.token ? { serviceToken: stored.token } : {}),
    });
  }

  private read(): StoredServer[] {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [DEFAULT_BROWSER_SERVER];
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) return [DEFAULT_BROWSER_SERVER];
      return value.filter(isStoredServer);
    } catch {
      return [DEFAULT_BROWSER_SERVER];
    }
  }
}

class ElectronServerConnectionManager implements ServerConnectionManager {
  readonly #bridge: PiDeckServerBridge;

  constructor(bridge: PiDeckServerBridge) {
    this.#bridge = bridge;
  }

  list(): Promise<ServerDefinition[]> {
    return this.#bridge.list();
  }

  save(input: ServerInput): Promise<ServerDefinition> {
    return this.#bridge.save(input);
  }

  remove(serverId: string): Promise<void> {
    return this.#bridge.remove(serverId);
  }

  client(server: ServerDefinition): SupervisorClient {
    return new SupervisorClient({
      baseUrl: server.address,
      fetcher: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, server.address);
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => {
          headers[key] = value;
        });
        const response = await this.#bridge.request({
          serverId: server.id,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? 'GET',
          headers,
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        });
        return new Response(response.body, {
          status: response.status,
          headers: response.headers,
        });
      },
    });
  }
}

function publicServer(server: StoredServer): ServerDefinition {
  return {
    id: server.id,
    name: server.name,
    address: server.address,
    hasToken: server.token.length > 0,
    isBuiltin: false,
  };
}

function isStoredServer(value: unknown): value is StoredServer {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredServer>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.address === 'string' &&
    typeof candidate.token === 'string'
  );
}

export const serverConnectionManager: ServerConnectionManager = window.piDeckServers
  ? new ElectronServerConnectionManager(window.piDeckServers)
  : new BrowserServerConnectionManager();
