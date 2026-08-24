export interface BusyRetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export function isTransientSqliteError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return (
    typeof code === 'string' &&
    (code === 'SQLITE_BUSY' ||
      code.startsWith('SQLITE_BUSY_') ||
      code === 'SQLITE_LOCKED' ||
      code.startsWith('SQLITE_LOCKED_'))
  );
}

export async function withBusyRetry<T>(
  operation: () => T | Promise<T>,
  options: BusyRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const initialDelayMs = options.initialDelayMs ?? 25;
  const maxDelayMs = options.maxDelayMs ?? 500;

  let delayMs = initialDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientSqliteError(error) || attempt >= maxAttempts) {
        throw error;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}
