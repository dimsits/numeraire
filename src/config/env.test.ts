import { describe, expect, it } from 'vitest';
import { EnvSchema, formatEnvIssues, loadEnvOrExit, parseEnv } from '@/config/env.js';
import type { EnvIssue, EnvSource } from '@/config/env.js';

const VALID_SECRET = 'a'.repeat(32);

/** The minimum set with no defaults — everything else must be optional. */
function minimalEnv(overrides: Record<string, string | undefined> = {}): EnvSource {
  return {
    DATABASE_URL: 'postgres://postgres:pw@localhost:5432/numeraire',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: VALID_SECRET,
    AI_PROVIDER: 'mock',
    ...overrides,
  };
}

function issuesOf(source: EnvSource): EnvIssue[] {
  const result = parseEnv(source);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.error;
}

function variablesOf(source: EnvSource): string[] {
  return issuesOf(source).map((issue) => issue.variable);
}

describe('EnvSchema', () => {
  it('is exported for reuse without going through parseEnv', () => {
    expect(EnvSchema.safeParse(minimalEnv()).success).toBe(true);
  });
});

describe('parseEnv — defaults', () => {
  it('applies every documented default when only required vars are present', () => {
    const result = parseEnv(minimalEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_POOL_MAX: 10,
      ACCESS_TOKEN_TTL: '15m',
      REFRESH_TOKEN_TTL_DAYS: 30,
      AI_CATEGORIZATION_MODEL: 'claude-haiku-4-5-20251001',
      AI_ASSISTANT_MODEL: 'claude-sonnet-4-6',
      AI_DAILY_TOKEN_BUDGET: 200_000,
      AI_CONFIDENCE_THRESHOLD: 0.85,
      AI_MAX_TOOL_ROUNDTRIPS: 5,
      IMPORT_MAX_BYTES: 10_485_760,
      WORKER_CONCURRENCY: 2,
    });
  });

  it('defaults AI_PROVIDER to anthropic when unset — and then demands its key', () => {
    const withoutProvider = minimalEnv({ AI_PROVIDER: undefined });
    expect(variablesOf(withoutProvider)).toContain('ANTHROPIC_API_KEY');
  });
});

