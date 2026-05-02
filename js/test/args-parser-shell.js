#!/usr/bin/env bun
/**
 * Unit tests for shell option in the argument parser
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { parseArgs, VALID_SHELLS } = require('../src/lib/args-parser');

describe('shell option', () => {
  it('should default shell to auto', () => {
    const result = parseArgs(['echo', 'hello']);
    assert.strictEqual(result.wrapperOptions.shell, 'auto');
  });

  it('should parse --shell bash', () => {
    const result = parseArgs([
      '--isolated',
      'docker',
      '--shell',
      'bash',
      '--',
      'npm',
      'test',
    ]);
    assert.strictEqual(result.wrapperOptions.shell, 'bash');
  });

  it('should parse --shell zsh', () => {
    const result = parseArgs([
      '--isolated',
      'docker',
      '--shell',
      'zsh',
      '--',
      'npm',
      'test',
    ]);
    assert.strictEqual(result.wrapperOptions.shell, 'zsh');
  });

  it('should parse --shell sh', () => {
    const result = parseArgs([
      '--isolated',
      'docker',
      '--shell',
      'sh',
      '--',
      'npm',
      'test',
    ]);
    assert.strictEqual(result.wrapperOptions.shell, 'sh');
  });

  it('should parse --shell auto', () => {
    const result = parseArgs([
      '--isolated',
      'docker',
      '--shell',
      'auto',
      '--',
      'npm',
      'test',
    ]);
    assert.strictEqual(result.wrapperOptions.shell, 'auto');
  });

  it('should parse --shell=value format', () => {
    const result = parseArgs([
      '--isolated',
      'docker',
      '--shell=bash',
      '--',
      'npm',
      'test',
    ]);
    assert.strictEqual(result.wrapperOptions.shell, 'bash');
  });

  it('should normalize shell to lowercase', () => {
    const result = parseArgs([
      '--isolated',
      'docker',
      '--shell',
      'BASH',
      '--',
      'npm',
      'test',
    ]);
    assert.strictEqual(result.wrapperOptions.shell, 'bash');
  });

  it('should throw error for missing shell argument', () => {
    assert.throws(() => {
      parseArgs(['--isolated', 'docker', '--shell']);
    }, /requires a shell argument/);
  });

  it('should throw error for invalid shell', () => {
    assert.throws(() => {
      parseArgs([
        '--isolated',
        'docker',
        '--shell',
        'fish',
        '--',
        'echo',
        'hi',
      ]);
    }, /Invalid shell/);
  });

  it('should list valid shells in error message', () => {
    try {
      parseArgs([
        '--isolated',
        'docker',
        '--shell',
        'invalid',
        '--',
        'echo',
        'test',
      ]);
      assert.fail('Should have thrown an error');
    } catch (err) {
      for (const shell of VALID_SHELLS) {
        assert.ok(err.message.includes(shell), `Error should mention ${shell}`);
      }
    }
  });

  it('should work with ssh isolation', () => {
    const result = parseArgs([
      '--isolated',
      'ssh',
      '--endpoint',
      'user@host',
      '--shell',
      'bash',
      '--',
      'echo',
      'hi',
    ]);
    assert.strictEqual(result.wrapperOptions.shell, 'bash');
    assert.strictEqual(result.wrapperOptions.isolated, 'ssh');
  });
});

describe('VALID_SHELLS', () => {
  it('should include bash', () => {
    assert.ok(VALID_SHELLS.includes('bash'));
  });

  it('should include zsh', () => {
    assert.ok(VALID_SHELLS.includes('zsh'));
  });

  it('should include sh', () => {
    assert.ok(VALID_SHELLS.includes('sh'));
  });

  it('should include auto', () => {
    assert.ok(VALID_SHELLS.includes('auto'));
  });
});
