// @ts-check
/**
 * Stop hook — warn when the working tree is dirty and the unit suite is red
 * (DEV_PIPELINE.MD §1.3).
 *
 * DEV_PIPELINE.MD §13.4: commit at every green. A compaction that follows a
 * commit is recoverable; one that follows two hours of uncommitted work on a
 * red suite is not. This is the reminder at exactly the moment it matters.
 *
 * It warns; it does not block. A blocking Stop hook can trap a session in a
 * loop, and the failure mode here is a forgotten commit, not data loss.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePayload, readStdin } from './hook-io.mjs';

/**
 * @param {object} state
 * @param {boolean} state.dirty
 * @param {boolean} state.unitSuiteGreen
 * @param {number}  state.changedFiles
 * @returns {string | null} warning text, or null when nothing needs saying
 */
export function buildWarning({ dirty, unitSuiteGreen, changedFiles }) {
  if (!dirty) return null;
  if (unitSuiteGreen) return null;
  return (
    `Working tree has ${String(changedFiles)} uncommitted file(s) and the unit suite is RED.\n` +
    'Run `npm run verify` and get to green before stopping — DEV_PIPELINE.MD §13.4 ' +
    '("commit at every green"). Uncommitted work on a red suite is the state that does ' +
    'not survive a compaction.'
  );
}

/**
 * @param {string} repoRoot
 * @returns {string[]} porcelain lines; empty when clean or not a repository
 */
function changedFiles(repoRoot) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return out.split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * @param {string} repoRoot
 * @returns {boolean}
 */
function unitSuitePasses(repoRoot) {
  try {
    execFileSync('npx', ['--no-install', 'vitest', 'run', '--project', 'unit', '--silent'], {
      cwd: repoRoot,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const payload = parsePayload(await readStdin(), process.cwd());
  const changed = changedFiles(payload.repoRoot);

  // Clean tree: nothing to warn about, and no reason to spend two seconds
  // running the suite.
  if (changed.length === 0) process.exit(0);
  if (!existsSync(join(payload.repoRoot, 'node_modules', 'vitest'))) process.exit(0);

  const warning = buildWarning({
    dirty: true,
    unitSuiteGreen: unitSuitePasses(payload.repoRoot),
    changedFiles: changed.length,
  });

  if (warning !== null) {
    process.stdout.write(JSON.stringify({ systemMessage: warning }));
    process.stderr.write(`${warning}\n`);
  }
  process.exit(0);
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  await main();
}