describe('parseEnv — coercion', () => {
  it('coerces numeric strings to numbers', () => {
    const result = parseEnv(
      minimalEnv({
        PORT: '8080',
        DATABASE_POOL_MAX: '25',
        REFRESH_TOKEN_TTL_DAYS: '7',
        AI_DAILY_TOKEN_BUDGET: '50000',
        AI_MAX_TOOL_ROUNDTRIPS: '3',
        IMPORT_MAX_BYTES: '1048576',
        WORKER_CONCURRENCY: '4',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.PORT).toBe(8080);
    expect(result.value.DATABASE_POOL_MAX).toBe(25);
    expect(result.value.REFRESH_TOKEN_TTL_DAYS).toBe(7);
    expect(result.value.AI_DAILY_TOKEN_BUDGET).toBe(50_000);
    expect(result.value.AI_MAX_TOOL_ROUNDTRIPS).toBe(3);
    expect(result.value.IMPORT_MAX_BYTES).toBe(1_048_576);
    expect(result.value.WORKER_CONCURRENCY).toBe(4);
  });

  it('coerces a decimal string for the confidence threshold', () => {
    const result = parseEnv(minimalEnv({ AI_CONFIDENCE_THRESHOLD: '0.6' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.AI_CONFIDENCE_THRESHOLD).toBe(0.6);
  });

  it('rejects a non-numeric PORT rather than silently producing NaN', () => {
    expect(variablesOf(minimalEnv({ PORT: 'not-a-port' }))).toContain('PORT');
  });

  it('rejects a fractional PORT — the schema requires an integer', () => {
    expect(variablesOf(minimalEnv({ PORT: '3000.5' }))).toContain('PORT');
  });
});

describe('parseEnv — required variables', () => {
  it.each(['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET'])('reports missing %s', (variable) => {
    expect(variablesOf(minimalEnv({ [variable]: undefined }))).toContain(variable);
  });

  it('reports every missing variable together, not just the first', () => {
    const variables = variablesOf(
      minimalEnv({ DATABASE_URL: undefined, REDIS_URL: undefined, JWT_SECRET: undefined }),
    );
    expect(variables).toEqual(expect.arrayContaining(['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET']));
    expect(variables).toHaveLength(3);
  });
});

describe('parseEnv — URLs', () => {
  it.each([
    ['missing scheme', '//localhost:5432/numeraire'],
    ['bare host', 'localhost'],
    ['empty', ''],
    ['whitespace', '   '],
  ])('rejects DATABASE_URL that is %s', (_label, value) => {
    expect(variablesOf(minimalEnv({ DATABASE_URL: value }))).toContain('DATABASE_URL');
  });

  it('rejects an invalid REDIS_URL', () => {
    expect(variablesOf(minimalEnv({ REDIS_URL: 'redis' }))).toContain('REDIS_URL');
  });

  /**
   * Documents a known limit of the §16 contract rather than papering over it.
   * `z.string().url()` delegates to the WHATWG URL parser, which reads
   * `localhost:5432` as scheme `localhost:` with path `5432` — so it passes
   * validation and fails later at connect time instead. Tightening this to a
   * protocol allow-list would deviate from ARCHITECTURE.md §16, so the schema
   * is left as specified and the gap is recorded here.
   */
  it('accepts host:port, a documented gap in z.string().url()', () => {
    expect(parseEnv(minimalEnv({ DATABASE_URL: 'localhost:5432' })).ok).toBe(true);
  });

  it('accepts both postgres:// and postgresql:// forms', () => {
    for (const url of [
      'postgres://user:pw@host:5432/db',
      'postgresql://user:pw@host:5432/db?sslmode=require',
    ]) {
      expect(parseEnv(minimalEnv({ DATABASE_URL: url })).ok).toBe(true);
    }
  });
});

describe('parseEnv — JWT_SECRET', () => {
  it('rejects a secret shorter than 32 characters', () => {
    expect(variablesOf(minimalEnv({ JWT_SECRET: 'a'.repeat(31) }))).toContain('JWT_SECRET');
  });

  it('accepts exactly 32 characters', () => {
    expect(parseEnv(minimalEnv({ JWT_SECRET: 'a'.repeat(32) })).ok).toBe(true);
  });
});

describe('parseEnv — AI_CONFIDENCE_THRESHOLD', () => {
  it.each([
    ['below range', '-0.1'],
    ['above range', '1.1'],
    ['well above range', '5'],
  ])('rejects a threshold %s', (_label, value) => {
    expect(variablesOf(minimalEnv({ AI_CONFIDENCE_THRESHOLD: value }))).toContain(
      'AI_CONFIDENCE_THRESHOLD',
    );
  });

  it.each(['0', '0.5', '1'])('accepts the boundary value %s', (value) => {
    expect(parseEnv(minimalEnv({ AI_CONFIDENCE_THRESHOLD: value })).ok).toBe(true);
  });
});

describe('parseEnv — conditional provider keys', () => {
  it('requires ANTHROPIC_API_KEY when AI_PROVIDER=anthropic', () => {
    expect(variablesOf(minimalEnv({ AI_PROVIDER: 'anthropic' }))).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('accepts AI_PROVIDER=anthropic with a well-formed key', () => {
    expect(
      parseEnv(minimalEnv({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-abc123' })).ok,
    ).toBe(true);
  });

  it('rejects an Anthropic key with the wrong prefix', () => {
    expect(
      variablesOf(minimalEnv({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'abc123' })),
    ).toContain('ANTHROPIC_API_KEY');
  });

  it('requires OPENAI_API_KEY when AI_PROVIDER=openai', () => {
    expect(variablesOf(minimalEnv({ AI_PROVIDER: 'openai' }))).toEqual(['OPENAI_API_KEY']);
  });

  it('accepts AI_PROVIDER=openai with a well-formed key', () => {
    expect(parseEnv(minimalEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-abc123' })).ok).toBe(
      true,
    );
  });

  it('requires no key at all when AI_PROVIDER=mock', () => {
    const result = parseEnv(minimalEnv({ AI_PROVIDER: 'mock' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.value.OPENAI_API_KEY).toBeUndefined();
    }
  });

  it('rejects an unknown provider', () => {
    expect(variablesOf(minimalEnv({ AI_PROVIDER: 'gemini' }))).toContain('AI_PROVIDER');
  });
});

describe('formatEnvIssues', () => {
  it('names every offending variable and its reason', () => {
    const report = formatEnvIssues(
      issuesOf(minimalEnv({ DATABASE_URL: undefined, JWT_SECRET: 'short' })),
    );
    expect(report).toContain('DATABASE_URL');
    expect(report).toContain('JWT_SECRET');
    expect(report).toContain('Invalid environment configuration');
    expect(report).toContain('2 problems found');
  });

  it('uses the singular form for exactly one problem', () => {
    expect(formatEnvIssues(issuesOf(minimalEnv({ DATABASE_URL: undefined })))).toContain(
      '1 problem found',
    );
  });

  it('never echoes the offending value — a bad DATABASE_URL is still a credential', () => {
    const leaky = 'postgres://admin:hunter2@internal-db.corp:5432/prod';
    const report = formatEnvIssues(issuesOf(minimalEnv({ DATABASE_URL: leaky, PORT: 'x' })));
    expect(report).not.toContain('hunter2');
    expect(report).not.toContain(leaky);
    expect(report).not.toContain('internal-db.corp');
  });

  it('never echoes a short JWT_SECRET', () => {
    const report = formatEnvIssues(issuesOf(minimalEnv({ JWT_SECRET: 'tiny-but-real-secret' })));
    expect(report).not.toContain('tiny-but-real-secret');
  });

  it('never echoes an API key with a bad prefix', () => {
    const report = formatEnvIssues(
      issuesOf(minimalEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'live-key-abc123xyz' })),
    );
    expect(report).not.toContain('live-key-abc123xyz');
  });
});

describe('loadEnvOrExit', () => {
  it('returns the parsed configuration when the environment is valid', () => {
    const env = loadEnvOrExit(minimalEnv(), {
      stderr: sink().stream,
      exit: () => {
        throw new Error('should not exit');
      },
    });
    expect(env.AI_PROVIDER).toBe('mock');
    expect(env.PORT).toBe(3000);
  });

  it('writes the report to stderr and exits with code 1 on failure', () => {
    const stderr = sink();
    let exitCode: number | undefined;

    loadEnvOrExit(minimalEnv({ DATABASE_URL: undefined }), {
      stderr: stderr.stream,
      exit: (code: number): never => {
        exitCode = code;
        return undefined as never;
      },
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain('DATABASE_URL');
    expect(stderr.text()).toContain('Startup aborted');
  });
});

/** Minimal writable stream that accumulates what is written to it. */
function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  let buffer = '';
  const stream = {
    write(chunk: string): boolean {
      buffer += chunk;
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, text: () => buffer };
}
