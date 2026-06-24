#!/usr/bin/env bun

const { describe, it } = require('node:test');
const assert = require('assert');
const { parseArgs } = require('../src/lib/args-parser');

function parseDocker(args = []) {
  return parseArgs([
    '--isolated',
    'docker',
    '--image',
    'alpine',
    ...args,
    '--',
    'npm',
    'test',
  ]);
}

describe('docker container cleanup options', () => {
  it('should parse --auto-remove-docker-container flag', () => {
    const result = parseDocker(['--auto-remove-docker-container']);
    assert.strictEqual(result.wrapperOptions.autoRemoveDockerContainer, true);
  });

  it('should parse --always-cleanup-container flag', () => {
    const result = parseDocker(['--always-cleanup-container']);
    assert.strictEqual(result.wrapperOptions.alwaysCleanupContainer, true);
  });

  it('should parse --keep-container flag', () => {
    const result = parseDocker(['--keep-container']);
    assert.strictEqual(result.wrapperOptions.keepContainer, true);
  });

  it('should parse --keep-container-on-fail flag', () => {
    const result = parseDocker(['--keep-container-on-fail']);
    assert.strictEqual(result.wrapperOptions.keepContainerOnFail, true);
  });

  it('should default cleanup flags to false', () => {
    const result = parseDocker();
    assert.strictEqual(result.wrapperOptions.autoRemoveDockerContainer, false);
    assert.strictEqual(result.wrapperOptions.alwaysCleanupContainer, false);
    assert.strictEqual(result.wrapperOptions.keepContainer, false);
    assert.strictEqual(result.wrapperOptions.keepContainerOnFail, false);
  });

  it('should throw error for docker cleanup options without docker isolation', () => {
    assert.throws(() => {
      parseArgs([
        '-i',
        'tmux',
        '--auto-remove-docker-container',
        '--',
        'npm',
        'test',
      ]);
    }, /--auto-remove-docker-container option is only valid when isolation stack includes docker/);
    assert.throws(() => {
      parseArgs([
        '-i',
        'tmux',
        '--always-cleanup-container',
        '--',
        'npm',
        'test',
      ]);
    }, /--always-cleanup-container option is only valid when isolation stack includes docker/);
    assert.throws(() => {
      parseArgs(['-i', 'tmux', '--keep-container', '--', 'npm', 'test']);
    }, /--keep-container option is only valid when isolation stack includes docker/);
    assert.throws(() => {
      parseArgs([
        '-i',
        'tmux',
        '--keep-container-on-fail',
        '--',
        'npm',
        'test',
      ]);
    }, /--keep-container-on-fail option is only valid when isolation stack includes docker/);
  });

  it('should throw error for docker cleanup options without isolation', () => {
    assert.throws(() => {
      parseArgs(['--auto-remove-docker-container', '--', 'npm', 'test']);
    }, /--auto-remove-docker-container option is only valid when isolation stack includes docker/);
    assert.throws(() => {
      parseArgs(['--always-cleanup-container', '--', 'npm', 'test']);
    }, /--always-cleanup-container option is only valid when isolation stack includes docker/);
    assert.throws(() => {
      parseArgs(['--keep-container', '--', 'npm', 'test']);
    }, /--keep-container option is only valid when isolation stack includes docker/);
    assert.throws(() => {
      parseArgs(['--keep-container-on-fail', '--', 'npm', 'test']);
    }, /--keep-container-on-fail option is only valid when isolation stack includes docker/);
  });

  it('should work with keep-alive and auto-remove-docker-container', () => {
    const result = parseArgs([
      '-i',
      'docker',
      '--image',
      'node:20',
      '-k',
      '--auto-remove-docker-container',
      '--',
      'npm',
      'test',
    ]);
    assert.strictEqual(result.wrapperOptions.isolated, 'docker');
    assert.strictEqual(result.wrapperOptions.image, 'node:20');
    assert.strictEqual(result.wrapperOptions.keepAlive, true);
    assert.strictEqual(result.wrapperOptions.autoRemoveDockerContainer, true);
  });

  it('should reject conflicting docker cleanup options', () => {
    assert.throws(() => {
      parseArgs([
        '-i',
        'docker',
        '--keep-container',
        '--always-cleanup-container',
        '--',
        'npm',
        'test',
      ]);
    }, /Cannot combine docker container cleanup policies/);

    assert.throws(() => {
      parseArgs([
        '-i',
        'docker',
        '--keep-container',
        '--keep-container-on-fail',
        '--',
        'npm',
        'test',
      ]);
    }, /Cannot combine docker container cleanup policies/);
  });
});
