#!/usr/bin/env bun
const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHash } = require('node:crypto');
const {
  SanitizationError,
  resolveSanitizerCommand,
  sanitizeLogToTemp,
  sanitizeText,
} = require('../src/lib/log-sanitizer');

const GH_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-gh-'));

// Only what the runtime needs, so the host's own credential-named variables
// and gh login cannot change the expected output.
function testEnv(extra = {}) {
  const env = { GH_CONFIG_DIR };
  for (const name of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
  ]) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  return { ...env, ...extra };
}

function withLog(content, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-test-'));
  const source = path.join(dir, 'source.log');
  fs.writeFileSync(source, content);
  try {
    return callback(source, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sanitizeFile(content, env = testEnv()) {
  return withLog(content, (source) => {
    const copy = sanitizeLogToTemp(source, { env });
    try {
      return fs.readFileSync(copy.path);
    } finally {
      copy.cleanup();
    }
  });
}

// The three lines from issue #249, which the old rules truncated.
const ISSUE_249_LINES = [
  "Command: gate='/tmp/hive-mind-disk-baseline-0ce9e170-e6d3-494d-91e1-0d820245d34b'",
  '🧠 Formal AI: endpoint http://172.18.0.2:8080/api/openai/v1',
  '{"bodyPreview":"{\\"messages\\":[{\\"content\\":\\"use: curl -L -H \\\\\\"Authorization: token $(gh auth token)\\\\\\" -o <filename> <url>\\\\n...the rest of a 100 KB prompt...\\"}]}"}',
  'proxy http://myproxy:3128 and http://127.0.0.1:34271/session',
  'Authorization: [REDACTED] stays as it is',
  'account konard@example.com https://github.com/konard',
];

function credentials() {
  return [
    ...'pousr'.split('').map((kind) => `gh${kind}_${'a'.repeat(36)}`),
    `github_` + `pat_${'b'.repeat(82)}`,
    `sk-${'c'.repeat(48)}`,
    `sk-` + `proj-${'d'.repeat(90)}`,
    `AK` + `IA${'F'.repeat(16)}`,
    `AS` + `IA${'G'.repeat(16)}`,
    'ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    'arbitrary-credential',
    'encoded-credential',
    'password',
    'arbitrary-aws-secret',
    'custom-secret-value',
  ];
}

describe('log sanitization', () => {
  it('requires the sanitizer release the Rust installer asks for', () => {
    // An older CLI rejects --allow-binary (ERR_ARGUMENT), so the bundled
    // dependency and the Rust installer and version check agree.
    const range =
      require('../package.json').dependencies[
        '@link-foundation/sensitive-data-sanitizer'
      ];
    const rust = fs.readFileSync(
      path.join(__dirname, '../../rust/src/lib/log_sanitizer.rs'),
      'utf8'
    );
    const [, major, minor, patch] = range.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
    assert.ok(
      rust.includes(
        `PACKAGE: &str = "@link-foundation/sensitive-data-sanitizer@${range}";`
      )
    );
    assert.ok(
      rust.includes(
        `MINIMUM_VERSION: (u64, u64, u64) = (${major}, ${minor}, ${patch});`
      )
    );
  });

  it('keeps every line from issue #249 and public account details', () => {
    const input = `${ISSUE_249_LINES.join('\n')}\n`;
    assert.strictEqual(sanitizeFile(input).toString(), input);
  });

  it('redacts credentials and credential-named environment values', () => {
    const input = [
      ...credentials().slice(0, 9),
      'Authorization: Bearer arbitrary-credential',
      'Proxy-Authorization: Basic encoded-credential',
      'clone https://user:password@example.test/repo.git',
      'AWS_SECRET_ACCESS_KEY=arbitrary-aws-secret',
      'value custom-secret-value end',
      'ordinary utf8: café 😀',
      '',
    ].join('\n');
    const output = sanitizeFile(
      input,
      testEnv({ START_TEST_SECRET: 'custom-secret-value' })
    ).toString();
    for (const [index, secret] of credentials().entries()) {
      assert.ok(!output.includes(secret), `leaked secret #${index}`);
    }
    for (const kept of [
      'Authorization: [REDACTED]\n',
      'Proxy-Authorization: [REDACTED]\n',
      'clone https://[REDACTED]@example.test/repo.git\n',
      'value [REDACTED] end\n',
      'ordinary utf8: café 😀\n',
    ]) {
      assert.ok(output.includes(kept), `missing ${kept}`);
    }
  });

  it('masks only the Authorization scheme and token, keeping the rest of the line (#249)', () => {
    const cases = [
      [
        `curl -H 'Authorization: Basic dXNlcjpwYXNz' -o out.txt url`,
        `curl -H 'Authorization: [REDACTED]' -o out.txt url`,
      ],
      [
        'Authorization: Bearer abc rest of line',
        'Authorization: [REDACTED] rest of line',
      ],
      [
        'Authorization: token abc, other: keep',
        'Authorization: [REDACTED], other: keep',
      ],
      [
        '{"h":"Authorization: Bearer abc\\" tail","next":"keep"}',
        '{"h":"Authorization: [REDACTED]\\" tail","next":"keep"}',
      ],
      [
        'Authorization: token $(gh auth token) and ${GITHUB_TOKEN}',
        'Authorization: token $(gh auth token) and ${GITHUB_TOKEN}',
      ],
      // Since 0.12.2, placeholders and their scheme remain unchanged.
      ['Authorization: Bearer <token>', 'Authorization: Bearer <token>'],
    ];
    // sensitive-data-sanitizer 0.12.1 does this itself (#45), without the
    // pre-pass start used to run (#253).
    const input = cases.map(([line]) => line).join('\n');
    const expected = cases.map(([, line]) => line).join('\n');
    assert.strictEqual(sanitizeFile(input).toString(), expected);
    assert.strictEqual(sanitizeText(input, { env: testEnv() }), expected);
  });

  it('masks long Authorization tokens across stream blocks', () => {
    const input = Buffer.from(
      `Authorization: Bearer ${'a'.repeat(200000)} tail\nordinary\n`
    );
    assert.strictEqual(
      sanitizeFile(input).toString(),
      'Authorization: [REDACTED] tail\nordinary\n'
    );
  });

  it('preserves Authorization placeholders and control bytes when sanitizing twice (#253)', () => {
    const input = [
      'Authorization: Bearer [REDACTED] already',
      'Authorization: Bearer {{token}} x',
      'Authorization: Bearer <token> x',
      'Authorization: Bearer $GITHUB_TOKEN x',
      'Authorization: Bearer abc\0 tail',
      'Authorization: Bearer abc\x1b[0m tail',
      '{"header":"Authorization: Bearer ab[c]d","next":"keep"}',
    ].join('\n');
    const expected = [
      'Authorization: Bearer [REDACTED] already',
      // Arbitrary bracketed values are credentials; known references above
      // stay intact, but every bracket of this value must be removed (#50).
      'Authorization: [REDACTED] x',
      'Authorization: Bearer <token> x',
      'Authorization: Bearer $GITHUB_TOKEN x',
      'Authorization: [REDACTED]\0 tail',
      'Authorization: [REDACTED]\x1b[0m tail',
      '{"header":"Authorization: [REDACTED]","next":"keep"}',
    ].join('\n');
    const output = sanitizeFile(input);
    assert.strictEqual(output.toString(), expected);
    assert.deepStrictEqual(sanitizeFile(output), output);
  });

  it(
    'sanitizes dense credentials within a bounded process (#253, sanitizer #51)',
    { timeout: 25000 },
    () => {
      const count = 5700;
      const input = Array.from({ length: count }, (_, index) => {
        const token = createHash('sha256').update(String(index)).digest('hex');
        return `gh${'p_'}${token.slice(0, 36)} keep\n`;
      }).join('');
      const { command, args } = resolveSanitizerCommand({});
      const output = execFileSync(
        command,
        [
          '--max-old-space-size=384',
          ...args,
          'redact',
          '-',
          '--stream',
          '--credentials-only',
          '--allow-binary',
        ],
        {
          input,
          env: testEnv(),
          timeout: 20000,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
        }
      );
      assert.strictEqual(output.toString(), '[REDACTED] keep\n'.repeat(count));
    }
  );

  it('preserves invalid UTF-8 bytes, NUL bytes and line endings', () => {
    const input = Buffer.concat([
      Buffer.from('bad '),
      Buffer.from([0xff, 0xfe, 0xc3]),
      Buffer.from(` gh${'p_'}${'x'.repeat(36)}\r\nnext\rend`),
    ]);
    const expected = Buffer.concat([
      Buffer.from('bad '),
      Buffer.from([0xff, 0xfe, 0xc3]),
      Buffer.from(' [REDACTED]\r\nnext\rend'),
    ]);
    assert.deepStrictEqual(sanitizeFile(input), expected);
    assert.deepStrictEqual(sanitizeFile(Buffer.alloc(0)), Buffer.alloc(0));
    // --allow-binary: a NUL byte in a terminal transcript no longer blocks
    // the upload with ERR_BINARY (#253), and credentials next to it are masked.
    assert.strictEqual(
      sanitizeFile(`line\0one gh${'p_'}${'x'.repeat(36)}\0two\n`).toString(),
      'line\0one [REDACTED]\0two\n'
    );
  });

  it('sanitizes issue text with the same rules', () => {
    const token = `gh${'p_'}${'a'.repeat(36)}`;
    assert.strictEqual(
      sanitizeText(`echo ${token} 😀 'Authorization: token abc' -o x`, {
        env: testEnv(),
      }),
      `echo [REDACTED] 😀 'Authorization: [REDACTED]' -o x`
    );
    assert.strictEqual(
      sanitizeText('echo "quoted" $(id) `hostname`', { env: testEnv() }),
      'echo "quoted" $(id) `hostname`'
    );
  });

  it('resolves the override first and the bundled library otherwise', () => {
    assert.deepStrictEqual(
      resolveSanitizerCommand({ START_SENSITIVE_DATA_SANITIZER: '/x/sds' }),
      { command: '/x/sds', args: [] }
    );
    const bundled = resolveSanitizerCommand({});
    assert.strictEqual(bundled.command, process.execPath);
    assert.ok(
      bundled.args[0].endsWith(
        path.join(
          'sensitive-data-sanitizer',
          'bin',
          'sensitive-data-sanitizer.js'
        )
      )
    );
  });

  it('creates a private sanitized copy and removes it without changing the source', () => {
    const input = `gh` + `p_${'x'.repeat(36)}`;
    withLog(input, (source) => {
      const copy = sanitizeLogToTemp(source, { env: testEnv() });
      assert.notStrictEqual(copy.path, source);
      assert.strictEqual(fs.readFileSync(copy.path, 'utf8'), '[REDACTED]');
      assert.deepStrictEqual(fs.readdirSync(path.dirname(copy.path)), [
        'execution.log',
      ]);
      if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(copy.path).mode & 0o777, 0o600);
        assert.strictEqual(
          fs.statSync(path.dirname(copy.path)).mode & 0o777,
          0o700
        );
      }
      assert.strictEqual(fs.readFileSync(source, 'utf8'), input);
      copy.cleanup();
      assert.ok(!fs.existsSync(path.dirname(copy.path)));
    });
  });

  it('keeps private permissions even with a permissive umask', () => {
    if (process.platform === 'win32') {
      return;
    }
    const originalUmask = process.umask(0);
    try {
      withLog('ordinary output', (source) => {
        const copy = sanitizeLogToTemp(source, { env: testEnv() });
        try {
          assert.strictEqual(
            fs.statSync(path.dirname(copy.path)).mode & 0o777,
            0o700
          );
          assert.strictEqual(fs.statSync(copy.path).mode & 0o777, 0o600);
          assert.strictEqual(
            fs.readFileSync(copy.path, 'utf8'),
            'ordinary output'
          );
        } finally {
          copy.cleanup();
        }
      });
    } finally {
      process.umask(originalUmask);
    }
  });

  it('reports scanned bytes and added redactions in verbose mode only', () => {
    const messages = [];
    const originalLog = console.log;
    console.log = (message) => messages.push(message);
    try {
      withLog(`[REDACTED] gh${'p_'}${'x'.repeat(36)}\n`, (source) => {
        sanitizeLogToTemp(source, { env: testEnv() }).cleanup();
        sanitizeLogToTemp(source, { env: testEnv(), verbose: true }).cleanup();
      });
    } finally {
      console.log = originalLog;
    }
    assert.deepStrictEqual(messages, [
      'Prepared private sanitized log: 52 bytes scanned, 1 redactions.',
    ]);
  });

  it('fails closed with value-free codes and leaves no copy behind', () => {
    const before = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('start-sanitized-')).length;
    const attempt = (source, env = testEnv()) => {
      try {
        sanitizeLogToTemp(source, { env }).cleanup();
      } catch (error) {
        assert.ok(error instanceof SanitizationError);
        return error;
      }
      assert.fail('sanitization must fail');
    };
    assert.match(attempt('/does-not-exist').message, /\(ERR_SOURCE\)/);
    assert.match(attempt(os.tmpdir()).message, /\(ERR_SOURCE\)/);
    withLog('ordinary log', (source, dir) => {
      assert.strictEqual(
        attempt(
          source,
          testEnv({
            START_SENSITIVE_DATA_SANITIZER: path.join(dir, 'missing'),
          })
        ).code,
        'ERR_UNAVAILABLE'
      );
      if (process.platform !== 'win32') {
        const failing = path.join(dir, 'failing-sanitizer');
        fs.writeFileSync(
          failing,
          '#!/bin/sh\necho "secret-from-stderr (ERR_WORKER)" >&2\nexit 2\n',
          { mode: 0o755 }
        );
        const error = attempt(
          source,
          testEnv({ START_SENSITIVE_DATA_SANITIZER: failing })
        );
        assert.strictEqual(
          error.message,
          'Log sanitization failed (ERR_WORKER); upload blocked.'
        );
        // A sanitizer that succeeds without writing the output blocks too.
        fs.writeFileSync(failing, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        assert.strictEqual(
          attempt(source, testEnv({ START_SENSITIVE_DATA_SANITIZER: failing }))
            .code,
          'ERR_OUTPUT'
        );
      }
    });
    assert.throws(
      () =>
        sanitizeText('x', {
          env: testEnv({ START_SENSITIVE_DATA_SANITIZER: '/does-not-exist' }),
        }),
      /^Error: Text sanitization failed \(ERR_UNAVAILABLE\); publication blocked\.$/
    );
    const after = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('start-sanitized-')).length;
    assert.ok(after <= before);
  });

  it('blocks both upload paths on read or write failure and does not expose exception text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-errors-'));
    const source = path.join(dir, 'source.log');
    fs.writeFileSync(source, 'ordinary log');
    // A fake uploader, so a regression can never publish the log for real.
    const uploaded = path.join(dir, 'uploaded');
    fs.writeFileSync(
      path.join(dir, 'gh-upload-log'),
      `#!/bin/sh\ntouch "${uploaded}"\necho https://gist.github.com/test/id\n`,
      { mode: 0o755 }
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    const { uploadLogPath } = require('../src/lib/log-uploader');
    const { uploadLog } = require('../src/lib/failure-handler');
    const messages = [];
    const originalLog = console.log;
    console.log = (message) => messages.push(message);
    try {
      // The sanitizer child reads and writes the files itself; start only
      // opens and checks the source.
      for (const method of ['openSync', 'fstatSync']) {
        const original = fs[method];
        fs[method] = () => {
          throw new Error('sensitive error details');
        };
        try {
          const result = uploadLogPath(source);
          assert.strictEqual(result.success, false);
          assert.strictEqual(
            result.error,
            'Log sanitization failed (ERR_SOURCE); upload blocked.'
          );
          assert.strictEqual(uploadLog(source), null);
        } finally {
          fs[method] = original;
        }
      }
      assert.ok(
        messages.every(
          (message) => !message.includes('sensitive error details')
        )
      );
      assert.ok(
        messages.includes(
          'Warning: Log sanitization failed (ERR_SOURCE); upload blocked.'
        )
      );
      assert.ok(!fs.existsSync(uploaded));
    } finally {
      console.log = originalLog;
      process.env.PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes manual and automatic uploads, explicitly requests private visibility, and cleans copies', () => {
    if (process.platform === 'win32') {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-sanitize-test-'));
    const log = path.join(dir, 'source.log');
    const line =
      "Command: gate='/tmp/hive-mind-disk-baseline-0ce9e170' http://172.18.0.2:8080/v1";
    fs.writeFileSync(log, `${line} gh` + `p_${'x'.repeat(36)}`);
    fs.writeFileSync(
      path.join(dir, 'gh-upload-log'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\ncat "$1" > "$CAPTURE_LOG"\nls -ld "$1" | cut -c1-10 > "$CAPTURE_MODE"\necho https://gist.github.com/test/id\n',
      { mode: 0o755 }
    );
    try {
      for (const kind of ['manual', 'automatic', 'optout']) {
        const script =
          kind === 'automatic'
            ? `require(${JSON.stringify(require.resolve('../src/lib/failure-handler'))}).uploadLog(process.env.SOURCE_LOG)`
            : `require(${JSON.stringify(require.resolve('../src/lib/log-uploader'))}).uploadLogPath(process.env.SOURCE_LOG, { noSanitize: ${kind === 'optout'} })`;
        execFileSync(process.execPath, ['-e', script], {
          env: testEnv({
            PATH: `${dir}${path.delimiter}${process.env.PATH}`,
            SOURCE_LOG: log,
            CAPTURE_ARGS: path.join(dir, 'args'),
            CAPTURE_LOG: path.join(dir, 'uploaded'),
            CAPTURE_MODE: path.join(dir, 'mode'),
            GH_UPLOAD_PUBLIC: 'true',
          }),
          stdio: 'pipe',
        });
        const args = fs
          .readFileSync(path.join(dir, 'args'), 'utf8')
          .trim()
          .split('\n');
        assert.strictEqual(args[1], '--private');
        assert.strictEqual(
          fs.readFileSync(path.join(dir, 'uploaded'), 'utf8'),
          kind === 'optout'
            ? fs.readFileSync(log, 'utf8')
            : `${line} [REDACTED]`
        );
        if (kind !== 'optout') {
          assert.notStrictEqual(args[0], log);
          assert.ok(!fs.existsSync(args[0]));
          assert.strictEqual(
            fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim(),
            '-rw-------'
          );
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
