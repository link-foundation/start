#!/usr/bin/env bun
/**
 * Unit tests for failure-handler module
 * Tests pure functions: parseGitUrl and handleFailure early-exit behavior
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseGitUrl, handleFailure } = require('../src/lib/failure-handler');

/**
 * Run `createIssue` in a child process whose PATH starts with a fake `gh`
 * recording its argv (NUL-separated). A child process is required because the
 * runtime resolves PATH at startup, so mutating `process.env.PATH` in-process
 * does not affect command lookup under Bun.
 */
function createIssueWithFakeGh(fullCommand) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
  try {
    const argvFile = path.join(dir, 'argv');
    const ghPath = path.join(dir, 'gh');
    fs.writeFileSync(
      ghPath,
      [
        '#!/bin/sh',
        `printf '%s\\0' "$@" > "${argvFile}"`,
        'echo https://github.com/owner/repo/issues/1',
        '',
      ].join('\n')
    );
    fs.chmodSync(ghPath, 0o755);

    const modulePath = require.resolve('../src/lib/failure-handler');
    const script = `
      const { createIssue } = require(${JSON.stringify(modulePath)});
      const repo = { owner: 'owner', repo: 'repo', url: 'https://github.com/owner/repo' };
      process.stdout.write(
        String(createIssue(repo, ${JSON.stringify(fullCommand)}, 1, null))
      );
    `;
    const result = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      },
    });
    const argv = fs.readFileSync(argvFile, 'utf8').split('\0').slice(0, -1);
    return { result, argv };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('failure-handler', () => {
  describe('parseGitUrl', () => {
    it('should parse HTTPS GitHub URL', () => {
      const result = parseGitUrl('https://github.com/owner/my-repo');
      assert.ok(result !== null);
      assert.strictEqual(result.owner, 'owner');
      assert.strictEqual(result.repo, 'my-repo');
      assert.strictEqual(result.url, 'https://github.com/owner/my-repo');
    });

    it('should parse HTTPS URL with .git suffix', () => {
      const result = parseGitUrl('https://github.com/owner/my-repo.git');
      assert.ok(result !== null);
      assert.strictEqual(result.owner, 'owner');
      assert.strictEqual(result.repo, 'my-repo');
      assert.strictEqual(result.url, 'https://github.com/owner/my-repo');
    });

    it('should parse SSH git@ URL', () => {
      const result = parseGitUrl('git@github.com:owner/my-repo.git');
      assert.ok(result !== null);
      assert.strictEqual(result.owner, 'owner');
      assert.strictEqual(result.repo, 'my-repo');
    });

    it('should parse git+https URL format', () => {
      const result = parseGitUrl('git+https://github.com/owner/repo.git');
      assert.ok(result !== null);
      assert.strictEqual(result.owner, 'owner');
      assert.strictEqual(result.repo, 'repo');
    });

    it('should return null for empty string', () => {
      const result = parseGitUrl('');
      assert.strictEqual(result, null);
    });

    it('should return null for null/undefined input', () => {
      assert.strictEqual(parseGitUrl(null), null);
      assert.strictEqual(parseGitUrl(undefined), null);
    });

    it('should return null for non-github URL', () => {
      const result = parseGitUrl('https://gitlab.com/owner/repo');
      assert.strictEqual(result, null);
    });

    it('should return null for invalid/random string', () => {
      const result = parseGitUrl('not-a-url-at-all');
      assert.strictEqual(result, null);
    });

    it('should normalize URL to https://github.com format', () => {
      const result = parseGitUrl('git@github.com:myorg/myrepo');
      assert.ok(result !== null);
      assert.ok(result.url.startsWith('https://github.com/'));
    });

    it('should handle URL with subdirectory (only owner/repo captured)', () => {
      const result = parseGitUrl('https://github.com/myorg/myrepo/issues');
      assert.ok(result !== null);
      assert.strictEqual(result.owner, 'myorg');
      assert.strictEqual(result.repo, 'myrepo');
    });

    it('should return object with owner, repo, url keys', () => {
      const result = parseGitUrl('https://github.com/test/project');
      assert.ok(result !== null);
      assert.ok(Object.prototype.hasOwnProperty.call(result, 'owner'));
      assert.ok(Object.prototype.hasOwnProperty.call(result, 'repo'));
      assert.ok(Object.prototype.hasOwnProperty.call(result, 'url'));
    });
  });

  describe('createIssue', () => {
    // Regression for issue #168: the command was interpolated into a shell
    // string and only `"` was escaped, so a backtick or $(...) in the failing
    // command ran, and every newline of the body arrived as a literal "\\n".
    const runCreateIssue = () =>
      createIssueWithFakeGh('echo "quoted" $(id) `hostname`');

    it('passes the title and body to gh as separate arguments', () => {
      if (process.platform === 'win32') {
        return; // /bin/sh stub is POSIX-only
      }
      const { result, argv } = runCreateIssue();
      assert.strictEqual(result, 'https://github.com/owner/repo/issues/1');
      assert.deepStrictEqual(argv.slice(0, 4), [
        'issue',
        'create',
        '--repo',
        'owner/repo',
      ]);
      assert.strictEqual(argv[4], '--title');
      assert.strictEqual(argv[6], '--body');
      assert.strictEqual(argv.length, 8);
    });

    it('keeps the failing command verbatim and does not escape it', () => {
      if (process.platform === 'win32') {
        return;
      }
      const { argv } = runCreateIssue();
      const [title, body] = [argv[5], argv[7]];
      assert.ok(
        title.includes('echo "quoted" $(id) `hostname`'),
        `title must quote the command verbatim, got: ${title}`
      );
      assert.ok(
        body.includes('echo "quoted" $(id) `hostname`'),
        'body must quote the command verbatim'
      );
      assert.ok(
        !title.includes('\\"'),
        'title must not contain escaped quotes'
      );
      assert.ok(!body.includes('\\"'), 'body must not contain escaped quotes');
    });

    it('writes real newlines into the issue body', () => {
      if (process.platform === 'win32') {
        return;
      }
      const { argv } = runCreateIssue();
      const body = argv[7];
      assert.ok(body.includes('\n'), 'body must contain real newlines');
      assert.ok(
        !body.includes('\\n'),
        'body must not contain literal backslash-n sequences'
      );
    });
  });

  describe('handleFailure', () => {
    it('should return early when disableAutoIssue is true', () => {
      // This should not throw and should return without calling external processes
      const config = { disableAutoIssue: true };
      // If it tries to call external tools, it would either throw or hang;
      // returning cleanly means the early-exit path was taken.
      assert.doesNotThrow(() => {
        handleFailure(config, 'someCmd', 'someCmd --flag', 1, '/tmp/fake.log');
      });
    });

    it('should return early when disableAutoIssue is true (verbose mode)', () => {
      const config = { disableAutoIssue: true, verbose: true };
      assert.doesNotThrow(() => {
        handleFailure(config, 'cmd', 'cmd arg', 2, '/tmp/fake.log');
      });
    });
  });
});
