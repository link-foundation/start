/** Bounded byte-wise sanitization for logs prepared for publication. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const BLOCK_SIZE = 64 * 1024;
const MARKER = '[REDACTED]';
const SECRET_ENV_NAME =
  /(?:^|_)(?:TOKEN|(?:API|ACCESS|PRIVATE)?KEY|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|PAT)(?:_|$)/i;

// Prefixes intentionally match even truncated tokens. Unbounded values retain a
// continuation state, so a token or header larger than a block cannot leak its
// suffix. Latin-1 provides a reversible byte mapping, including invalid UTF-8.
const RULES = [
  {
    pattern:
      /\b[A-Za-z0-9_-]{2,512}\.[A-Za-z0-9_-]{2,512}\.[A-Za-z0-9_-]{0,512}/g,
    validate: (value) => {
      try {
        return (
          typeof JSON.parse(
            Buffer.from(value.split('.')[0], 'base64url').toString()
          ).alg === 'string'
        );
      } catch {
        return false;
      }
    },
    continuation: /[A-Za-z0-9_.-]/,
  },
  {
    pattern: /[A-Za-z0-9_-]{512,}[A-Za-z0-9_.-]*/g,
    continuation: /[A-Za-z0-9_.-]/,
  },
  {
    pattern: /(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]*/g,
    continuation: /[A-Za-z0-9_-]/,
  },
  { pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g },
  { pattern: /eyJ[A-Za-z0-9_.-]*/g, continuation: /[A-Za-z0-9_.-]/ },
  {
    pattern: /(?:Proxy-)?Authorization[ \t]{0,32}:[^\r\n]*/gi,
    continuation: /[^\r\n]/,
  },
  {
    pattern:
      /(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)[ \t]{0,32}[=:][ \t]*["']?[^\s"';,]*/g,
    continuation: /[^\s"';,]/,
  },
  {
    pattern: /(?:https?|git|ssh):\/\/[^\s:/@]{1,256}:[^\s@]*/g,
    continuation: /[^\s@]/,
  },
];

class StreamingSanitizer {
  constructor(env = process.env) {
    this.secrets = [
      ...new Set(
        Object.entries(env)
          .filter(
            ([name, value]) =>
              SECRET_ENV_NAME.test(name) &&
              typeof value === 'string' &&
              value.length
          )
          .map(([, value]) => Buffer.from(value).toString('latin1'))
      ),
    ].sort((a, b) => b.length - a.length);
    if (this.secrets.some((value) => value.length > BLOCK_SIZE)) {
      throw new Error(
        'Known environment secret is too large for bounded sanitization.'
      );
    }
    this.holdback = this.secrets.reduce(
      (size, value) => Math.max(size, value.length),
      2048
    );
    this.pending = '';
    this.continuation = null;
    this.redactions = 0;
  }

  get pendingBytes() {
    return this.pending.length;
  }

  findMatches(input) {
    const matches = [];
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      for (
        let match = rule.pattern.exec(input);
        match;
        match = rule.pattern.exec(input)
      ) {
        if (!rule.validate || rule.validate(match[0])) {
          matches.push({
            index: match.index,
            end: match.index + match[0].length,
            continuation: rule.continuation,
          });
        }
      }
    }
    for (const secret of this.secrets) {
      for (
        let index = input.indexOf(secret);
        index >= 0;
        index = input.indexOf(secret, index + 1)
      ) {
        matches.push({ index, end: index + secret.length });
      }
    }
    matches.sort((a, b) => a.index - b.index || b.end - a.end);
    const merged = [];
    for (const match of matches) {
      const previous = merged[merged.length - 1];
      if (previous && match.index <= previous.end) {
        if (match.end > previous.end) {
          previous.end = match.end;
          previous.continuation = match.continuation;
        } else if (match.end === previous.end && match.continuation) {
          // Nested tokens must not narrow a containing header/URL's suffix.
          const retained = previous.continuation;
          const additional = match.continuation;
          previous.continuation = retained
            ? { test: (byte) => retained.test(byte) || additional.test(byte) }
            : additional;
        }
      } else {
        merged.push({ ...match });
      }
    }
    return merged;
  }

  push(block, final = false) {
    let input = this.pending + block.toString('latin1');
    this.pending = '';
    if (this.continuation) {
      let end = 0;
      while (end < input.length && this.continuation.test(input[end])) {
        end++;
      }
      input = input.slice(end);
      if (!input.length && !final) {
        return Buffer.alloc(0);
      }
      this.continuation = null;
    }
    const safeEnd = final
      ? input.length
      : Math.max(0, input.length - this.holdback);
    let offset = 0;
    const output = [];
    for (const match of this.findMatches(input)) {
      if (match.index >= safeEnd) {
        break;
      }
      output.push(input.slice(offset, match.index), MARKER);
      this.redactions++;
      offset = match.end;
      if (offset === input.length && match.continuation && !final) {
        this.continuation = match.continuation;
        break;
      }
    }
    const end = Math.max(offset, safeEnd);
    output.push(input.slice(offset, end));
    this.pending = input.slice(end);
    return Buffer.from(output.join(''), 'latin1');
  }
}

/** Returns a private copy plus cleanup; every preparation error blocks upload. */
function sanitizeLogToTemp(sourcePath, options = {}) {
  let directory;
  let source;
  let destination;
  let ready = false;
  let stage = 'environment';
  try {
    const sanitizer = new StreamingSanitizer(options.env || process.env);
    stage = 'source';
    source = fs.openSync(sourcePath, 'r');
    if (!fs.fstatSync(source).isFile()) {
      throw new Error('Source must be a regular file.');
    }
    stage = 'private-file';
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'start-sanitized-'));
    fs.chmodSync(directory, 0o700);
    const target = path.join(directory, 'execution.log');
    destination = fs.openSync(target, 'wx', 0o600);
    fs.fchmodSync(destination, 0o600);
    const buffer = Buffer.alloc(BLOCK_SIZE);
    let bytes = 0;
    const write = (output) => {
      stage = 'write';
      let offset = 0;
      while (offset < output.length) {
        const written = fs.writeSync(
          destination,
          output,
          offset,
          output.length - offset
        );
        if (!written) {
          throw new Error('No progress writing sanitized log.');
        }
        offset += written;
      }
    };
    for (;;) {
      stage = 'read';
      const length = fs.readSync(source, buffer, 0, buffer.length, null);
      if (!length) {
        break;
      }
      bytes += length;
      stage = 'scan';
      write(sanitizer.push(buffer.subarray(0, length)));
    }
    write(sanitizer.push(Buffer.alloc(0), true));
    stage = 'sync';
    fs.fsyncSync(destination);
    fs.closeSync(destination);
    destination = undefined;
    fs.closeSync(source);
    source = undefined;
    if (options.verbose) {
      console.log(
        `Prepared private sanitized log: ${bytes} bytes scanned, ${sanitizer.redactions} redactions.`
      );
    }
    ready = true;
    return {
      path: target,
      cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
    };
  } catch {
    if (options.verbose) {
      console.log(`Log sanitization failed at stage: ${stage}.`);
    }
    // Do not echo error messages: paths and exception details can carry secrets.
    throw new Error('Log sanitization failed; upload blocked.');
  } finally {
    for (const fd of [destination, source]) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* Best effort after failure. */
        }
      }
    }
    if (directory && !ready) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        /* Upload remains blocked. */
      }
    }
  }
}

module.exports = { StreamingSanitizer, sanitizeLogToTemp };
