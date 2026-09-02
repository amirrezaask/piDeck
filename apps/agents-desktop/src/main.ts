import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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
import { parseServerInput, parseServerRequest, prepareServerRequest } from './server-request.js';

interface StoredServer {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly encryptedToken?: string;
}

const BUILTIN_SERVER_ID = 'builtin';
let mainWindow: BrowserWindow | undefined;
let servers: StoredServer[] = [];
let builtinServer: StoredServer | undefined;

function configPath(): string {
  return join(app.getPath('userData'), 'servers.json');
}

function connectUnifiedServer(): StoredServer {
  const server: StoredServer = {
    id: BUILTIN_SERVER_ID,
    name: 'This computer',
    address: process.env.PIDECK_SERVER_URL?.trim() || 'http://127.0.0.1:7774',
  };
  builtinServer = server;
  return server;
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
    const token = decryptToken(server);
    const validatedOrigin = normalizeServerOrigin(server.address, Boolean(token));
    if (validatedOrigin !== server.address)
      throw new Error('Stored server origin is not canonical');
    const prepared = prepareServerRequest(request, validatedOrigin);
    if (token) prepared.headers.set('authorization', `Bearer ${token}`);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Supervisor request timed out', 'TimeoutError')),
      30_000,
    );
    try {
      const response = await net.fetch(prepared.target.toString(), {
        method: prepared.method,
        headers: prepared.headers,
        signal: controller.signal,
        ...(prepared.body === undefined ? {} : { body: prepared.body }),
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      };
    } finally {
      clearTimeout(timeout);
    }
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
  let recoveryAttempts = 0;
  let responsive = true;
  const recover = (reason: string) => {
    if (window.isDestroyed()) return;
    recoveryAttempts += 1;
    console.error(`Renderer failure (${reason}); recovery attempt ${recoveryAttempts}`);
    if (recoveryAttempts <= 2) {
      setTimeout(() => {
        if (!window.isDestroyed()) window.webContents.reloadIgnoringCache();
      }, 500);
      return;
    }
    app.relaunch();
    app.exit(1);
  };
  window.once('ready-to-show', () => window.show());
  window.webContents.on('did-finish-load', () => {
    responsive = true;
    setTimeout(() => {
      recoveryAttempts = 0;
    }, 30_000).unref();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') recover(details.reason);
  });
  window.webContents.on('unresponsive', () => {
    if (!responsive) return;
    responsive = false;
    recover('unresponsive');
  });
  window.webContents.on('responsive', () => {
    responsive = true;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  void window.loadFile(resolve(import.meta.dirname, 'renderer/index.html'));
  const smokeNonce = process.env.PIDECK_SMOKE_NONCE;
  if (smokeNonce && /^[A-Za-z0-9_-]{20,128}$/.test(smokeNonce)) {
    window.webContents.once('did-finish-load', async () => {
      const readiness = (await window.webContents.executeJavaScript(
        `(async () => {
          const preloadReady = typeof window.piDeckServers?.list === 'function';
          const rendererReady = await new Promise((resolveRenderer) => {
            const deadline = Date.now() + 10_000;
            const check = () => {
              if (
                document.querySelector('[aria-label="piDeck agent workspace"]') &&
                document.body.textContent?.includes('Create an agent profile first')
              ) {
                resolveRenderer(true);
              } else if (Date.now() >= deadline) {
                resolveRenderer(false);
              } else {
                setTimeout(check, 50);
              }
            };
            check();
          });
          if (!preloadReady) {
            return {
              preloadReady,
              rendererReady,
              builtinServerReady: false,
              bridgeHealthReady: false,
              requestBoundaryReady: false,
            };
          }
          const servers = await window.piDeckServers.list();
          const builtin = servers.find((server) => server.id === 'builtin' && server.isBuiltin === true);
          if (!builtin) {
            return {
              preloadReady,
              rendererReady,
              builtinServerReady: false,
              bridgeHealthReady: false,
              requestBoundaryReady: false,
            };
          }
          let requestBoundaryReady = false;
          try {
            await window.piDeckServers.request({
              serverId: builtin.id,
              path: 'https://evil.example/agents/v1/health',
              method: 'GET',
            });
          } catch {
            requestBoundaryReady = true;
          }
          const response = await window.piDeckServers.request({
            serverId: builtin.id,
            path: '/agents/v1/health',
            method: 'GET',
            headers: { accept: 'application/json' },
          });
          const health = JSON.parse(response.body);
          return {
            preloadReady,
            rendererReady,
            builtinServerReady: true,
            bridgeHealthReady:
              response.status === 200 && health.status === 'ok' && health.service === 'supervisor',
            requestBoundaryReady,
          };
        })()`,
        true,
      )) as {
        preloadReady: boolean;
        rendererReady: boolean;
        builtinServerReady: boolean;
        bridgeHealthReady: boolean;
        requestBoundaryReady: boolean;
      };
      const marker = join(app.getPath('userData'), 'pideck-smoke-ready.json');
      await writeFile(
        marker,
        `${JSON.stringify({ nonce: smokeNonce, ...readiness, pid: process.pid })}\n`,
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
  void app
    .whenReady()
    .then(async () => {
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        if (!details.url.startsWith('file:')) {
          callback({ responseHeaders: details.responseHeaders });
          return;
        }
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            ],
          },
        });
      });
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      );
      connectUnifiedServer();
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
