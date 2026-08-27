// @ts-check
/**
 * PostToolUse hook — typecheck after a TypeScript edit (DEV_PIPELINE.MD §1.3).
 *
 * Surfaces type errors at the moment they are introduced rather than at the
 * next `npm run verify`, by which point the session has moved on and the cause
 * is three edits back.
 *
 * PostToolUse matchers key on the tool name, not the path, so the path filter
 * lives here. Exits 2 with the compiler output on stderr — that is what feeds
 * the errors back to the model — and 0 otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePayload, readStdin } from './hook-io.mjs';

/**
 * Only project TypeScript triggers a check. Fixtures are excluded from
 * tsconfig deliberately and would never be reported anyway.
 *
 * @param {string} filePath repository-relative, POSIX separators
 * @returns {boolean}
 */
export function shouldTypecheck(filePath) {
  if (!/\.(ts|mts|cts)$/.test(filePath)) return false;
  if (filePath.startsWith('tests/fixtures/')) return false;
  return (
    filePath.startsWith('src/') ||
    filePath.startsWith('tests/') ||
    filePath.startsWith('scripts/') ||
    !filePath.includes('/')
  );
}

async function main() {
  const payload = parsePayload(await readStdin(), process.cwd());
  if (!payload.parsed) process.exit(0);
  if (!shouldTypecheck(payload.filePath)) process.exit(0);

  // Without an install there is no compiler and nothing meaningful to say.
  // This is a precondition, not a suppressed failure.
  if (!existsSync(join(payload.repoRoot, 'node_modules', 'typescript'))) {
    process.stderr.write('typecheck-on-edit: node_modules missing; run npm ci.\n');
    process.exit(0);
  }

  try {
    execFileSync('npx', ['--no-install', 'tsc', '--noEmit', '-p', 'tsconfig.json'], {
      cwd: payload.repoRoot,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    process.exit(0);
  } catch (error) {
    const failure = /** @type {{ stdout?: Buffer, stderr?: Buffer }} */ (error);
    const output = `${failure.stdout?.toString() ?? ''}${failure.stderr?.toString() ?? ''}`.trim();
    process.stderr.write(`Typecheck failed after editing ${payload.filePath}:\n\n${output}\n`);
    process.exit(2);
  }
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  await main();
}
