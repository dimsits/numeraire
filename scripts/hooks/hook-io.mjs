// @ts-check
/**
 * Shared plumbing for the Claude Code hooks in this directory.
 *
 * Every hook receives the same JSON payload on stdin and has to answer the
 * same two questions first: what file was touched, and where is the repository
 * root. Keeping that in one place means a path-normalisation bug is fixed
 * once rather than four times.
 */

/** Windows path separator, as a single character. */
const BACKSLASH = String.fromCharCode(92);

/**
 * Normalise a path to forward slashes, so hook logic never has to care which
 * platform produced it.
 *
 * @param {string} path
 * @returns {string}
 */
export function toPosix(path) {
  return path.split(BACKSLASH).join('/');
}

/**
 * Express `filePath` relative to `repoRoot`, POSIX-separated.
 *
 * Returns the input unchanged (normalised) when it is not under the root —
 * callers treat an unrecognised path as "not mine to judge".
 *
 * @param {string} filePath
 * @param {string} repoRoot
 * @returns {string}
 */
export function relativeToRoot(filePath, repoRoot) {
  const file = toPosix(filePath);
  const root = toPosix(repoRoot).replace(/\/+$/, '');
  if (root !== '' && file.startsWith(`${root}/`)) {
    return file.slice(root.length + 1);
  }
  return file.replace(/^\.\//, '');
}

/**
 * Read the whole of stdin. Resolves to an empty string if stdin errors, so a
 * hook never hangs on a broken pipe.
 *
 * @returns {Promise<string>}
 */
export function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    // setEncoding above makes each chunk a string at runtime; the stream types
    // still describe it as a Buffer, so convert explicitly.
    process.stdin.on('data', (chunk) => {
      data += chunk.toString();
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
    process.stdin.on('error', () => {
      resolve('');
    });
  });
}

/**
 * @typedef {object} HookPayload
 * @property {string} toolName
 * @property {string} repoRoot   absolute, as given by Claude Code
 * @property {string} filePath   repository-relative, POSIX separators
 * @property {boolean} parsed    false when stdin was absent or malformed
 */

/**
 * Parse a hook payload into the three fields every hook here needs.
 *
 * @param {string} raw
 * @param {string} fallbackRoot
 * @returns {HookPayload}
 */
export function parsePayload(raw, fallbackRoot) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw === '' ? '{}' : raw);
  } catch {
    return { toolName: '', repoRoot: fallbackRoot, filePath: '', parsed: false };
  }

  // The payload arrives from outside this process, so it is narrowed by
  // runtime checks rather than asserted into shape. A field that is missing or
  // the wrong type reads as absent, never as a crash mid-hook.
  const repoRoot = stringAt(parsed, 'cwd') ?? fallbackRoot;
  const rawPath = stringAt(objectAt(parsed, 'tool_input'), 'file_path') ?? '';

  return {
    toolName: stringAt(parsed, 'tool_name') ?? '',
    repoRoot,
    filePath: rawPath === '' ? '' : relativeToRoot(rawPath, repoRoot),
    parsed: true,
  };
}

/**
 * @param {unknown} source
 * @param {string} key
 * @returns {unknown}
 */
function objectAt(source, key) {
  if (typeof source !== 'object' || source === null) return undefined;
  return Object.hasOwn(source, key) ? Reflect.get(source, key) : undefined;
}

/**
 * @param {unknown} source
 * @param {string} key
 * @returns {string | undefined}
 */
function stringAt(source, key) {
  const value = objectAt(source, key);
  return typeof value === 'string' ? value : undefined;
}
