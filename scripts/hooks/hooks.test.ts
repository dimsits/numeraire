import { describe, expect, it } from 'vitest';
import { decide, isMigrationPath, toRepoRelative } from './guard-migrations.mjs';
import { shouldTypecheck } from './typecheck-on-edit.mjs';
import { isDomainSource } from './invariants-on-domain-edit.mjs';
import { buildWarning } from './stop-dirty-tree.mjs';

/**
 * These cover the decision functions, which is where every branch of the hook
 * logic lives. The PreToolUse guard's end-to-end behaviour — Claude Code
 * actually refusing an edit — is proven separately by firing the real hook
 * against a committed migration; a green test here is not a claim that the
 * hook is wired up.
 */

const COMMITTED = new Set(['drizzle/0000_initial_schema.sql', 'drizzle/0001_add_rollups.sql']);
const existsInHead = (path: string): boolean => COMMITTED.has(path);

describe('guard-migrations — isMigrationPath', () => {
  it.each(['drizzle/0000_initial_schema.sql', 'drizzle/0001_add_rollups.sql'])(
    'recognises %s',
    (path) => {
      expect(isMigrationPath(path)).toBe(true);
    },
  );

  it.each([
    ['journal metadata', 'drizzle/meta/_journal.json'],
    ['a snapshot', 'drizzle/meta/0000_snapshot.json'],
    ['a nested sql file', 'drizzle/archive/0000_old.sql'],
    ['sql elsewhere in the repo', 'scripts/seed.sql'],
    ['the drizzle readme', 'drizzle/README.md'],
    ['source', 'src/db/schema/users.ts'],
  ])('does not treat %s as a migration', (_label, path) => {
    expect(isMigrationPath(path)).toBe(false);
  });
});

describe('guard-migrations — toRepoRelative', () => {
  const root = 'C:/repo/numeraire';

  it('passes through an already-relative POSIX path', () => {
    expect(toRepoRelative('drizzle/0000_initial_schema.sql', root)).toBe(
      'drizzle/0000_initial_schema.sql',
    );
  });

  it('normalises a Windows absolute path', () => {
    expect(
      toRepoRelative(
        'C:\\repo\\numeraire\\drizzle\\0000_initial_schema.sql',
        'C:\\repo\\numeraire',
      ),
    ).toBe('drizzle/0000_initial_schema.sql');
  });

  it('strips a leading ./', () => {
    expect(toRepoRelative('./drizzle/0000_initial_schema.sql', root)).toBe(
      'drizzle/0000_initial_schema.sql',
    );
  });

  it('returns null for a path outside the repository', () => {
    expect(toRepoRelative('C:\\elsewhere\\evil.sql', 'C:\\repo\\numeraire')).toBeNull();
  });

  it('returns null for an empty path', () => {
    expect(toRepoRelative('', root)).toBeNull();
  });
});

describe('guard-migrations — decide', () => {
  it('BLOCKS an edit to a migration that exists in HEAD', () => {
    const decision = decide({
      toolName: 'Edit',
      filePath: 'drizzle/0000_initial_schema.sql',
      existsInHead,
    });
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toContain('drizzle/0000_initial_schema.sql');
    expect(decision.reason).toContain('immutable');
    expect(decision.reason).toContain('drizzle-kit generate');
  });

  it('BLOCKS a Write to a migration that exists in HEAD, not only an Edit', () => {
    expect(
      decide({ toolName: 'Write', filePath: 'drizzle/0001_add_rollups.sql', existsInHead }).blocked,
    ).toBe(true);
  });

  it('ALLOWS a new migration that is not yet committed', () => {
    expect(
      decide({ toolName: 'Write', filePath: 'drizzle/0002_add_budgets.sql', existsInHead }).blocked,
    ).toBe(false);
  });

  it('ALLOWS editing the journal, which drizzle-kit rewrites on every generate', () => {
    expect(
      decide({ toolName: 'Edit', filePath: 'drizzle/meta/_journal.json', existsInHead }).blocked,
    ).toBe(false);
  });

  it('ALLOWS ordinary source edits', () => {
    expect(
      decide({ toolName: 'Edit', filePath: 'src/db/schema/users.ts', existsInHead }).blocked,
    ).toBe(false);
  });

  it('ALLOWS non-editing tools, so reads of a migration are never blocked', () => {
    for (const toolName of ['Read', 'Bash', 'Grep', 'Glob']) {
      expect(
        decide({ toolName, filePath: 'drizzle/0000_initial_schema.sql', existsInHead }).blocked,
      ).toBe(false);
    }
  });

  it('ALLOWS when the path could not be resolved into the repository', () => {
    expect(decide({ toolName: 'Edit', filePath: '', existsInHead }).blocked).toBe(false);
  });

  it('gives no reason text when it allows', () => {
    expect(decide({ toolName: 'Edit', filePath: 'src/main-api.ts', existsInHead }).reason).toBe('');
  });
});

describe('typecheck-on-edit — shouldTypecheck', () => {
  it.each([
    'src/main-api.ts',
    'src/config/env.ts',
    'tests/api/entrypoint.test.ts',
    'scripts/check-invariants.ts',
    'vitest.config.ts',
  ])('runs for %s', (path) => {
    expect(shouldTypecheck(path)).toBe(true);
  });

  it.each([
    ['markdown', 'CLAUDE.md'],
    ['json', 'package.json'],
    ['sql', 'drizzle/0000_initial_schema.sql'],
    ['a fixture, excluded from tsconfig', 'tests/fixtures/invariants/violations/src/x.ts'],
    ['compiled output', 'dist/main-api.js'],
  ])('skips %s', (_label, path) => {
    expect(shouldTypecheck(path)).toBe(false);
  });
});

describe('invariants-on-domain-edit — isDomainSource', () => {
  it.each(['src/domain/money/money.ts', 'src/domain/errors.ts'])('runs for %s', (path) => {
    expect(isDomainSource(path)).toBe(true);
  });

  it.each([
    ['a domain test file, which is exempt from the rules', 'src/domain/money/money.test.ts'],
    ['code outside the domain', 'src/lib/clock.ts'],
    ['a non-TypeScript file in the domain', 'src/domain/README.md'],
  ])('skips %s', (_label, path) => {
    expect(isDomainSource(path)).toBe(false);
  });
});

describe('stop-dirty-tree — buildWarning', () => {
  it('warns when the tree is dirty and the suite is red', () => {
    const warning = buildWarning({ dirty: true, unitSuiteGreen: false, changedFiles: 7 });
    expect(warning).toContain('7 uncommitted file(s)');
    expect(warning).toContain('RED');
  });

  it('stays quiet on a clean tree, even with a red suite', () => {
    expect(buildWarning({ dirty: false, unitSuiteGreen: false, changedFiles: 0 })).toBeNull();
  });

  it('stays quiet when the suite is green, however dirty the tree', () => {
    expect(buildWarning({ dirty: true, unitSuiteGreen: true, changedFiles: 40 })).toBeNull();
  });
});
