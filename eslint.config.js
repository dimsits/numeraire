// ESLint flat config — DEV_PIPELINE.md task 0.2.
//
// The `no-restricted-syntax` block is the lint-level half of the money
// invariant (§13.2 items 5 and 8). `scripts/check-invariants.ts` is the
// grep-level backstop for the same rules, and dependency-cruiser handles
// layer boundaries. Three overlapping mechanisms is deliberate: each catches
// what the others structurally cannot.
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/** Float arithmetic on money, banned everywhere. */
const noFloatMoney = [
  {
    selector: "CallExpression > MemberExpression[property.name='toFixed']",
    message:
      'toFixed() is float formatting. Money is bigint minor units — use formatMinor() from src/domain/money.',
  },
  {
    selector: "CallExpression > Identifier[name='parseFloat']",
    message:
      'parseFloat produces a float. Money is bigint minor units — use parseMinor() from src/domain/money.',
  },
  {
    selector: "CallExpression > MemberExpression[object.name='Number'][property.name='parseFloat']",
    message:
      'Number.parseFloat produces a float. Money is bigint minor units — use parseMinor() from src/domain/money.',
  },
];

/** Identifiers must come from src/lib/ids.ts (CLAUDE.md conventions). */
const noInlineUuid = {
  selector: "CallExpression > MemberExpression[property.name='randomUUID']",
  message: 'IDs come from src/lib/ids.ts (UUIDv7), never crypto.randomUUID() inline.',
};

export default defineConfig([
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'drizzle/**',
      // Deliberately contain the patterns the invariant checker looks for.
      'tests/fixtures/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // CLAUDE.md: log via the logger, never console.
      'no-console': 'error',

      // §13.2 item 5 — no escape hatches on an invariant path.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],

      // Async correctness: a dropped promise in a job handler loses work.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',

      // Errors are AppError subclasses (CLAUDE.md) — never a bare string.
      'no-throw-literal': 'off',
      '@typescript-eslint/only-throw-error': 'error',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      'no-restricted-syntax': ['error', ...noFloatMoney, noInlineUuid],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // src/domain/** is pure: no framework imports, no I/O, no ambient time.
  // (Layer imports are enforced structurally by .dependency-cruiser.js.)
  {
    files: ['src/domain/**/*.ts'],
    ignores: ['src/domain/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...noFloatMoney,
        noInlineUuid,
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Domain code must not read ambient time. Take a Clock (src/lib/clock.ts) as a parameter.',
        },
      ],
    },
  },

  // src/lib/logger.ts is the one place allowed to construct log output.
  {
    files: ['src/lib/logger.ts'],
    rules: { 'no-console': 'off' },
  },

  // Build and hook scripts run outside the app: they own a process, so they
  // report to the terminal directly rather than through the app logger.
  {
    files: ['scripts/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },

  // Tests assert on things the strict type rules discourage in app code.
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },

  // Must be last: turns off every rule Prettier already decides.
  prettier,
]);
