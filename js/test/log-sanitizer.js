#!/usr/bin/env bun
const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  sanitizeLogToTemp,
  StreamingSanitizer,
} = require('../src/lib/log-sanitizer');

function credentials() {
  return [
    ...'pousr'.split('').map((kind) => `gh${kind}_${'a'.repeat(36)}`),
    `github_` + `pat_${'b'.repeat(82)}`,
    `sk-${'c'.repeat(48)}`,
    `sk-` + `proj-${'d'.repeat(90)}`,
    `sk-` + `ant-api03-${'e'.repeat(90)}`,
    `AK` + `IA${'F'.repeat(16)}`,
    `AS` + `IA${'G'.repeat(16)}`,
    'ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    'Authorization: Bearer arbitrary-credential',
    'Proxy-Authorization: Basic encoded-credential',
    'https://user:password@example.test/repo.git',
    'AWS_SECRET_ACCESS_KEY=arbitrary-aws-secret',
    'custom-secret-value',
    `${Buffer.from(' \n{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.signature`,
  ];
}

function sanitize(input, blockSize) {
  const sanitizer = new StreamingSanitizer({
    START_TEST_SECRET: 'custom-secret-value',
  });
  const blocks = [];
  for (let offset = 0; offset < input.length; offset += blockSize) {
    blocks.push(sanitizer.push(input.subarray(offset, offset + blockSize)));
  }
  blocks.push(sanitizer.push(Buffer.alloc(0), true));
  return Buffer.concat(blocks);
}

