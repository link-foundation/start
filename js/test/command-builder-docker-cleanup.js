#!/usr/bin/env bun

const { describe, it } = require('node:test');
const assert = require('assert');
const { buildNextLevelCommand } = require('../src/lib/command-builder');

describe('command-builder docker cleanup forwarding', () => {
  it('forwards cleanup policy flags when a remaining level uses docker', () => {
    const command = buildNextLevelCommand(
      {
        isolatedStack: ['tmux', 'docker'],
        imageStack: [null, 'alpine'],
        keepContainerOnFail: true,
      },
      'npm test'
    );

    assert.match(command, /--isolated "docker"/);
    assert.match(command, /--keep-container-on-fail/);
  });

  it('does not forward docker cleanup flags after the docker level is consumed', () => {
    const command = buildNextLevelCommand(
      {
        isolatedStack: ['docker', 'tmux'],
        imageStack: ['alpine', null],
        keepContainer: true,
      },
      'npm test'
    );

    assert.match(command, /--isolated "tmux"/);
    assert.doesNotMatch(command, /--keep-container/);
  });
});
