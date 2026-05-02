#!/usr/bin/env bun
/**
 * Unit tests for failure-handler module
 * Tests pure functions: parseGitUrl and handleFailure early-exit behavior
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { parseGitUrl, handleFailure } = require('../src/lib/failure-handler');

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
