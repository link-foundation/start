#!/usr/bin/env bun

const { describe, it } = require('node:test');
const assert = require('assert');
const { parseArgs } = require('../src/lib/args-parser');

describe('control options', () => {
  it('should parse --stop with UUID or session name', () => {
    const result = parseArgs(['--stop', 'my-session']);
    assert.strictEqual(result.wrapperOptions.stop, 'my-session');
    assert.strictEqual(result.command, '');
  });

  it('should parse --stop=value format', () => {
    const result = parseArgs(['--stop=my-session']);
    assert.strictEqual(result.wrapperOptions.stop, 'my-session');
  });

  it('should parse --terminate with UUID or session name', () => {
    const result = parseArgs(['--terminate', 'my-session']);
    assert.strictEqual(result.wrapperOptions.terminate, 'my-session');
    assert.strictEqual(result.command, '');
  });

  it('should parse --terminate=value format', () => {
    const result = parseArgs(['--terminate=my-session']);
    assert.strictEqual(result.wrapperOptions.terminate, 'my-session');
  });

  it('should throw error for missing --stop argument', () => {
    assert.throws(() => {
      parseArgs(['--stop']);
    }, /requires a UUID or session name argument/);
  });

  it('should throw error for empty --stop=value argument', () => {
    assert.throws(() => {
      parseArgs(['--stop=']);
    }, /requires a UUID or session name argument/);
  });

  it('should throw error for missing --terminate argument', () => {
    assert.throws(() => {
      parseArgs(['--terminate']);
    }, /requires a UUID or session name argument/);
  });

  it('should throw error for empty --terminate=value argument', () => {
    assert.throws(() => {
      parseArgs(['--terminate=']);
    }, /requires a UUID or session name argument/);
  });

  it('should reject combining query and control modes', () => {
    assert.throws(() => {
      parseArgs(['--status', 'uuid-here', '--stop', 'my-session']);
    }, /Cannot combine --status, --list, --upload-log, --stop, --terminate, or --cleanup/);
  });

  it('should reject combining upload-log with control modes', () => {
    assert.throws(() => {
      parseArgs(['--upload-log', 'uuid-here', '--terminate', 'my-session']);
    }, /Cannot combine --status, --list, --upload-log, --stop, --terminate, or --cleanup/);
  });

  it('should reject output-format with control modes', () => {
    assert.throws(() => {
      parseArgs(['--stop', 'my-session', '--output-format', 'json']);
    }, /--output-format option is only valid with --status or --list/);
  });

  it('should default control options to null', () => {
    const result = parseArgs(['echo', 'hello']);
    assert.strictEqual(result.wrapperOptions.stop, null);
    assert.strictEqual(result.wrapperOptions.terminate, null);
  });
});
