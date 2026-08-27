/**
 * dependency-cruiser — DEV_PIPELINE.md Phase 0, task 0.4.
 *
 * Structural enforcement of ARCHITECTURE.md §3.2: dependencies point inward
 * only, and `src/domain` is pure. CLAUDE.md states the same rule in prose;
 * this file is what makes it fail a build.
 *
 * ESM (`export default`) because package.json declares `"type": "module"`.
 */

/** Outer layers the domain must never reach. */
const OUTER_LAYERS = '^src/(db|modules|ai|jobs|parsers|plugins|config)';

/** Node core modules that perform, or exist to perform, I/O. */
const CORE_IO_MODULES =
  '^(node:)?(fs|fs/promises|net|http|http2|https|dns|tls|dgram|child_process|cluster|' +
  'worker_threads|inspector|repl|readline|v8|vm|zlib|stream|process|os|perf_hooks|' +
  'async_hooks|timers|timers/promises|crypto|module)$';

export default {
  forbidden: [
    // ── The domain purity rules (ARCHITECTURE.md §3.2, CLAUDE.md) ──────────
    {
      name: 'domain-no-outer-layers',
      comment:
        'src/domain is the innermost layer. It defines interfaces that outer layers ' +
        'implement; it never imports them. See ARCHITECTURE.md §3.2.',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { path: OUTER_LAYERS },
    },
    {
      name: 'domain-no-npm',
      comment:
        'src/domain is dependency-free so the ledger logic is unit-testable without a ' +
        'database, framework, or network. No npm package, not even a "harmless" one.',
      severity: 'error',
      from: { path: '^src/domain' },
      to: {
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-optional',
          'npm-peer',
          'npm-bundled',
          'npm-no-pkg',
          'npm-unknown',
        ],
      },
    },
    {
      name: 'domain-no-reachable-npm',
      comment:
        'Transitive backstop for domain-no-npm: importing a local module that itself ' +
        'pulls in Fastify, Drizzle, or pino would smuggle I/O into the domain.',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { path: 'node_modules', reachable: true },
    },
    {
      name: 'domain-no-core-io',
      comment:
        'No filesystem, network, process, or crypto access from the domain. Time comes ' +
        'from an injected Clock and IDs from src/lib/ids.ts, at the layer boundary.',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { dependencyTypes: ['core'], path: CORE_IO_MODULES },
    },

    // ── Inward-pointing dependencies elsewhere ────────────────────────────
    {
      name: 'lib-no-outer-layers',
      comment:
        'src/lib holds cross-cutting infrastructure primitives. It is imported by outer ' +
        'layers and must not import them back.',
      severity: 'error',
      from: { path: '^src/lib' },
      to: { path: '^src/(db|modules|ai|jobs|parsers|plugins)' },
    },
    {
      name: 'config-no-outer-layers',
      comment: 'Configuration is read at composition roots; it must not depend on features.',
      severity: 'error',
      from: { path: '^src/config' },
      to: { path: '^src/(db|domain|modules|ai|jobs|parsers|plugins)' },
    },

    // ── General hygiene ───────────────────────────────────────────────────
    {
      name: 'no-circular',
      comment: 'A cycle makes load order significant and defeats layered reasoning.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment:
        'Dead code from an abandoned approach (DEV_PIPELINE.md §1.4 check 5). Process ' +
        'and CLI entrypoints are orphans by definition and are exempted by name.',
      severity: 'error',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$',
          '\\.d\\.ts$',
          '^src/main-(api|worker)\\.ts$',
          '^scripts/',
        ],
      },
      to: {},
    },
    {
      name: 'not-to-dev-dep',
      comment:
        'A devDependency reached from src would be missing in the production image, ' +
        'which installs with --omit=dev.',
      severity: 'error',
      from: { path: '^src', pathNot: '\\.test\\.ts$' },
      to: {
        dependencyTypes: ['npm-dev'],
        dependencyTypesNot: ['type-only'],
        pathNot: ['node_modules/@types/'],
      },
    },
    {
      name: 'no-non-package-json',
      comment: 'An import that is not declared in package.json will not survive npm ci.',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'no-deprecated-core',
      comment: 'Deprecated Node core modules are removed without a major-version warning.',
      severity: 'error',
      from: {},
      to: {
        dependencyTypes: ['core'],
        path: '^(punycode|domain|constants|sys|_linklist|_stream_wrap)$',
      },
    },
    {
      name: 'no-duplicate-dep-types',
      comment: 'A package declared in two dependency sections resolves ambiguously.',
      severity: 'error',
      from: {},
      to: { moreThanOneDependencyType: true, dependencyTypesNot: ['type-only'] },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },

    /* Test files legitimately import fixtures and dev-only tooling; the rules
       above describe production module structure. Fixtures are excluded
       because they contain deliberate violations. */
    exclude: { path: '\\.test\\.ts$|^tests/fixtures/' },

    /* Resolves the `@/*` path alias from tsconfig.json. */
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,

    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json'],
    },

    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
