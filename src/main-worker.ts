/**
 * Worker process entrypoint — ARCHITECTURE.md §3.3, ADR-008.
 *
 * Phase 0 scope: the same environment validation, logging, and shutdown
 * contract as the API, in a separate OS process. It registers no queues and
 * consumes no jobs — BullMQ arrives in Phase 5.
 *
 * The heartbeat interval is what currently holds the event loop open. That is
 * a real liveness signal rather than a placeholder, and when Phase 5 adds
 * BullMQ workers they become the thing keeping the process alive; the
 * heartbeat then only reports.
 */
import { loadEnvOrExit } from '@/config/env.js';
import { PROCESS_WORKER, SHUTDOWN_GRACE_MS, WORKER_HEARTBEAT_MS } from '@/config/constants.js';
import { createLogger } from '@/lib/logger.js';
import { systemClock } from '@/lib/clock.js';
import { newRequestId } from '@/lib/ids.js';
import type { Clock } from '@/lib/clock.js';

const env = loadEnvOrExit();

const clock: Clock = systemClock;
const instanceId = newRequestId();

const logger = createLogger({
  level: env.LOG_LEVEL,
  name: PROCESS_WORKER,
  pretty: env.NODE_ENV === 'development',
}).child({ instanceId });

const startedAt = clock.now();

const heartbeat = setInterval(() => {
  logger.debug({ uptimeMs: clock.nowMs() - startedAt.getTime() }, 'worker heartbeat');
}, WORKER_HEARTBEAT_MS);

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'shutdown requested');

  const forceExit = setTimeout(() => {
    logger.error({ graceMs: SHUTDOWN_GRACE_MS }, 'graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  clearInterval(heartbeat);
  clearTimeout(forceExit);
  logger.info('shutdown complete');
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    shutdown(signal);
  });
}

logger.info(
  {
    nodeEnv: env.NODE_ENV,
    concurrency: env.WORKER_CONCURRENCY,
    aiProvider: env.AI_PROVIDER,
    startedAt: startedAt.toISOString(),
  },
  'worker ready',
);
