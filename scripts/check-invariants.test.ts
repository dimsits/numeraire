import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PHASE_0_RULES,
  formatScanResult,
  parseCliArgs,
  scanForViolations,
} from './check-invariants.js';
import type { ScanResult } from './check-invariants.js';

/**
 * Each fixture directory is a miniature repository root, so the checker's real
 * rule roots (`src`, `src/domain`) resolve exactly as they do in this repo.
 * The fixtures deliberately contain the banned patterns and are excluded from
 * tsconfig, ESLint, and Prettier so nothing else trips over them.
 */
function fixture(name: string): string {
  return fileURLToPath(new URL(`../tests/fixtures/invariants/${name}`, import.meta.url));
}

function scan(name: string): ScanResult {
  return scanForViolations({ root: fixture(name), rules: PHASE_0_RULES });
}

function ruleIds(result: ScanResult): string[] {
  return [...new Set(result.violations.map((v) => v.ruleId))].sort();
}

describe('PHASE_0_RULES', () => {
  it('covers the four rules named in DEV_PIPELINE.md Phase 0', () => {
    expect(PHASE_0_RULES.map((r) => r.id).sort()).toEqual([
      'console-logging',
      'float-arithmetic-in-domain',
      'unmocked-clock-in-domain',
      'unscoped-repository-access',
    ]);
  });

  it('gives every rule a usable message and a compilable pattern', () => {
    for (const rule of PHASE_0_RULES) {
      expect(rule.message.length).toBeGreaterThan(10);
      expect(rule.roots.length).toBeGreaterThan(0);
      expect(() => new RegExp(rule.pattern, 'g')).not.toThrow();
    }
  });
});

describe('scanForViolations — a clean tree', () => {
  it('finds nothing', () => {
    expect(scan('clean').violations).toEqual([]);
  });

  it('reports the files it actually looked at, so a silent no-op is visible', () => {
    expect(scan('clean').scannedFiles).toBeGreaterThan(0);
  });

  it('does not treat bigint arithmetic or an injected clock as violations', () => {
    expect(ruleIds(scan('clean'))).toEqual([]);
  });
});

describe('scanForViolations — a tree with violations', () => {
  const result = scan('violations');

  it('detects every Phase 0 rule', () => {
    expect(ruleIds(result)).toEqual([
      'console-logging',
      'float-arithmetic-in-domain',
      'unmocked-clock-in-domain',
      'unscoped-repository-access',
    ]);
  });

  it('reports parseFloat, Number.parseFloat and toFixed separately', () => {
    const floats = result.violations.filter((v) => v.ruleId === 'float-arithmetic-in-domain');
    expect(floats).toHaveLength(3);
    expect(floats.map((v) => v.line).sort((a, b) => a - b)).toEqual([3, 7, 15]);
  });

  it('reports a POSIX-separated path, a 1-based line and a 1-based column', () => {
    const clockViolation = result.violations.find((v) => v.ruleId === 'unmocked-clock-in-domain');
    expect(clockViolation).toBeDefined();
    expect(clockViolation!.file).toBe('src/domain/money/bad-money.ts');
    expect(clockViolation!.file).not.toContain('\\');
    expect(clockViolation!.line).toBe(11);
    expect(clockViolation!.column).toBeGreaterThan(0);
    expect(clockViolation!.source).toBe('return new Date();');
  });

  it('catches all three console methods', () => {
    const console = result.violations.filter((v) => v.ruleId === 'console-logging');
    expect(console.map((v) => v.source)).toEqual([
      'console.log(message);',
      'console.error(message);',
      'console.warn(message);',
    ]);
  });

  it('exempts *.test.ts, which legitimately reference the banned constructs', () => {
    expect(result.violations.some((v) => v.file.endsWith('.test.ts'))).toBe(false);
  });

  it('never traverses node_modules, even nested under a scanned root', () => {
    // Assert the bait exists first. .gitignore re-includes this one path
    // explicitly; if that exception is ever lost, this test would otherwise
    // keep passing against a directory that is no longer there.
    const bait = fileURLToPath(
      new URL(
        '../tests/fixtures/invariants/violations/src/skipme/node_modules/pkg/index.ts',
        import.meta.url,
      ),
    );
    expect(existsSync(bait)).toBe(true);
    expect(readFileSync(bait, 'utf8')).toContain('parseFloat');

    expect(result.violations.some((v) => v.file.includes('node_modules'))).toBe(false);
  });

  it('orders violations by file, then line, then column', () => {
    const keys = result.violations.map((v) => `${v.file}:${String(v.line).padStart(4, '0')}`);
    expect([...keys].sort()).toEqual(keys);
  });

  it('scopes domain-only rules to src/domain', () => {
    // src/lib/noisy.ts has console calls (a src-wide rule) but no domain rule
    // should ever fire outside src/domain.
    const outsideDomain = result.violations.filter((v) => !v.file.startsWith('src/domain'));
    expect(outsideDomain.every((v) => v.ruleId !== 'unmocked-clock-in-domain')).toBe(true);
    expect(outsideDomain.every((v) => v.ruleId !== 'float-arithmetic-in-domain')).toBe(true);
  });
});

