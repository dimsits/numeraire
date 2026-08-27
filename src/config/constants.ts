/**
 * Compile-time constants — values that are part of the design rather than
 * deployment configuration. Anything an operator might reasonably want to
 * change belongs in `env.ts`, not here.
 */

/** Logical service name; appears as `name` on every log line. */
export const SERVICE_NAME = 'numeraire';

/** Process names, used for log correlation and Compose service naming. */
export const PROCESS_API = 'numeraire-api';
export const PROCESS_WORKER = 'numeraire-worker';

/**
 * URL prefix for the versioned HTTP surface (ARCHITECTURE.md §13.1).
 * Routes are registered against it starting in Phase 3.
 */
export const API_VERSION_PREFIX = '/api/v1';

/**
 * How long a process may take to drain in-flight work after SIGTERM before it
 * is killed. Compose sends SIGTERM then SIGKILL after its own grace period, so
 * this stays comfortably below the default 10s Docker allows.
 */
export const SHUTDOWN_GRACE_MS = 8_000;

/**
 * Worker liveness heartbeat interval. In Phase 0 the heartbeat is also what
 * holds the worker's event loop open; Phase 5 replaces that role with BullMQ
 * workers, and the heartbeat becomes purely observational.
 */
export const WORKER_HEARTBEAT_MS = 30_000;

/** Exit code used when configuration is invalid at startup. */
export const EXIT_CODE_INVALID_CONFIG = 1;
