import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { REDACTED_PATHS, REDACTION_PLACEHOLDER, createLogger } from '@/lib/logger.js';

/** A pino destination that keeps every line it is handed. */
function captureSink(): { sink: Writable; lines: () => Record<string, unknown>[] } {
  const raw: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      raw.push(chunk.toString('utf8'));
      callback();
    },
  });
  return {
    sink,
    lines: () =>
      raw
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function logOnce(payload: Record<string, unknown>): Record<string, unknown> {
  const { sink, lines } = captureSink();
  const logger = createLogger({ level: 'trace', name: 'test' }, sink);
  logger.info(payload, 'probe');
  const [first] = lines();
  expect(first).toBeDefined();
  return first!;
}

const SECRET = 'super-secret-value-that-must-never-be-logged';

describe('createLogger', () => {
  it('emits structured JSON carrying the service name and message', () => {
    const line = logOnce({ module: 'categorization' });
    expect(line.name).toBe('test');
    expect(line.msg).toBe('probe');
    expect(line.module).toBe('categorization');
    expect(line.level).toBe('info');
  });

  it('honours the configured level', () => {
    const { sink, lines } = captureSink();
    const logger = createLogger({ level: 'warn', name: 'test' }, sink);
    logger.debug('suppressed');
    logger.info('suppressed');
    logger.warn('kept');
    expect(lines()).toHaveLength(1);
    expect(lines()[0]?.msg).toBe('kept');
  });

  it('keeps child bindings such as requestId on every line', () => {
    const { sink, lines } = captureSink();
    const logger = createLogger({ level: 'info', name: 'test' }, sink).child({
      requestId: '0192a1b2-c3d4-7e8f-9a0b-1c2d3e4f5a6b',
    });
    logger.info('first');
    logger.info('second');
    expect(lines().every((l) => l.requestId === '0192a1b2-c3d4-7e8f-9a0b-1c2d3e4f5a6b')).toBe(true);
  });
});

describe('redaction', () => {
  it('redacts HTTP credential headers on a request object', () => {
    const line = logOnce({
      req: { headers: { authorization: `Bearer ${SECRET}`, cookie: `session=${SECRET}` } },
    });
    const req = line.req as { headers: Record<string, unknown> };
    expect(req.headers.authorization).toBe(REDACTION_PLACEHOLDER);
    expect(req.headers.cookie).toBe(REDACTION_PLACEHOLDER);
  });

  it('redacts set-cookie on a response object', () => {
    const line = logOnce({ res: { headers: { 'set-cookie': `refresh=${SECRET}` } } });
    const res = line.res as { headers: Record<string, unknown> };
    expect(res.headers['set-cookie']).toBe(REDACTION_PLACEHOLDER);
  });

  it('redacts bare authorization and cookie fields', () => {
    const line = logOnce({ authorization: SECRET, cookie: SECRET });
    expect(line.authorization).toBe(REDACTION_PLACEHOLDER);
    expect(line.cookie).toBe(REDACTION_PLACEHOLDER);
  });

  it.each([
    'password',
    'passwordHash',
    'token',
    'accessToken',
    'refreshToken',
    'apiKey',
    'api_key',
    'secret',
    'clientSecret',
  ])('redacts %s at the top level and one level nested', (field) => {
    const flat = logOnce({ [field]: SECRET });
    expect(flat[field]).toBe(REDACTION_PLACEHOLDER);

    const nested = logOnce({ user: { [field]: SECRET } });
    expect((nested.user as Record<string, unknown>)[field]).toBe(REDACTION_PLACEHOLDER);
  });

  it.each([
    'JWT_SECRET',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'DATABASE_URL',
    'REDIS_URL',
    'POSTGRES_PASSWORD',
  ])('redacts the secret configuration field %s', (field) => {
    const flat = logOnce({ [field]: SECRET });
    expect(flat[field]).toBe(REDACTION_PLACEHOLDER);

    const nested = logOnce({ config: { [field]: SECRET } });
    expect((nested.config as Record<string, unknown>)[field]).toBe(REDACTION_PLACEHOLDER);
  });

  it('leaves no plaintext secret anywhere in the serialized line', () => {
    const { sink, lines } = captureSink();
    const logger = createLogger({ level: 'info', name: 'test' }, sink);
    logger.info(
      {
        authorization: `Bearer ${SECRET}`,
        req: { headers: { cookie: `s=${SECRET}` } },
        res: { headers: { 'set-cookie': `s=${SECRET}` } },
        user: { password: SECRET, apiKey: SECRET },
        JWT_SECRET: SECRET,
        config: { DATABASE_URL: `postgres://user:${SECRET}@db:5432/numeraire` },
      },
      'kitchen sink',
    );
    expect(JSON.stringify(lines())).not.toContain(SECRET);
  });

  it('does not redact ordinary fields', () => {
    const line = logOnce({ userId: 'u-1', merchantCount: 23, tokensUsed: 3204 });
    expect(line.userId).toBe('u-1');
    expect(line.merchantCount).toBe(23);
    expect(line.tokensUsed).toBe(3204);
  });

  it('exposes the redaction path list for review', () => {
    expect(REDACTED_PATHS).toContain('*.headers.authorization');
    expect(REDACTED_PATHS).toContain('*.password');
    expect(REDACTED_PATHS).toContain('JWT_SECRET');
    expect(new Set(REDACTED_PATHS).size).toBe(REDACTED_PATHS.length);
  });
});
