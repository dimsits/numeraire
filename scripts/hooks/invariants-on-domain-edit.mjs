// @ts-check
/**
 * PostToolUse hook — run the invariant checker after a `src/domain/` edit
 * (DEV_PIPELINE.MD §1.3).
 *
 * The domain layer is where a float in a money path does real damage, so it
 * gets checked on every write rather than only at the verification gate.
 *
 * PostToolUse matchers key on the tool name, so the path filter lives here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePayload, readStdin } from './hook-io.mjs';

/**
 * @param {string} filePath repository-relative, POSIX separators
 * @returns {boolean}
 */
export function isDomainSource(filePath) {
  if (!filePath.startsWith('src/domain/')) return false;
  if (!/\.(ts|mts|cts)$/.test(filePath)) return false;
  // Test files are exempt from the invariant rules themselves, so editing one
  // cannot introduce a violation.
  return !/\.(test|spec)\.(ts|mts|cts)$/.test(filePath);
}

async function main() {
  const payload = parsePayload(await readStdin(), process.cwd());
  if (!payload.parsed) process.exit(0);
  if (!isDomainSource(payload.filePath)) process.exit(0);

  if (!existsSync(join(payload.repoRoot, 'node_modules', 'tsx'))) {
    process.stderr.write('invariants-on-domain-edit: node_modules missing; run npm ci.\n');
    process.exit(0);
  }

  try {
    execFileSync('npx', ['--no-install', 'tsx', 'scripts/check-invariants.ts', '--quiet'], {
      cwd: payload.repoRoot,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    process.exit(0);
  } catch (error) {
    const failure = /** @type {{ stdout?: Buffer, stderr?: Buffer }} */ (error);
    const output = `${failure.stdout?.toString() ?? ''}${failure.stderr?.toString() ?? ''}`.trim();
    process.stderr.write(
      `Invariant check failed after editing ${payload.filePath}:\n\n${output}\n\n` +
        'Do not relax the rule to make this pass (DEV_PIPELINE.MD §13.2 item 4).\n',
    );
    process.exit(2);
  }
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  await main();
}
