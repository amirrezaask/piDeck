import pino, { type Logger, type LoggerOptions } from 'pino';

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino(options);
}
