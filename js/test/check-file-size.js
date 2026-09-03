#!/usr/bin/env bun
/**
 * Behaviour of `scripts/check-file-size.mjs` (issue #168).
 *
 * The 1000-line limit is a refactoring rule for this repository's own source.
 * It fired on `dev/log/issues/168/pulls/169/upstream/use-m-8.15.1-use.js` - a
 * third-party file archived verbatim as investigation evidence - and failed
 * both the JavaScript and the Rust pipeline. That is a false positive: the
 * archive cannot be refactored without destroying the evidence it preserves.
 *
 * The paths are compared with forward slashes: the checker normalises them so
 * the exclusion list matches on Windows too, where `relative()` would otherwise
 * yield `dev\\log`.
 *
 * The Rust suite mirrors these checks in `rust/tests/check_file_size.rs`.
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join, resolve } = require('path');

const script = resolve(__dirname, '..', '..', 'scripts', 'check-file-size.mjs');

/**
 * Run the checker over a throwaway tree.
 * @param {Record<string, number>} files - relative path -> line count
 * @returns {{code: number, output: string}}
 */
function runChecker(files) {
  const dir = mkdtempSync(join(tmpdir(), 'check-file-size-'));
  try {
    for (const [relativePath, lines] of Object.entries(files)) {
      const full = join(dir, relativePath);
      mkdirSync(resolve(full, '..'), { recursive: true });
      writeFileSync(full, 'const x = 1;\n'.repeat(lines));
    }
    try {
      const output = execFileSync('node', [script], {
        cwd: dir,
        encoding: 'utf8',
      });
      return { code: 0, output };
    } catch (error) {
      return {
        code: error.status,
        output: `${error.stdout || ''}${error.stderr || ''}`,
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-file-size', () => {
  it('fails on an oversized file in the repository source', () => {
    const result = runChecker({ 'scripts/huge.mjs': 1500 });
    assert.strictEqual(result.code, 1);
    assert.ok(result.output.includes('scripts/huge.mjs'));
  });

  it('passes when every file is within the limit', () => {
    const result = runChecker({ 'scripts/small.mjs': 10 });
    assert.strictEqual(result.code, 0);
    assert.ok(result.output.includes('within the line limit'));
  });

  it('ignores archived evidence under dev/log', () => {
    const result = runChecker({
      'dev/log/issues/168/pulls/169/upstream/vendored.js': 1500,
      'scripts/small.mjs': 10,
    });
    assert.strictEqual(result.code, 0);
    assert.ok(!result.output.includes('vendored.js'));
  });

  it('reports paths with forward slashes on every platform', () => {
    const result = runChecker({ 'scripts/nested/huge.mjs': 1500 });
    assert.strictEqual(result.code, 1);
    assert.ok(result.output.includes('scripts/nested/huge.mjs'));
    assert.ok(!result.output.includes('scripts\\nested'));
  });

  it('still checks Rust sources outside the archive', () => {
    const result = runChecker({ 'rust/src/huge.rs': 1500 });
    assert.strictEqual(result.code, 1);
    assert.ok(result.output.includes('rust/src/huge.rs'));
  });
});
