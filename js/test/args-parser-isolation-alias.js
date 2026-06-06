#!/usr/bin/env bun
/**
 * Regression tests for --isolation alias handling and unknown wrapper options.
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { parseArgs } = require('../src/lib/args-parser');

describe('parseArgs --isolation alias', () => {
  it('should parse --isolation alias with value', () => {
    const result = parseArgs(['--isolation', 'docker', '--', 'echo', 'hi']);
    assert.strictEqual(result.wrapperOptions.isolated, 'docker');
    assert.strictEqual(result.command, 'echo hi');
  });

  it('should parse --isolation=value alias format', () => {
    const result = parseArgs(['--isolation=screen', '--', 'ls', '-la']);
    assert.strictEqual(result.wrapperOptions.isolated, 'screen');
  });

  it('should parse --isolation alias before command without separator', () => {
    const result = parseArgs(['--isolation', 'docker', 'echo', 'hi']);
    assert.strictEqual(result.wrapperOptions.isolated, 'docker');
    assert.strictEqual(result.command, 'echo hi');
  });
});

describe('parseArgs unknown wrapper options', () => {
  it('should throw for unknown wrapper option before separator', () => {
    assert.throws(() => {
      parseArgs(['--unknown-wrapper', 'value', '--', 'echo', 'hi']);
    }, /Unknown wrapper option: --unknown-wrapper/);
  });

  it('should throw for unknown wrapper option without separator', () => {
    assert.throws(() => {
      parseArgs(['--unknown-wrapper', 'value', 'echo', 'hi']);
    }, /Unknown wrapper option: --unknown-wrapper/);
  });
});
