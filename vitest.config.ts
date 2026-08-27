/**
 * Vitest configuration — DEV_PIPELINE.md Phase 0, task 0.3.
 *
 * Three projects with mutually exclusive file patterns, matching the test
 * pyramid in ARCHITECTURE.md §18.1. The split exists now rather than later
 * because retrofitting a fast-unit / slow-integration boundary after a few
 * hundred tests exist is work nobody does.
 *
 *   unit        src/**, scripts/**   pure, no I/O          target < 2s
 *   integration tests/integration/** real Postgres         target < 60s
 *   api         tests/api/**         process / HTTP level  target < 90s
 *
 * `npm run test:integration` passes `--passWithNoTests`. That is the single
 * scoped exception in this repo: the integration project is empty until
 * Phase 2 wires up Testcontainers. `test:unit` and `test:api` do NOT carry the
 * flag — if either stops discovering tests, that is a failure, not a pass.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * PHASE 0 BOOTSTRAP VALUE — raise this as coverage arrives.
 *
 * ARCHITECTURE.md §18.4 sets the real targets: src/domain/** 95%,
 * src/modules/**\/*.service.ts 80%, src/jobs/handlers/** 80%, overall 75%.
 * The gate starts at 0 so CI is honest about an almost-empty repository
 * rather than green because the threshold was never wired up. Phase 1 raises
 * the overall floor and adds the per-directory thresholds.
 */
const PHASE_0_COVERAGE_THRESHOLD = 0;

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'api',
          environment: 'node',
          include: ['tests/api/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'scripts/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'scripts/**/*.test.ts',
        // Entrypoints are exercised end-to-end by tests/api, which spawns them
        // as real processes; in-process coverage instrumentation does not see
        // that, and counting them would misreport the gate in both directions.
        'src/main-api.ts',
        'src/main-worker.ts',
      ],
      thresholds: {
        lines: PHASE_0_COVERAGE_THRESHOLD,
        functions: PHASE_0_COVERAGE_THRESHOLD,
        branches: PHASE_0_COVERAGE_THRESHOLD,
        statements: PHASE_0_COVERAGE_THRESHOLD,
      },
    },
  },
});
