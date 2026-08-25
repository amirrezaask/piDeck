import { readFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';

import type { ResolvedPaths, ResolvedResource } from '@earendil-works/pi-coding-agent';
import type {
  AgentExtensionStatus,
  ManagedAgentExtension,
  ManagedAgentExtensionsResponse,
} from '@nextflow/contracts';
import { resolveWorkingDirectory } from './working-directory.js';

export interface PiExtensionPackageUpdate {
  readonly source: string;
}

export interface PiExtensionPackageManager {
  resolve(): Promise<ResolvedPaths>;
  checkForAvailableUpdates(): Promise<PiExtensionPackageUpdate[]>;
  listConfiguredPackages(): Array<{ source: string }>;
  update(source?: string): Promise<void>;
}

interface ExtensionPackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly description?: unknown;
}

export interface PiExtensionCatalog {
  list(): Promise<ManagedAgentExtensionsResponse>;
  update(source?: string): Promise<ManagedAgentExtensionsResponse>;
}

export interface PiExtensionServiceOptions {
  readonly cwd: string;
  readonly agentDir?: string;
  readonly packageManager?: PiExtensionPackageManager;
  readonly now?: () => string;
}

export class PiExtensionNotConfiguredError extends Error {
  readonly code = 'extension_not_configured';

  constructor(readonly source: string) {
    super(`Pi extension package ${source} is not configured`);
    this.name = 'PiExtensionNotConfiguredError';
  }
}

/**
 * Reads the same extension resources Pi resolves for a session and delegates
 * package update checks/updates to Pi's package manager. It deliberately does
 * not import extension modules: listing settings must never execute extension
 * code or start extension-owned resources.
 */
export class PiExtensionService implements PiExtensionCatalog {
  private readonly cwd: string;
  private readonly packageManager: Promise<PiExtensionPackageManager>;
  private readonly now: () => string;
  private updateTail: Promise<void> = Promise.resolve();

  constructor(options: PiExtensionServiceOptions) {
    this.cwd = resolveWorkingDirectory(options.cwd);
    this.now = options.now ?? (() => new Date().toISOString());
    this.packageManager = options.packageManager
      ? Promise.resolve(options.packageManager)
      : createPackageManager(this.cwd, options.agentDir);
  }

  async list(): Promise<ManagedAgentExtensionsResponse> {
    const packageManager = await this.packageManager;
    const resolved = await packageManager.resolve();
    let updateSources = new Set<string>();
    let updateCheckError: string | null = null;

    try {
      const updates = await packageManager.checkForAvailableUpdates();
      updateSources = new Set(updates.map((update) => update.source));
    } catch (error) {
      updateCheckError = errorMessage(error);
    }

    const extensions = await Promise.all(
      resolved.extensions.map((resource) =>
        this.describeExtension(resource, updateSources, updateCheckError),
      ),
    );

    return {
      extensions: extensions.sort(compareExtensions),
      cwd: this.cwd,
      checkedAt: this.now(),
      updateCheckError,
    };
  }

  async update(source?: string): Promise<ManagedAgentExtensionsResponse> {
    if (source !== undefined) {
      const packageManager = await this.packageManager;
      const configured = packageManager
        .listConfiguredPackages()
        .some((candidate) => candidate.source === source);
      if (!configured) throw new PiExtensionNotConfiguredError(source);
    }

    const operation = this.updateTail.then(async () => {
      const packageManager = await this.packageManager;
      await packageManager.update(source);
    });
    this.updateTail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
    return this.list();
  }

  private async describeExtension(
    resource: ResolvedResource,
    updateSources: ReadonlySet<string>,
    updateCheckError: string | null,
  ): Promise<ManagedAgentExtension> {
    const { path, metadata } = resource;
    const isPackage = metadata.origin === 'package';
    const packageManifest = isPackage ? await readPackageManifest(metadata.baseDir) : undefined;
    const packageName = stringValue(packageManifest?.name, 512);
    const version = stringValue(packageManifest?.version, 256);
    const relativePath = extensionRelativePath(path, metadata.baseDir);
    const source = metadata.source;

    return {
      id: `${source}:${path}`,
      name: packageName ?? localExtensionName(path),
      description:
        stringValue(packageManifest?.description, 4_096) ??
        (isPackage ? `Pi extension · ${relativePath}` : 'Local Pi extension'),
      path,
      relativePath,
      source,
      packageName: packageName ?? null,
      scope: metadata.scope,
      origin: metadata.origin,
      enabled: resource.enabled,
      version: version ?? null,
      status: extensionStatus({
        enabled: resource.enabled,
        isPackage,
        hasVersion: version !== undefined,
        updateAvailable: updateSources.has(source),
        updateCheckError,
      }),
    };
  }
}

async function createPackageManager(
  cwd: string,
  configuredAgentDir: string | undefined,
): Promise<PiExtensionPackageManager> {
  const pi = await import('@earendil-works/pi-coding-agent');
  const agentDir = configuredAgentDir ?? pi.getAgentDir();
  const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  return new pi.DefaultPackageManager({ cwd, agentDir, settingsManager });
}

async function readPackageManifest(baseDir: string | undefined): Promise<ExtensionPackageManifest> {
  if (!baseDir) return {};
  try {
    const raw = await readFile(join(baseDir, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as ExtensionPackageManifest;
  } catch {
    return {};
  }
}

function extensionRelativePath(path: string, baseDir: string | undefined): string {
  if (!baseDir) return basename(path);
  const relativePath = relative(resolve(baseDir), resolve(path));
  return relativePath && !relativePath.startsWith('..') ? relativePath : basename(path);
}

function localExtensionName(path: string): string {
  const filename = basename(path);
  const extension = extname(filename);
  return extension ? filename.slice(0, -extension.length) : filename;
}

function extensionStatus(input: {
  enabled: boolean;
  isPackage: boolean;
  hasVersion: boolean;
  updateAvailable: boolean;
  updateCheckError: string | null;
}): AgentExtensionStatus {
  if (!input.enabled) return 'disabled';
  if (!input.isPackage) return 'local';
  if (input.updateCheckError || !input.hasVersion) return 'unknown';
  return input.updateAvailable ? 'update_available' : 'up_to_date';
}

function compareExtensions(left: ManagedAgentExtension, right: ManagedAgentExtension): number {
  return left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
}

function stringValue(value: unknown, maxLength = 4_096): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 4_096);
  return 'Pi could not check extension updates';
}
