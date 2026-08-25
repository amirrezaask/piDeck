import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import type { SupervisorApp } from '@pideck/supervisor';

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function contentType(filename: string): string {
  return (
    contentTypes[filename.slice(filename.lastIndexOf('.')).toLowerCase()] ??
    'application/octet-stream'
  );
}

function assetName(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }

  const name = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const normalized = normalize(name).replaceAll('\\', '/');
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return undefined;
  }
  const assetsPrefix = normalized.indexOf('assets/');
  return assetsPrefix > 0 ? normalized.slice(assetsPrefix) : normalized;
}

function filesystemAsset(webRoot: string, name: string): Buffer | undefined {
  const filename = resolve(webRoot, name);
  const root = resolve(webRoot);
  const pathWithinRoot = relative(root, filename).replaceAll('\\', '/');
  if (isAbsolute(pathWithinRoot) || pathWithinRoot === '..' || pathWithinRoot.startsWith('../')) {
    return undefined;
  }
  if (!existsSync(filename)) return undefined;
  return readFileSync(filename);
}

interface EmbeddedAssetRuntime {
  file(path: string): { arrayBuffer(): Promise<ArrayBuffer> };
}

function embeddedAssetPath(name: string): string | undefined {
  const globals = globalThis as typeof globalThis & {
    __PIDECK_EMBEDDED_ASSETS__?: Readonly<Record<string, string>>;
  };
  return globals.__PIDECK_EMBEDDED_ASSETS__?.[name];
}

async function embeddedAsset(name: string): Promise<Buffer | undefined> {
  const path = embeddedAssetPath(name);
  const runtime = (globalThis as typeof globalThis & { Bun?: EmbeddedAssetRuntime }).Bun;
  if (!path || !runtime) return undefined;
  return Buffer.from(await runtime.file(path).arrayBuffer());
}

export function registerWebApp(server: SupervisorApp['server'], webRoot: string): void {
  server.get('/*', async (request, reply) => {
    const name = assetName(request.url.split('?', 1)[0] ?? '/');
    if (!name) return reply.code(400).send({ error: 'invalid_path' });

    const asset = (await embeddedAsset(name)) ?? filesystemAsset(webRoot, name);
    if (asset) return reply.type(contentType(name)).send(asset);

    // Vite's history fallback keeps client-side routes directly navigable.
    const index = (await embeddedAsset('index.html')) ?? filesystemAsset(webRoot, 'index.html');
    if (!index) return reply.code(404).send({ error: 'not_found' });
    return reply.type('text/html; charset=utf-8').send(index);
  });
}
