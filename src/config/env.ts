/**
 * Environment parsing — ARCHITECTURE.md §16.
 *
 * "Fail fast at boot, never at first use." Misconfiguration surfaces as one
 * startup failure listing every problem at once, before any network connection
 * is opened.
 *
 * Three exports, deliberately separated so the contract is testable without a
 * process:
 *
 *   - `EnvSchema`  — the schema itself.
 *   - `parseEnv`   — pure; takes an environment-like object, returns a Result.
 *   - `loadEnvOrExit` — what entrypoints call; reports and exits on failure.
 *
 * Reported failures name the variable and the reason. They never echo a value:
 * a malformed `DATABASE_URL` or a too-short `JWT_SECRET` would otherwise print
 * a live credential into whatever collects stderr.
 */
import { z } from 'zod';
import { err, ok } from '@/lib/result.js';
import type { Result } from '@/lib/result.js';
import { EXIT_CODE_INVALID_CONFIG } from '@/config/constants.js';

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().default(10),
    REDIS_URL: z.string().url(),

    JWT_SECRET: z.string().min(32),
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),

    AI_PROVIDER: z.enum(['anthropic', 'openai', 'mock']).default('anthropic'),
    ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-').optional(),
    OPENAI_API_KEY: z.string().startsWith('sk-').optional(),
    AI_CATEGORIZATION_MODEL: z.string().default('claude-haiku-4-5-20251001'),
    AI_ASSISTANT_MODEL: z.string().default('claude-sonnet-4-6'),
    AI_DAILY_TOKEN_BUDGET: z.coerce.number().int().default(200_000),
    AI_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
    AI_MAX_TOOL_ROUNDTRIPS: z.coerce.number().int().default(5),

    IMPORT_MAX_BYTES: z.coerce.number().int().default(10_485_760),
    WORKER_CONCURRENCY: z.coerce.number().int().default(2),
  })
  .superRefine((env, ctx) => {
    if (env.AI_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'ANTHROPIC_API_KEY required when AI_PROVIDER=anthropic',
      });
    }
    if (env.AI_PROVIDER === 'openai' && env.OPENAI_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY required when AI_PROVIDER=openai',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/** A single validation problem. Carries no value from the environment. */
export interface EnvIssue {
  /** Variable name, or `(root)` for a whole-object refinement. */
  readonly variable: string;
  readonly message: string;
}

/** Environment-like input: exactly what `process.env` looks like. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Validate an environment-like object.
 *
 * Zod collects every issue rather than stopping at the first, so a fresh clone
 * missing four variables learns about all four in one run.
 */
export function parseEnv(source: EnvSource): Result<Env, EnvIssue[]> {
  const parsed = EnvSchema.safeParse(source);
  if (parsed.success) {
    return ok(parsed.data);
  }
  const issues: EnvIssue[] = parsed.error.issues.map((issue) => ({
    variable: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
  return err(issues);
}

/**
 * Render issues as an operator-facing report.
 *
 * Contains variable names and reasons only — never the offending values.
 */
export function formatEnvIssues(issues: readonly EnvIssue[]): string {
  const lines = [
    'Invalid environment configuration. Startup aborted.',
    '',
    ...issues.map((issue) => `  - ${issue.variable}: ${issue.message}`),
    '',
    `${String(issues.length)} problem${issues.length === 1 ? '' : 's'} found.`,
    'See .env.example for the full contract, or docs/ARCHITECTURE.MD §16.',
  ];
  return lines.join('\n');
}

export interface LoadEnvOptions {
  /** Where to write the failure report. Defaults to `process.stderr`. */
  readonly stderr?: NodeJS.WritableStream;
  /** How to terminate on failure. Defaults to `process.exit`. */
  readonly exit?: (code: number) => never;
}

/**
 * Parse the environment or terminate the process.
 *
 * Called by `main-api.ts` and `main-worker.ts` as the first statement, before
 * any socket is opened. The seams exist so the failure path can be asserted in
 * a unit test as well as end-to-end against a spawned process.
 */
export function loadEnvOrExit(source: EnvSource = process.env, options: LoadEnvOptions = {}): Env {
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? ((code: number): never => process.exit(code));

  const result = parseEnv(source);
  if (result.ok) {
    return result.value;
  }

  stderr.write(`${formatEnvIssues(result.error)}\n`);
  return exit(EXIT_CODE_INVALID_CONFIG);
}
