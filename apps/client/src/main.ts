import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';

import { buildSupervisorApp, type SupervisorApp } from '@pideck/supervisor';
import {
  app,
  BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  net,
  safeStorage,
  session,
} from 'electron';
import { normalizeServerOrigin } from './server-origin.js';

interface StoredServer {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly encryptedToken?: string;
}

interface ServerInput {
  readonly id?: string;
  readonly name: string;
  readonly address: string;
  readonly token?: string;
}

interface ServerRequest {
  readonly serverId: string;
  readonly path: string;
  readonly method: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

const BUILTIN_SERVER_ID = 'builtin';
const allowedMethods = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
let mainWindow: BrowserWindow | undefined;
let servers: StoredServer[] = [];
let builtinServer: StoredServer | undefined;
let builtinSupervisor: SupervisorApp | undefined;
let builtinServiceToken: string | undefined;
let isQuitting = false;

function configPath(): string {
  return join(app.getPath('userData'), 'servers.json');
}

async function startBuiltinServer(): Promise<StoredServer> {
  const serviceToken = randomBytes(32).toString('base64url');
  const supervisor = buildSupervisorApp({
    databasePath: join(app.getPath('userData'), 'data', 'pideck.sqlite'),
    agentDefaultCwd: app.getPath('home'),
    serviceToken,
  });
  builtinServiceToken = serviceToken;

  try {
    await supervisor.server.listen({ host: '127.0.0.1', port: 0 });
    const address = supervisor.server.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('The built-in Supervisor did not report a listening address');
    }
    const addressInfo = address as AddressInfo;
    const server: StoredServer = {
      id: BUILTIN_SERVER_ID,
      name: 'This computer',
      address: `http://127.0.0.1:${addressInfo.port}`,
    };
    builtinSupervisor = supervisor;
    builtinServer = server;
    return server;
  } catch (error) {
    builtinServiceToken = undefined;
    await supervisor.server.close().catch(() => undefined);
    throw error;
  }
}

async function stopBuiltinServer(): Promise<void> {
  const supervisor = builtinSupervisor;
  builtinSupervisor = undefined;
  builtinServer = undefined;
  builtinServiceToken = undefined;
  if (supervisor) await supervisor.server.close();
}

function publicServer(server: StoredServer) {
  return {
    id: server.id,
    name: server.name,
    address: server.address,
    hasToken: Boolean(server.encryptedToken),
    isBuiltin: server.id === BUILTIN_SERVER_ID,
  };
}

async function loadServers(): Promise<void> {
  let configuredServers: StoredServer[] = [];
  try {
    const value: unknown = JSON.parse(await readFile(configPath(), 'utf8'));
    configuredServers = Array.isArray(value) ? value.filter(isStoredServer) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('Failed to read servers', error);
  }
  servers = [
    ...(builtinServer ? [builtinServer] : []),
    ...configuredServers.filter((server) => server.id !== BUILTIN_SERVER_ID),
  ];
}

async function persistServers(): Promise<void> {
  const path = configPath();
  const temporaryPath = `${path}.tmp`;
  const configuredServers = servers.filter((server) => server.id !== BUILTIN_SERVER_ID);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(configuredServers, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function encryptToken(token: string): string | undefined {
  if (!token) return undefined;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this system');
  }
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    throw new Error('Configure a Linux secret store before saving a server access token');
  }
  return safeStorage.encryptString(token).toString('base64');
}

function decryptToken(server: StoredServer): string | undefined {
  if (server.id === BUILTIN_SERVER_ID) return builtinServiceToken;
  if (!server.encryptedToken) return undefined;
  return safeStorage.decryptString(Buffer.from(server.encryptedToken, 'base64'));
}

function authorize(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Unauthorized renderer');
  }
}

