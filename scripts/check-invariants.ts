/**
 * Invariant checker — DEV_PIPELINE.md Phase 0, task 0.4.
 *
 * A grep-level backstop for the things the type system cannot express. It is
 * the third of three overlapping mechanisms: ESLint catches syntax patterns
 * inside a parsed file, dependency-cruiser catches structural imports, and
 * this catches textual patterns anywhere under a root regardless of how the
 * code is written.
 *
 * DEV_PIPELINE.md sketches this as `scripts/check-invariants.sh`. That script
 * is retained as a wrapper for the deliverable contract, but this TypeScript
 * implementation is the source of truth: development happens on Windows, and a
 * `grep -rE` pipeline is not portable. npm scripts and Claude Code hooks call
 * this file directly.
 *
 * Usage:
 *   tsx scripts/check-invariants.ts [--root <dir>] [--quiet]
 *
 * Exit code 0 when clean, 1 when any violation is found.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface InvariantRule {
  /** Stable identifier, printed with every violation. */
  readonly id: string;
  /** Regular expression source, applied per line. */
  readonly pattern: string;
  /** Roots to scan, relative to the repository root. */
  readonly roots: readonly string[];
  /** What the violation means and what to do instead. */
  readonly message: string;
}

/**
 * The Phase 0 rule set, transcribed from DEV_PIPELINE.md Phase 0.
 * Later phases add rules here; none of these may be removed to make a build
 * pass (DEV_PIPELINE.md §13.2 item 4).
 */
export const PHASE_0_RULES: readonly InvariantRule[] = [
  {
    id: 'float-arithmetic-in-domain',
    pattern: String.raw`parseFloat|Number\.parseFloat|\.toFixed\(`,
    roots: ['src/domain'],
    message: 'float arithmetic in domain — money is bigint minor units (ARCHITECTURE.MD §6.4)',
  },
  {
    id: 'unmocked-clock-in-domain',
    pattern: String.raw`new Date\(\)`,
    roots: ['src/domain'],
    message: 'unmocked clock in domain — take a Clock from src/lib/clock.ts',
  },
  {
    id: 'unscoped-repository-access',
    pattern: String.raw`findById\(`,
    roots: ['src'],
    message: 'unscoped repository access — every tenant read takes userId (ADR-009)',
  },
  {
    id: 'console-logging',
    pattern: String.raw`console\.(log|error|warn)`,
    roots: ['src'],
    message: 'console logging — use the request-scoped child logger (ARCHITECTURE.MD §17.1)',
  },
];

/** Directory names never traversed, at any depth. */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.vitest',
  'drizzle',
  'fixtures',
]);

/** Only these extensions are scanned. */
const SCANNED_EXTENSIONS = ['.ts', '.mts', '.cts'];

/** Test files are exempt: they legitimately contain the patterns as assertions. */
function isExemptFile(fileName: string): boolean {
  return (
    fileName.endsWith('.test.ts') ||
    fileName.endsWith('.spec.ts') ||
    fileName.endsWith('.d.ts') ||
    fileName.endsWith('.test.mts') ||
    fileName.endsWith('.d.mts')
  );
}

function isScannableFile(fileName: string): boolean {
  return SCANNED_EXTENSIONS.some((ext) => fileName.endsWith(ext)) && !isExemptFile(fileName);
}

export interface Violation {
  readonly ruleId: string;
  readonly message: string;
  /** Repository-relative, POSIX-separated, so output is identical on every OS. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  /** The offending source line, trimmed. */
  readonly source: string;
}

export interface ScanOptions {
  /** Repository root the rule roots are resolved against. */
  readonly root: string;
  readonly rules: readonly InvariantRule[];
}

export interface ScanResult {
  readonly violations: readonly Violation[];
  /** Rule roots that do not exist yet — reported, not treated as failures. */
  readonly missingRoots: readonly string[];
  readonly scannedFiles: number;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/** Depth-first list of scannable files under `dir`. Returns [] if absent. */
function collectFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Unreadable or vanished mid-walk. Treated the same as empty; a genuinely
    // missing root is detected up front by directoryExists().
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...collectFiles(full));
    } else if (entry.isFile() && isScannableFile(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Scan `rules` against the tree at `options.root`.
 *
 * A rule root that does not exist is recorded in `missingRoots` and skipped —
 * `src/domain/` legitimately does not exist until Phase 1, and the checker must
 * not fail the build for that. An existing but empty root simply contributes
 * no files.
 */
export function scanForViolations(options: ScanOptions): ScanResult {
  const violations: Violation[] = [];
  const missingRoots: string[] = [];
  const scanned = new Set<string>();

  for (const rule of options.rules) {
    for (const ruleRoot of rule.roots) {
      const absoluteRoot = join(options.root, ruleRoot);
      if (!directoryExists(absoluteRoot)) {
        if (!missingRoots.includes(ruleRoot)) missingRoots.push(ruleRoot);
        continue;
      }

      for (const file of collectFiles(absoluteRoot)) {
        scanned.add(file);
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((text, index) => {
          // Fresh RegExp per line: a shared global regex carries lastIndex
          // between calls and silently skips matches.
          const matches = text.matchAll(new RegExp(rule.pattern, 'g'));
          for (const match of matches) {
            violations.push({
              ruleId: rule.id,
              message: rule.message,
              file: toPosix(relative(options.root, file)),
              line: index + 1,
              column: (match.index ?? 0) + 1,
              source: text.trim(),
            });
          }
        });
      }
    }
  }

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);

  return { violations, missingRoots, scannedFiles: scanned.size };
}

/** Human-readable report. Returns the lines rather than printing them. */
export function formatScanResult(result: ScanResult): string[] {
  const lines: string[] = [];

  for (const root of result.missingRoots) {
    lines.push(`check-invariants: ${root}/ not present yet — rules for it were skipped`);
  }

  if (result.violations.length === 0) {
    lines.push(`check-invariants: clean (${String(result.scannedFiles)} files scanned)`);
    return lines;
  }

  for (const violation of result.violations) {
    lines.push(
      `${violation.file}:${String(violation.line)}:${String(violation.column)} ` +
        `INVARIANT VIOLATION [${violation.ruleId}] ${violation.message}`,
    );
    lines.push(`    ${violation.source}`);
  }
  lines.push('');
  lines.push(
    `check-invariants: ${String(result.violations.length)} violation(s) across ` +
      `${String(new Set(result.violations.map((v) => v.file)).size)} file(s), ` +
      `${String(result.scannedFiles)} files scanned`,
  );
  return lines;
}

export interface CliOptions {
  readonly root: string;
  readonly quiet: boolean;
}

export function parseCliArgs(argv: readonly string[], cwd: string): CliOptions {
  let root = cwd;
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--root requires a directory argument');
      root = value;
      i += 1;
    } else if (arg === '--quiet') {
      quiet = true;
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  return { root, quiet };
}

function main(): number {
  const options = parseCliArgs(process.argv.slice(2), process.cwd());
  const result = scanForViolations({ root: options.root, rules: PHASE_0_RULES });

  if (!options.quiet || result.violations.length > 0) {
    for (const line of formatScanResult(result)) console.log(line);
  }
  return result.violations.length > 0 ? 1 : 0;
}

// Run only when invoked as a script, so tests can import the functions above.
// pathToFileURL rather than string comparison: on Windows argv[1] is a
// backslash path and import.meta.url is a file:// URL.
const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  process.exitCode = main();
}
