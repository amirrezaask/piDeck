import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Resolve paths entered by the operator, including shell-style `~` paths. */
export function resolveWorkingDirectory(path: string, baseCwd = process.cwd()): string {
  const expanded = path.replace(/^~(?=$|[\\/])/, homedir());
  return resolve(baseCwd, expanded);
}

export class InvalidWorkingDirectoryError extends Error {
  readonly code = 'invalid_working_directory';

  constructor(readonly path: string) {
    super(`Working directory does not exist or is not a directory: ${path}`);
    this.name = 'InvalidWorkingDirectoryError';
  }
}

export async function assertWorkingDirectory(path: string): Promise<void> {
  try {
    if ((await stat(path)).isDirectory()) return;
  } catch {
    // Normalize missing paths and permission failures to the same operator-facing error.
  }
  throw new InvalidWorkingDirectoryError(path);
}