describe('scanForViolations — missing and empty roots', () => {
  it('skips a root that does not exist instead of failing', () => {
    const result = scan('no-domain');
    expect(result.violations).toEqual([]);
    expect(result.missingRoots).toEqual(['src/domain']);
  });

  it('reports a root as missing only once, however many rules use it', () => {
    expect(scan('no-domain').missingRoots).toHaveLength(1);
  });

  it('handles an existing but empty root', () => {
    const result = scan('empty-src');
    expect(result.violations).toEqual([]);
    expect(result.scannedFiles).toBe(0);
    expect(result.missingRoots).toEqual(['src/domain']);
  });

  it('handles a root where nothing at all exists', () => {
    const result = scan('absent-root');
    expect(result.violations).toEqual([]);
    expect([...result.missingRoots].sort()).toEqual(['src', 'src/domain']);
  });

  it('handles a path that is not a directory at all', () => {
    const result = scanForViolations({
      root: fixture('does-not-exist-anywhere'),
      rules: PHASE_0_RULES,
    });
    expect(result.violations).toEqual([]);
  });
});

describe('formatScanResult', () => {
  it('states cleanliness and the file count when there is nothing to report', () => {
    const output = formatScanResult(scan('clean')).join('\n');
    expect(output).toContain('clean');
    expect(output).toMatch(/\d+ files scanned/);
  });

  it('prints file, line, column, rule id, message and the source line', () => {
    const output = formatScanResult(scan('violations')).join('\n');
    expect(output).toContain('INVARIANT VIOLATION');
    expect(output).toContain('[float-arithmetic-in-domain]');
    expect(output).toContain('src/domain/money/bad-money.ts:3:');
    expect(output).toContain('return parseFloat(minor) / 100;');
    expect(output).toContain('violation(s)');
  });

  it('announces a skipped root so its absence is visible, not silent', () => {
    expect(formatScanResult(scan('no-domain')).join('\n')).toContain('src/domain/ not present');
  });
});

describe('parseCliArgs', () => {
  it('defaults the root to the working directory', () => {
    expect(parseCliArgs([], '/repo')).toEqual({ root: '/repo', quiet: false });
  });

  it('accepts --root', () => {
    expect(parseCliArgs(['--root', '/elsewhere'], '/repo').root).toBe('/elsewhere');
  });

  it('accepts --quiet', () => {
    expect(parseCliArgs(['--quiet'], '/repo').quiet).toBe(true);
  });

  it('rejects --root without a value rather than silently scanning the cwd', () => {
    expect(() => parseCliArgs(['--root'], '/repo')).toThrow(/requires a directory/);
  });

  it('rejects an unknown argument rather than ignoring it', () => {
    expect(() => parseCliArgs(['--deep'], '/repo')).toThrow(/Unknown argument/);
  });
});
