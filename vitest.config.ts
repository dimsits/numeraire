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
 * ARCHITECTURE.md §18.4 sets the real targets: src/domain/** 95%,
 * src/modules/**\/*.service.ts 80%, src/jobs/handlers/** 80%, overall 75%.
 *
 * Phase 1 wires up the first of those. `src/domain/**` is finished and fully
 * tested, so it carries its real 95% gate below. The *overall* floor stays at
 * the Phase 0 bootstrap value of 0 because the outer layers do not exist yet —
 * raising it now would gate the build on code nobody has written. Each later
 * phase raises this as its layer lands, ending at the §18.4 floor of 75.
 *
 * This is not a weakened threshold: files matched by a glob below are removed
 * from the global group, so the 0 applies to strictly fewer files than it did
 * in Phase 0, and src/domain gained a hard gate it did not have.
 */
const OVERALL_COVERAGE_THRESHOLD = 0;

/** §18.4: the domain layer is pure, cheap to cover, and highest consequence. */
const DOMAIN_COVERAGE_THRESHOLD = 95;

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
  // Test-only helpers (tests/helpers/**). Kept outside src/ deliberately: it
  // keeps them out of coverage, out of dependency-cruiser's graph, and out of
  // check-invariants, none of which should be reasoning about test scaffolding.
  '@tests': fileURLToPath(new URL('./tests', import.meta.url)),
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
        lines: OVERALL_COVERAGE_THRESHOLD,
        functions: OVERALL_COVERAGE_THRESHOLD,
        branches: OVERALL_COVERAGE_THRESHOLD,
        statements: OVERALL_COVERAGE_THRESHOLD,
        'src/domain/**': {
          lines: DOMAIN_COVERAGE_THRESHOLD,
          functions: DOMAIN_COVERAGE_THRESHOLD,
          branches: DOMAIN_COVERAGE_THRESHOLD,
          statements: DOMAIN_COVERAGE_THRESHOLD,
        },
      },
    },
  },
});
