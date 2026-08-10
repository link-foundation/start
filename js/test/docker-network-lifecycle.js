#!/usr/bin/env bun
/**
 * Unit coverage for the Docker multi-network lifecycle helpers (issue #158).
 *
 * The verbose mode added here exists because the failing CI run gave nothing
 * but an exit code for the `docker create` -> `network connect` -> `start`
 * sequence. It must stay OFF unless START_DEBUG is explicitly set.
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const {
  debugLog,
  getDockerNetworks,
} = require('../src/lib/docker-network-lifecycle');

/** Capture everything written to console.error while `run` executes. */
function captureStderr(run) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try {
    run();
  } finally {
    console.error = original;
  }
  return lines;
}

describe('docker network lifecycle helpers', () => {
  it('returns an empty list when no network is requested', () => {
    assert.deepStrictEqual(getDockerNetworks({}), []);
    assert.deepStrictEqual(getDockerNetworks(), []);
  });

  it('wraps a single network into a list', () => {
    assert.deepStrictEqual(getDockerNetworks({ network: 'bridge' }), [
      'bridge',
    ]);
  });

  it('prefers the explicit networks list over the single network', () => {
    assert.deepStrictEqual(
      getDockerNetworks({ network: 'bridge', networks: ['a', 'b'] }),
      ['a', 'b']
    );
  });

  it('ignores an empty networks list and falls back to network', () => {
    assert.deepStrictEqual(
      getDockerNetworks({ network: 'bridge', networks: [] }),
      ['bridge']
    );
  });

  it('keeps verbose output switched off by default', () => {
    const previous = process.env.START_DEBUG;
    delete process.env.START_DEBUG;
    try {
      // The module reads START_DEBUG once at load time, and the test process
      // never sets it, so nothing may be printed.
      assert.deepStrictEqual(
        captureStderr(() => debugLog('should not appear')),
        []
      );
    } finally {
      if (previous !== undefined) {
        process.env.START_DEBUG = previous;
      }
    }
  });
});