function registerIpc(): void {
  ipcMain.handle('servers:list', (event) => {
    authorize(event);
    return servers.map(publicServer);
  });

  ipcMain.handle('servers:save', async (event, value: unknown) => {
    authorize(event);
    const input = parseServerInput(value);
    if (input.id === BUILTIN_SERVER_ID) throw new Error('The built-in server cannot be edited');
    const id = input.id ?? crypto.randomUUID();
    const existing = servers.find((server) => server.id === id);
    const encryptedToken =
      input.token === undefined ? existing?.encryptedToken : encryptToken(input.token.trim());
    const next: StoredServer = {
      id,
      name: input.name.trim(),
      address: normalizeServerOrigin(input.address, Boolean(encryptedToken)),
      encryptedToken,
    };
    servers = [next, ...servers.filter((server) => server.id !== id)];
    await persistServers();
    return publicServer(next);
  });

  ipcMain.handle('servers:remove', async (event, serverId: unknown) => {
    authorize(event);
    if (typeof serverId !== 'string') throw new Error('Invalid server id');
    if (serverId === BUILTIN_SERVER_ID) throw new Error('The built-in server cannot be removed');
    servers = servers.filter((server) => server.id !== serverId);
    await persistServers();
  });

  ipcMain.handle('servers:request', async (event, value: unknown) => {
    authorize(event);
    const request = parseServerRequest(value);
    const server = servers.find((candidate) => candidate.id === request.serverId);
    if (!server) throw new Error('Server is not configured');
    const method = request.method.toUpperCase();
    if (!allowedMethods.has(method)) throw new Error('Unsupported server request method');
    const target = new URL(request.path, server.address);
    if (
      target.origin !== server.address ||
      !/^\/v1\/[A-Za-z0-9_~!$&'()*+,;=:@%./-]*$/.test(target.pathname)
    ) {
      throw new Error('Unsupported server request path');
    }
    if ((request.body?.length ?? 0) > 32 * 1024 * 1024)
      throw new Error('Server request is too large');

    const headers = new Headers();
    for (const name of ['accept', 'content-type', 'idempotency-key']) {
      const value = request.headers?.[name];
      if (value) headers.set(name, value);
    }
    const token = decryptToken(server);
    const validatedOrigin = normalizeServerOrigin(server.address, Boolean(token));
    if (validatedOrigin !== server.address)
      throw new Error('Stored server origin is not canonical');
    if (token) headers.set('authorization', `Bearer ${token}`);
    const response = await net.fetch(target.toString(), {
      method,
      headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#171717',
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
    },
  });
  mainWindow = window;
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  void window.loadFile(resolve(import.meta.dirname, 'renderer/index.html'));
  const smokeNonce = process.env.PIDECK_SMOKE_NONCE;
  if (smokeNonce && /^[A-Za-z0-9_-]{20,128}$/.test(smokeNonce)) {
    window.webContents.once('did-finish-load', async () => {
      const preloadReady = await window.webContents.executeJavaScript(
        "typeof window.piDeckServers?.list === 'function'",
        true,
      );
      const marker = join(app.getPath('userData'), 'pideck-smoke-ready.json');
      await writeFile(
        marker,
        `${JSON.stringify({ nonce: smokeNonce, preloadReady, pid: process.pid })}\n`,
        { mode: 0o600 },
      );
    });
  }
}

function isStoredServer(value: unknown): value is StoredServer {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredServer>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.address === 'string' &&
    (candidate.encryptedToken === undefined || typeof candidate.encryptedToken === 'string')
  );
}

function parseServerInput(value: unknown): ServerInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid server');
  const input = value as Partial<ServerInput>;
  if (
    (input.id !== undefined && typeof input.id !== 'string') ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    typeof input.address !== 'string' ||
    (input.token !== undefined && typeof input.token !== 'string')
  ) {
    throw new Error('Invalid server');
  }
  return input as ServerInput;
}

function parseServerRequest(value: unknown): ServerRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid server request');
  const request = value as Partial<ServerRequest>;
  if (
    typeof request.serverId !== 'string' ||
    typeof request.path !== 'string' ||
    typeof request.method !== 'string' ||
    (request.headers !== undefined &&
      (typeof request.headers !== 'object' ||
        Object.values(request.headers).some((item) => typeof item !== 'string'))) ||
    (request.body !== undefined && typeof request.body !== 'string')
  ) {
    throw new Error('Invalid server request');
  }
  return request as ServerRequest;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const quitArgument = argv.find((argument) => argument.startsWith('--pideck-smoke-quit='));
    const smokeNonce = process.env.PIDECK_SMOKE_NONCE;
    if (smokeNonce && quitArgument === `--pideck-smoke-quit=${smokeNonce}`) {
      app.quit();
      return;
    }
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('before-quit', (event) => {
    if (isQuitting || !builtinSupervisor) return;
    event.preventDefault();
    isQuitting = true;
    void stopBuiltinServer()
      .catch((error: unknown) => console.error('Failed to stop built-in Supervisor', error))
      .finally(() => app.quit());
  });
  void app
    .whenReady()
    .then(async () => {
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      );
      await startBuiltinServer();
      await loadServers();
      registerIpc();
      createWindow();
    })
    .catch((error: unknown) => {
      console.error('Failed to start piDeck', error);
      app.quit();
    });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
