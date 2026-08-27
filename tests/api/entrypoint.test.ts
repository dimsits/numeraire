/**
 * Process-level tests for the API entrypoint.
 *
 * These spawn `src/main-api.ts` as a real OS process rather than importing it,
 * because the behaviour under test — "boots on a valid mock configuration" and
 * "fails loudly and legibly on a missing DATABASE_URL" (DEV_PIPELINE.md Phase 0
 * exit criteria) — is about what the process does at the boundary: what it
 * writes, and what exit code it returns.
 *
 * They live in the `api` project because they exercise the API process
 * end-to-end. From Phase 3 this directory also holds `fastify.inject()`
 * request/response tests, per ARCHITECTURE.md §18.1.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const API_ENTRY = fileURLToPath(new URL('../../src/main-api.ts', import.meta.url));
const WORKER_ENTRY = fileURLToPath(new URL('../../src/main-worker.ts', import.meta.url));

/**
 * A configuration that is valid without any external service or API key:
 * AI_PROVIDER=mock, and PORT=0 so the OS assigns a free port and concurrent
 * runs cannot collide.
 */
const MOCK_CONFIG: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '0',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://postgres:numeraire_dev@localhost:5432/numeraire',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'phase0-test-secret-value-at-least-32-chars',
  AI_PROVIDER: 'mock',
};

/** Environment the child needs regardless of configuration under test. */
function baseEnv(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'COMSPEC',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
  ]) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  return inherited;
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn an entrypoint under tsx.
 *
 * `onReady` is polled against accumulated stdout; once it matches, the child is
 * terminated and the collected output returned. If it never matches, the child
 * is killed at `timeoutMs` and the result is returned anyway so the assertion
 * failure shows the real output.
 */
function run(
  entry: string,
  env: Record<string, string>,
  options: { readyPattern?: RegExp; timeoutMs?: number } = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;

  return new Promise<RunResult>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: REPO_ROOT,
      env: { ...baseEnv(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (options.readyPattern?.test(stdout) === true) {
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('close', finish);
    child.on('error', (error) => {
      stderr += String(error);
      finish(null, null);
    });
  });
}

describe('main-api — invalid configuration', () => {
  it('exits nonzero and names DATABASE_URL when it is missing', async () => {
    const { DATABASE_URL: _omitted, ...withoutDatabaseUrl } = MOCK_CONFIG;
    const result = await run(API_ENTRY, withoutDatabaseUrl);

    expect(result.code).not.toBe(0);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL');
    expect(result.stderr).toContain('Invalid environment configuration');
    expect(result.stderr).toContain('Startup aborted');
  });

  it('never opens a listener when configuration is invalid', async () => {
    const { DATABASE_URL: _omitted, ...withoutDatabaseUrl } = MOCK_CONFIG;
    const result = await run(API_ENTRY, withoutDatabaseUrl);

    expect(result.stdout).not.toContain('Server listening');
    expect(result.stdout).not.toContain('api ready');
  });

  it('reports every problem in one run rather than one per restart', async () => {
    const result = await run(API_ENTRY, {
      ...MOCK_CONFIG,
      DATABASE_URL: '',
      REDIS_URL: '',
      JWT_SECRET: 'too-short',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL');
    expect(result.stderr).toContain('REDIS_URL');
    expect(result.stderr).toContain('JWT_SECRET');
    expect(result.stderr).toContain('3 problems found');
  });

  it('does not echo the offending secret while reporting the failure', async () => {
    const secret = 'this-secret-must-not-appear-in-output';
    const result = await run(API_ENTRY, {
      ...MOCK_CONFIG,
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: secret,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('OPENAI_API_KEY');
    expect(`${result.stderr}${result.stdout}`).not.toContain(secret);
  });
});

describe('main-api — valid mock configuration', () => {
  it('starts and reports itself ready', async () => {
    const result = await run(API_ENTRY, MOCK_CONFIG, { readyPattern: /"msg":"api ready"/ });

    expect(result.stdout).toContain('api ready');
    expect(result.stdout).toContain('Server listening');
    expect(result.stderr).toBe('');
  });

  it('logs structured JSON carrying the process name and a UUIDv7 instance id', async () => {
    const result = await run(API_ENTRY, MOCK_CONFIG, { readyPattern: /"msg":"api ready"/ });

    const ready = result.stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.msg === 'api ready');

    expect(ready).toBeDefined();
    expect(ready!.name).toBe('numeraire-api');
    expect(ready!.aiProvider).toBe('mock');
    expect(String(ready!.instanceId).charAt(14)).toBe('7');
  });

  it('requires no API key when AI_PROVIDER=mock', async () => {
    const result = await run(API_ENTRY, MOCK_CONFIG, { readyPattern: /"msg":"api ready"/ });
    expect(result.stdout).toContain('"aiProvider":"mock"');
  });

  // Node on Windows terminates a child with TerminateProcess; the SIGTERM
  // handler never runs, so the graceful path can only be asserted on POSIX.
  // CI runs on ubuntu-latest, where this assertion is active.
  it.skipIf(process.platform === 'win32')('shuts down gracefully on SIGTERM', async () => {
    const result = await run(API_ENTRY, MOCK_CONFIG, { readyPattern: /"msg":"api ready"/ });
    expect(result.stdout).toContain('shutdown requested');
    expect(result.stdout).toContain('shutdown complete');
  });
});

describe('main-worker', () => {
  it('starts as a separate process on the same configuration (ADR-008)', async () => {
    const result = await run(WORKER_ENTRY, MOCK_CONFIG, { readyPattern: /"msg":"worker ready"/ });

    expect(result.stdout).toContain('worker ready');
    expect(result.stdout).toContain('"name":"numeraire-worker"');
    expect(result.stderr).toBe('');
  });

  it('applies the same environment validation as the API', async () => {
    const { REDIS_URL: _omitted, ...withoutRedisUrl } = MOCK_CONFIG;
    const result = await run(WORKER_ENTRY, withoutRedisUrl);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('REDIS_URL');
  });
});
