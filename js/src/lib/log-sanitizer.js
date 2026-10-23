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
 * One rule stays here: the library masks an unquoted or single-quoted
 * `Authorization: <scheme> <value>` to the end of the line, which drops the
 * rest of a logged one-line JSON prompt (issue #249). The pre-pass below masks
 * only the scheme and its token first; the library keeps values that already
 * start with [REDACTED]. Remove it with sensitive-data-sanitizer#45.
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

// The longest header and scheme prefix is 122 bytes.
const HOLDBACK = 160;
const HEADER =
  /((?:Proxy-)?Authorization[ \t]{0,32}:[ \t]{0,32})(?:Bearer|Basic|Digest|token)[ \t]{1,32}/gi;
// Shell expressions, placeholders and masked values are not credentials.
const NOT_A_VALUE = '$<[{';

function isValueByte(code) {
  return (
    code > 0x20 &&
    code !== 0x22 &&
    code !== 0x27 &&
    code !== 0x2c &&
    code !== 0x5c
  );
}

function valueEnd(text, start) {
  let end = start;
  while (end < text.length && isValueByte(text.charCodeAt(end))) {
    end++;
  }
  return end;
}

/**
 * Masks `Authorization: <scheme> <token>` as `Authorization: [REDACTED]`.
 * It works on bytes (latin1 maps each byte to one character), so invalid
 * UTF-8 passes through unchanged, and holds at most HOLDBACK pending bytes.
 */
class AuthorizationHeaderMask {
  constructor() {
    this.pending = '';
    this.inValue = false;
    this.redactions = 0;
  }

  push(block, final = false) {
    const text = this.pending + block.toString('latin1');
    this.pending = '';
    let output = '';
    let offset = 0;
    if (this.inValue) {
      offset = valueEnd(text, 0);
      if (offset === text.length && !final) {
        return Buffer.alloc(0);
      }
      this.inValue = false;
    }
    HEADER.lastIndex = offset;
    let match;
    while ((match = HEADER.exec(text))) {
      const valueStart = match.index + match[0].length;
      if (valueStart === text.length && !final) {
        output += text.slice(offset, match.index);
        this.pending = text.slice(match.index);
        return Buffer.from(output, 'latin1');
      }
      if (
        valueStart === text.length ||
        !isValueByte(text.charCodeAt(valueStart)) ||
        NOT_A_VALUE.includes(text[valueStart])
      ) {
        continue;
      }
      output += text.slice(offset, match.index + match[1].length) + MARKER;
      this.redactions++;
      offset = valueEnd(text, valueStart);
      if (offset === text.length && !final) {
        this.inValue = true;
        return Buffer.from(output, 'latin1');
      }
      HEADER.lastIndex = offset;
    }
    const safeEnd = final
      ? text.length
      : Math.max(offset, text.length - HOLDBACK);
    output += text.slice(offset, safeEnd);
    this.pending = text.slice(safeEnd);
    return Buffer.from(output, 'latin1');
  }
}

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
  const input = new AuthorizationHeaderMask().push(Buffer.from(text), true);
  const result = runSanitizer(
    ['redact', '-', ...OPTIONS],
    { ...options, input },
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

function createPrivateFile(filePath) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  if (process.platform !== 'win32') {
    fs.fchmodSync(descriptor, 0o600);
  }
  return descriptor;
}

function maskAuthorizationHeaders(sourcePath, stagePath) {
  const source = fs.openSync(sourcePath, 'r');
  let stage;
  try {
    if (!fs.fstatSync(source).isFile()) {
      throw new SanitizationError('ERR_SOURCE');
    }
    stage = createPrivateFile(stagePath);
    const mask = new AuthorizationHeaderMask();
    const buffer = Buffer.alloc(BLOCK_SIZE);
    let bytes = 0;
    for (;;) {
      const length = fs.readSync(source, buffer, 0, BLOCK_SIZE, null);
      const output = mask.push(buffer.subarray(0, length), length === 0);
      if (output.length) {
        fs.writeSync(stage, output);
      }
      if (length === 0) {
        break;
      }
      bytes += length;
    }
    fs.fsyncSync(stage);
    return bytes;
  } finally {
    fs.closeSync(source);
    if (stage !== undefined) {
      fs.closeSync(stage);
    }
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
    const stagePath = path.join(directory, 'authorization-masked.log');
    const target = path.join(directory, 'execution.log');
    code = 'ERR_SOURCE';
    const bytes = maskAuthorizationHeaders(sourcePath, stagePath);
    code = 'ERR_PRIVATE_FILE';
    const input = fs.openSync(stagePath, 'r');
    try {
      const size = Math.max(1, fs.fstatSync(input).size);
      runSanitizer(
        [
          'redact',
          '-',
          '--stream',
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
    fs.rmSync(stagePath, { force: true });
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
  AuthorizationHeaderMask,
  BLOCK_SIZE,
  SanitizationError,
  resolveSanitizerCommand,
  sanitizeLogToTemp,
  sanitizeText,
};