describe('log sanitization', () => {
  it('redacts required formats and environment values at every chunk boundary', () => {
    const secrets = credentials();
    for (const size of [1, 7, 31, 256, 1024, 65536]) {
      const input = Buffer.from(
        `ordinary utf8: café 😀\n${' '.repeat(Math.max(0, size - 43))}${secrets.join('\n')}\n${'padding\n'.repeat(400)}finished\n`
      );
      const output = sanitize(input, size).toString();
      for (const secret of secrets) {
        assert.ok(!output.includes(secret));
      }
      for (const value of [
        'arbitrary-credential',
        'encoded-credential',
        'password',
        'arbitrary-aws-secret',
      ]) {
        assert.ok(!output.includes(value));
      }
      assert.ok(output.startsWith('ordinary utf8: café 😀\n'));
      assert.ok(output.endsWith('\nfinished\n'));
    }
  });

  it('bounds memory for long tokens and authorization values without releasing suffixes', () => {
    for (const prefix of ['gh' + 'p_', 'Authorization: Bearer ']) {
      const sanitizer = new StreamingSanitizer({});
      let output = sanitizer.push(Buffer.from(prefix));
      for (let i = 0; i < 128; i++) {
        output = Buffer.concat([
          output,
          sanitizer.push(Buffer.alloc(16384, 97)),
        ]);
        assert.ok(sanitizer.pendingBytes <= 65536);
      }
      output = Buffer.concat([
        output,
        sanitizer.push(Buffer.from('\nordinary\n'), true),
      ]);
      assert.strictEqual(output.toString(), '[REDACTED]\nordinary\n');
    }
  });

  it('retains full header continuation when an inner token reaches the same block boundary', () => {
    const sanitizer = new StreamingSanitizer({});
    const input = Buffer.from(
      `Authorization: Bearer gh${'p_'}${'a'.repeat(131072)} trailing-private-value\nordinary\n`
    );
    const output = [];
    for (let offset = 0; offset < input.length; offset += 65536) {
      output.push(sanitizer.push(input.subarray(offset, offset + 65536)));
    }
    output.push(sanitizer.push(Buffer.alloc(0), true));
    assert.strictEqual(
      Buffer.concat(output).toString(),
      '[REDACTED]\nordinary\n'
    );
  });

  it('redacts AWS assignment values enclosed in either quote style', () => {
    const sanitizer = new StreamingSanitizer({});
    const output = sanitizer
      .push(
        Buffer.from(
          `AWS_SECRET_ACCESS_KEY="quoted-aws-secret"\nAWS_SESSION_TOKEN='quoted-session-value'\n`
        ),
        true
      )
      .toString();
    assert.ok(!output.includes('quoted-aws-secret'));
    assert.ok(!output.includes('quoted-session-value'));
  });

  it('redacts multiline and short known secrets, preserving unrelated bytes', () => {
    const sanitizer = new StreamingSanitizer({
      GH_TOKEN: 'abc\nxyz',
      TEST_PASSWORD: '!',
    });
    const output = sanitizer
      .push(Buffer.from('safe abc\nxyz value !'), true)
      .toString();
    assert.strictEqual(output, 'safe [REDACTED] value [REDACTED]');
  });

  it('merges overlapping environment secrets and preserves ordinary domain names', () => {
    const sanitizer = new StreamingSanitizer({
      GH_TOKEN: 'abcde',
      TEST_PASSWORD: 'cdefg',
      GITHUB_PAT: 'opaque-known-pat',
    });
    assert.strictEqual(
      sanitizer
        .push(
          Buffer.from('abcdefg opaque-known-pat example.test.invalid'),
          true
        )
        .toString(),
      '[REDACTED] [REDACTED] example.test.invalid'
    );
    const short = new StreamingSanitizer({ GH_TOKEN: 'a' });
    assert.strictEqual(
      short.push(Buffer.alloc(65536, 97), true).toString(),
      '[REDACTED]'
    );
  });

  it('creates a private sanitized copy and removes it without changing the source', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-test-'));
    const source = path.join(dir, 'source.log');
    const input = `gh` + `p_${'x'.repeat(36)}`;
    fs.writeFileSync(source, input);
    try {
      const copy = sanitizeLogToTemp(source, { env: {} });
      assert.notStrictEqual(copy.path, source);
      assert.strictEqual(fs.readFileSync(copy.path, 'utf8'), '[REDACTED]');
      if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(copy.path).mode & 0o777, 0o600);
        assert.strictEqual(
          fs.statSync(path.dirname(copy.path)).mode & 0o777,
          0o700
        );
      }
      assert.strictEqual(fs.readFileSync(source, 'utf8'), input);
      copy.cleanup();
      assert.ok(!fs.existsSync(copy.path));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on invalid source and excessive environment secret sizes', () => {
    assert.throws(
      () => sanitizeLogToTemp('/does-not-exist', { env: {} }),
      /sanitization failed/i
    );
    assert.throws(
      () => new StreamingSanitizer({ GH_TOKEN: 'a'.repeat(65537) }),
      /too large/i
    );
  });

  it('blocks both upload paths on read or write failure and does not expose exception text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-errors-'));
    const source = path.join(dir, 'source.log');
    fs.writeFileSync(source, 'ordinary log');
    const { uploadLogPath } = require('../src/lib/log-uploader');
    const { uploadLog } = require('../src/lib/failure-handler');
    const messages = [];
    const originalLog = console.log;
    console.log = (message) => messages.push(message);
    try {
      for (const method of ['readSync', 'writeSync', 'fsyncSync']) {
        const original = fs[method];
        fs[method] = () => {
          throw new Error('sensitive error details');
        };
        try {
          assert.strictEqual(uploadLogPath(source).success, false);
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
    } finally {
      console.log = originalLog;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes manual and automatic uploads, explicitly requests private visibility, and cleans copies', () => {
    if (process.platform === 'win32') {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-sanitize-test-'));
    const log = path.join(dir, 'source.log');
    fs.writeFileSync(log, `gh` + `p_${'x'.repeat(36)}`);
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
          env: {
            ...process.env,
            PATH: `${dir}${path.delimiter}${process.env.PATH}`,
            SOURCE_LOG: log,
            CAPTURE_ARGS: path.join(dir, 'args'),
            CAPTURE_LOG: path.join(dir, 'uploaded'),
            CAPTURE_MODE: path.join(dir, 'mode'),
            GH_UPLOAD_PUBLIC: 'true',
          },
          stdio: 'pipe',
        });
        const args = fs
          .readFileSync(path.join(dir, 'args'), 'utf8')
          .trim()
          .split('\n');
        assert.strictEqual(args[1], '--private');
        assert.strictEqual(
          fs.readFileSync(path.join(dir, 'uploaded'), 'utf8'),
          kind === 'optout' ? fs.readFileSync(log, 'utf8') : '[REDACTED]'
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
