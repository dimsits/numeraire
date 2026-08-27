// @ts-check
/**
 * PreToolUse hook — block edits to a migration that already exists in HEAD.
 *
 * DEV_PIPELINE.MD §1.3 and §13.2 item 1: a `drizzle/*.sql` file is immutable
 * once committed. Editing an applied migration means the schema in the
 * database and the schema in the repository diverge silently, and every
 * environment that already ran it becomes unreproducible.
 *
 * This is a hook rather than a line in CLAUDE.md on purpose: an instruction is
 * followed most of the time, a hook fires every time.
 *
 * Contract: reads the PreToolUse payload on stdin, exits 0 to allow and 2 to
 * block. On exit 2 the stderr text is fed back to the model as the reason.
 */
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePayload, readStdin, relativeToRoot } from './hook-io.mjs';

/**
 * @typedef {object} GuardDecision
 * @property {boolean} blocked
 * @property {string}  reason
 */

/** Migrations live directly under drizzle/ and are the only guarded files. */
const MIGRATION_PATTERN = /^drizzle\/[^/]+\.sql$/;

/**
 * Repository-relative, POSIX-separated path, or null when the target lies
 * outside the repository.
 *
 * @param {string} filePath
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function toRepoRelative(filePath, repoRoot) {
  if (filePath === '') return null;
  const relative = relativeToRoot(filePath, repoRoot);
  if (relative === '' || relative.startsWith('../') || isAbsolute(relative)) return null;
  // A Windows absolute path that is not under the root survives normalisation
  // as `C:/elsewhere/...`; a drive letter means it was never relative.
  if (/^[A-Za-z]:\//.test(relative)) return null;
  return relative;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isMigrationPath(path) {
  return MIGRATION_PATTERN.test(path);
}

/**
 * The decision itself, with the committed-file lookup injected so it can be
 * tested without putting a repository into a particular state.
 *
 * @param {object} input
 * @param {string} input.toolName
 * @param {string} input.filePath  repository-relative, POSIX separators
 * @param {(path: string) => boolean} input.existsInHead
 * @returns {GuardDecision}
 */
export function decide({ toolName, filePath, existsInHead }) {
  const allow = { blocked: false, reason: '' };

  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'NotebookEdit') return allow;
  if (filePath === '') return allow;
  if (!isMigrationPath(filePath)) return allow;

  // A migration not yet in HEAD is new work: creating and refining it before
  // the first commit is exactly the intended workflow.
  if (!existsInHead(filePath)) return allow;

  return {
    blocked: true,
    reason:
      `Blocked: ${filePath} already exists in HEAD.\n\n` +
      'Migrations are immutable once committed (CLAUDE.md, DEV_PIPELINE.MD §13.2 item 1). ' +
      'An applied migration that changes leaves the database and the repository silently ' +
      'out of step.\n\n' +
      'Generate a new migration instead:\n' +
      '  npx drizzle-kit generate\n\n' +
      'If the committed migration is genuinely wrong and has not been applied anywhere, ' +
      'that is a decision for the repository owner, not for this session.',
  };
}

/**
 * Whether `path` is present in the given git ref.
 *
 * @param {string} path
 * @param {string} repoRoot
 * @param {string} ref
 * @returns {boolean}
 */
export function existsInGitRef(path, repoRoot, ref) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${path}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    // Non-zero from `cat-file -e` means "not in that ref". It is also what an
    // unborn HEAD returns, which is the right answer for a repository with no
    // commits: nothing is committed, so nothing is immutable yet.
    return false;
  }
}

async function main() {
  const payload = parsePayload(await readStdin(), process.cwd());

  if (!payload.parsed) {
    // A payload this hook cannot read is not evidence of a violation. Allow,
    // but say so on stderr rather than failing silently.
    process.stderr.write('guard-migrations: unreadable hook payload; allowing.\n');
    process.exit(0);
  }

  const filePath = toRepoRelative(payload.filePath, payload.repoRoot) ?? '';

  const decision = decide({
    toolName: payload.toolName,
    filePath,
    existsInHead: (path) => existsInGitRef(path, payload.repoRoot, 'HEAD'),
  });

  if (decision.blocked) {
    process.stderr.write(`${decision.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

// Run only when executed directly, so tests can import the pure parts.
// pathToFileURL rather than string comparison: on Windows argv[1] is a
// backslash path while import.meta.url is a file:// URL.
const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  await main();
}
