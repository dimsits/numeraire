/**
 * Structured logging — ARCHITECTURE.md §17.1.
 *
 * Pino, JSON by default, with request-scoped child loggers created at the
 * transport boundary in Phase 3. CLAUDE.md forbids `console.*` anywhere in
 * `src/`; `scripts/check-invariants.ts` enforces it.
 *
 * Redaction is defined here rather than at each call site because a secret
 * leaks the moment one call site forgets. Anything matching `REDACTED_PATHS`
 * is replaced with `[Redacted]` before serialization.
 */
import { pino } from 'pino';
import type { DestinationStream, Level, Logger, LoggerOptions } from 'pino';

export type LogLevel = Level;

export const REDACTION_PLACEHOLDER = '[Redacted]';

/**
 * Paths whose values must never reach a log sink.
 *
 * Three groups, each with a bare and a one-level-nested form because objects
 * are logged both flat (`log.info({ password })`) and wrapped
 * (`log.info({ user: { password } })`):
 *
 *   1. HTTP credential headers, at `req`/`res` depth and bare.
 *   2. Generic credential field names.
 *   3. The specific secret-bearing configuration keys from ARCHITECTURE.md §16.
 */
export const REDACTED_PATHS: readonly string[] = [
  // 1. HTTP headers
  'authorization',
  'cookie',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  '*.headers.authorization',
  '*.headers.cookie',
  '*.headers["set-cookie"]',
  'set-cookie',

  // 2. Credential-shaped fields
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'api_key',
  'secret',
  'clientSecret',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.api_key',
  '*.secret',
  '*.clientSecret',

  // 3. Secret-bearing configuration keys (ARCHITECTURE.md §16)
  'JWT_SECRET',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DATABASE_URL',
  'REDIS_URL',
  'POSTGRES_PASSWORD',
  '*.JWT_SECRET',
  '*.ANTHROPIC_API_KEY',
  '*.OPENAI_API_KEY',
  '*.DATABASE_URL',
  '*.REDIS_URL',
  '*.POSTGRES_PASSWORD',
];

export interface CreateLoggerOptions {
  /** Minimum level to emit. Comes from `LOG_LEVEL`. */
  level: LogLevel;
  /** Service or process name, attached to every line as `name`. */
  name: string;
  /**
   * Human-readable output via pino-pretty. Development only, and ignored when
   * an explicit `destination` is supplied.
   */
  pretty?: boolean;
}

/**
 * Build the root logger.
 *
 * `destination` exists so tests can capture output in memory; production and
 * development call sites omit it and get stdout.
 */
export function createLogger(
  options: CreateLoggerOptions,
  destination?: DestinationStream,
): Logger {
  const base: LoggerOptions = {
    level: options.level,
    name: options.name,
    redact: {
      paths: [...REDACTED_PATHS],
      censor: REDACTION_PLACEHOLDER,
    },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  };

  if (destination !== undefined) {
    return pino(base, destination);
  }

  if (options.pretty === true) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(base);
}
