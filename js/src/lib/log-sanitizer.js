/**
 * Prepares logs and issue text for publication with
 * @link-foundation/sensitive-data-sanitizer, the sanitizer shared by
 * start-command, gh-upload-log and hive-mind (issue #250).
 *
 * The library masks credentials only (--credentials-only), plus the values of
 * credential-named environment variables (--env-secrets) and the tokens in the
 * local gh hosts.yml (--gh-config). It streams the log from stdin, keeps
 * invalid UTF-8 bytes and writes a new private file atomically (--output).
 *
 * Since 0.12.1 the library masks only the scheme and token of an
 * `Authorization: <scheme> <value>` header, so a logged one-line JSON prompt
 * keeps the rest of its line (issue #249, sensitive-data-sanitizer#45); the
 * pre-pass that did this here is gone (issue #253).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BLOCK_SIZE = 64 * 1024;
const MARKER = '[REDACTED]';
const PACKAGE = '@link-foundation/sensitive-data-sanitizer';
const COMMAND = 'sensitive-data-sanitizer';
const OVERRIDE = 'START_SENSITIVE_DATA_SANITIZER';
const OPTIONS = ['--credentials-only', '--env-secrets', '--gh-config'];

/** Value-free failure: `code` is a fixed ERR_* name, never log content. */
class SanitizationError extends Error {
  constructor(code, subject = 'Log') {
    super(
      `${subject} sanitization failed (${code}); ${subject === 'Log' ? 'upload' : 'publication'} blocked.`
    );
    this.code = code;
  }
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findBundledCli() {
  // Walk up node_modules directories the way require() does; the package
  // exports only ESM, so require.resolve() cannot locate its files.
  const relative = path.join(PACKAGE, 'bin', `${COMMAND}.js`);
  let directory = __dirname;
  for (;;) {
    const candidate = path.join(directory, 'node_modules', relative);
    if (isFile(candidate)) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/**
 * Resolve the library CLI: START_SENSITIVE_DATA_SANITIZER, then the bundled
 * dependency run by the current runtime, then sensitive-data-sanitizer on PATH.
 * @returns {{command: string, args: string[]}|null}
 */
function resolveSanitizerCommand(env = process.env) {
  if (env[OVERRIDE]) {
    return { command: env[OVERRIDE], args: [] };
  }
  const bundled = findBundledCli();
  if (bundled) {
    return { command: process.execPath, args: [bundled] };
  }
  const { resolveCommand } = require('./log-uploader');
  const command = resolveCommand(COMMAND);
  return command ? { command, args: [] } : null;
}

function runSanitizer(args, options, subject) {
  const env = options.env || process.env;
  const resolved = resolveSanitizerCommand(env);
  if (!resolved) {
    throw new SanitizationError('ERR_UNAVAILABLE', subject);
  }
  const result = spawnSync(resolved.command, [...resolved.args, ...args], {
    env,
    input: options.input,
    stdio: options.stdio || ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    shell:
      process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved.command),
    windowsHide: true,
  });
  if (result.error) {
    throw new SanitizationError('ERR_UNAVAILABLE', subject);
  }
  if (result.status !== 0) {
    // The library prints value-free messages; only their ERR_* code is kept.
    const code = String(result.stderr || '').match(/\bERR_[A-Z_]+\b/);
    throw new SanitizationError(code ? code[0] : 'ERR_SANITIZER', subject);
  }
  return result;
}

/**
 * Sanitize a short text, such as the failing command quoted in an issue.
 * @returns {string}
 */
function sanitizeText(text, options = {}) {
  const result = runSanitizer(
    ['redact', '-', ...OPTIONS],
    { ...options, input: text },
    'Text'
  );
  return result.stdout.toString();
}

function countMarkers(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(BLOCK_SIZE);
  let count = 0;
  let carry = '';
  try {
    for (;;) {
      const length = fs.readSync(descriptor, buffer, 0, BLOCK_SIZE, null);
      const text = carry + buffer.toString('latin1', 0, length);
      let index = text.indexOf(MARKER);
      let next = 0;
      while (index !== -1) {
        count++;
        next = index + MARKER.length;
        index = text.indexOf(MARKER, next);
      }
      if (length === 0) {
        return count;
      }
      carry = text.slice(Math.max(next, text.length - MARKER.length + 1));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Create a private sanitized copy of a log. The source is never modified;
 * any failure removes the copy and throws a value-free SanitizationError.
 * @returns {{path: string, cleanup: Function}}
 */
function sanitizeLogToTemp(sourcePath, options = {}) {
  let directory;
  let code = 'ERR_PRIVATE_FILE';
  const cleanup = () => {
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'start-sanitized-'));
    if (process.platform !== 'win32') {
      fs.chmodSync(directory, 0o700);
    }
    const target = path.join(directory, 'execution.log');
    code = 'ERR_SOURCE';
    const input = fs.openSync(sourcePath, 'r');
    let bytes;
    try {
      const source = fs.fstatSync(input);
      if (!source.isFile()) {
        throw new SanitizationError('ERR_SOURCE');
      }
      bytes = source.size;
      const size = Math.max(1, bytes);
      code = 'ERR_PRIVATE_FILE';
      runSanitizer(
        [
          'redact',
          '-',
          '--stream',
          // A NUL byte in a terminal transcript must not block the upload.
          '--allow-binary',
          ...OPTIONS,
          '--max-bytes',
          String(size),
          '--output',
          target,
        ],
        { env: options.env, stdio: [input, 'ignore', 'pipe'] }
      );
    } finally {
      fs.closeSync(input);
    }
    code = 'ERR_OUTPUT';
    const status = fs.lstatSync(target);
    if (
      !status.isFile() ||
      (process.platform !== 'win32' && (status.mode & 0o077) !== 0)
    ) {
      throw new SanitizationError('ERR_OUTPUT');
    }
    if (options.verbose) {
      const redactions = countMarkers(target) - countMarkers(sourcePath);
      console.log(
        `Prepared private sanitized log: ${bytes} bytes scanned, ${Math.max(0, redactions)} redactions.`
      );
    }
    return { path: target, cleanup };
  } catch (error) {
    cleanup();
    // Static messages keep paths and system error details out of the output.
    const failure =
      error instanceof SanitizationError ? error : new SanitizationError(code);
    if (options.verbose) {
      console.error(failure.message);
    }
    throw failure;
  }
}

module.exports = {
  BLOCK_SIZE,
  SanitizationError,
  resolveSanitizerCommand,
  sanitizeLogToTemp,
  sanitizeText,
};
