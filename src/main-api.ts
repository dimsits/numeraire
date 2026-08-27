/**
 * API process entrypoint — ARCHITECTURE.md §3.3, ADR-008.
 *
 * Phase 0 scope: prove the process boots, validates its environment before
 * touching the network, logs through the shared logger, and shuts down
 * cleanly. It registers no routes and opens no database or Redis connection.
 * Transport concerns — plugins, auth, Zod type provider, OpenAPI, the error
 * handler — belong to Phase 3 and are deliberately absent.
 */
import Fastify from 'fastify';
import { loadEnvOrExit } from '@/config/env.js';
import { PROCESS_API, SHUTDOWN_GRACE_MS } from '@/config/constants.js';
import { createLogger } from '@/lib/logger.js';
import { systemClock } from '@/lib/clock.js';
import { newRequestId } from '@/lib/ids.js';
import type { Clock } from '@/lib/clock.js';

// First statement: no listener is bound until the configuration is valid.
const env = loadEnvOrExit();

const clock: Clock = systemClock;
const instanceId = newRequestId();

const logger = createLogger({
  level: env.LOG_LEVEL,
  name: PROCESS_API,
  pretty: env.NODE_ENV === 'development',
}).child({ instanceId });

const app = Fastify({
  loggerInstance: logger,
  trustProxy: true,
  genReqId: () => newRequestId(),
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'shutdown requested');

  // If close() stalls on an in-flight request, do not hang past the grace
  // period Docker allows. unref() so a clean close is not delayed by the timer.
  const forceExit = setTimeout(() => {
    logger.error({ graceMs: SHUTDOWN_GRACE_MS }, 'graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  await app.close();
  clearTimeout(forceExit);
  logger.info('shutdown complete');
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

const startedAt = clock.now();
await app.listen({ port: env.PORT, host: '0.0.0.0' });

logger.info(
  {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    aiProvider: env.AI_PROVIDER,
    startedAt: startedAt.toISOString(),
    bootMs: clock.nowMs() - startedAt.getTime(),
  },
  'api ready',
);
