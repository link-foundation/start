#!/usr/bin/env bun
/** Real-daemon integration coverage for Docker network isolation (issues #154, #156, #158, #160). */

const { after, before, describe, it } = require('node:test');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const { runInDocker } = require('../src/lib/isolation');

// Bun's `node:test` shim ignores a `describe`-level timeout, so every `it`
// declares its own budget explicitly (issue #158).
const TEST_TIMEOUT = 120000;
const MULTI_NETWORK_PROBE =
  "ping -c 1 formal-ai && ping -c 1 formal-db && ip route | grep -q '^default '";

const suffix = randomUUID().slice(0, 8);
const network = `start-network-${suffix}`;
const secondNetwork = `start-network-b-${suffix}`;
const sidecar = `start-sidecar-${suffix}`;
const secondSidecar = `start-sidecar-b-${suffix}`;
const connected = `start-connected-${suffix}`;
const control = `start-control-${suffix}`;
const missing = `start-missing-${suffix}`;
const missingAttached = `start-missing-attached-${suffix}`;
let dockerAvailable = false;

function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

/**
 * Container output, folded into assertion messages so a CI failure carries the
 * evidence needed to diagnose it instead of only reporting the exit code.
 */
function containerDiagnostics(name) {
  const logs = docker(['logs', name]);
  const output = `${logs.stdout || ''}${logs.stderr || ''}`.trim();
  return `\n--- docker logs ${name} ---\n${output || '<no output>'}\n---`;
}

function createInternalNetworkWithSidecar(networkName, containerName, alias) {
  const created = docker(['network', 'create', '--internal', networkName]);
  assert.strictEqual(created.status, 0, created.stderr);
  const started = docker([
    'run',
    '-d',
    '--name',
    containerName,
    '--network',
    networkName,
    '--network-alias',
    alias,
    'alpine:3.23',
    'sleep',
    '300',
  ]);
  assert.strictEqual(started.status, 0, started.stderr);
}

describe('Docker named network integration', () => {
  before(() => {
    dockerAvailable =
      process.platform === 'linux' && docker(['info']).status === 0;
    if (!dockerAvailable) {
      return;
    }

    createInternalNetworkWithSidecar(network, sidecar, 'formal-ai');
    createInternalNetworkWithSidecar(secondNetwork, secondSidecar, 'formal-db');
  });

  after(() => {
    if (!dockerAvailable) {
      return;
    }
    docker([
      'rm',
      '-f',
      sidecar,
      secondSidecar,
      connected,
      control,
      missing,
      missingAttached,
    ]);
    docker(['network', 'rm', network, secondNetwork]);
  });

  it('keeps the multi-network probe hermetic', () => {
    assert.doesNotMatch(MULTI_NETWORK_PROBE, /https?:\/\//);
    assert.match(MULTI_NETWORK_PROBE, /formal-ai/);
    assert.match(MULTI_NETWORK_PROBE, /formal-db/);
    assert.match(MULTI_NETWORK_PROBE, /ip route/);
  });

  it(
    'reaches a private sidecar on each of two networks',
    { timeout: TEST_TIMEOUT },
    async () => {
      if (!dockerAvailable) {
        return;
      }

      // Both endpoints are local, user-defined networks on purpose: probing a
      // public endpoint (previously `https://api.github.com`) made this test
      // fail whenever the shared runner IP hit the 60 requests/hour
      // unauthenticated GitHub API rate limit. Checking the route table keeps
      // the original assertion that the default bridge route survived without
      // making the test depend on any internet service (issues #158, #160).
      const joined = await runInDocker(MULTI_NETWORK_PROBE, {
        image: 'alpine:3.23',
        session: connected,
        network: 'bridge',
        networks: ['bridge', network, secondNetwork],
        detached: true,
        shell: 'sh',
        keepContainer: true,
      });
      assert.strictEqual(joined.success, true, joined.message);
      const joinedExit = docker(['wait', connected]);
      assert.strictEqual(joinedExit.status, 0, joinedExit.stderr);
      assert.strictEqual(
        joinedExit.stdout.trim(),
        '0',
        `container did not exit cleanly${containerDiagnostics(connected)}`
      );

      const unconnected = await runInDocker('ping -c 1 formal-ai', {
        image: 'alpine:3.23',
        session: control,
        shell: 'sh',
        alwaysCleanupContainer: true,
      });
      assert.strictEqual(unconnected.success, false, unconnected.message);
    }
  );

  it(
    'fails for a missing network without orphaning a container',
    { timeout: TEST_TIMEOUT },
    async () => {
      if (!dockerAvailable) {
        return;
      }

      const result = await runInDocker('echo should-not-run', {
        image: 'alpine:3.23',
        session: missing,
        network: `${network}-absent`,
        detached: true,
        shell: 'sh',
      });
      assert.strictEqual(result.success, false);
      assert.match(result.message, /network .* not found/i);
      assert.notStrictEqual(docker(['inspect', missing]).status, 0);

      const missingSecond = await runInDocker('echo should-not-run', {
        image: 'alpine:3.23',
        session: missing,
        network,
        networks: [network, `${network}-absent`],
        detached: true,
        shell: 'sh',
      });
      assert.strictEqual(missingSecond.success, false);
      assert.match(missingSecond.message, /network .* not found/i);
      assert.notStrictEqual(docker(['inspect', missing]).status, 0);

      const attachedResult = await runInDocker('echo should-not-run', {
        image: 'alpine:3.23',
        session: missingAttached,
        network: `${network}-absent`,
        shell: 'sh',
      });
      assert.strictEqual(attachedResult.success, false);
      assert.notStrictEqual(docker(['inspect', missingAttached]).status, 0);

      const conflict = await runInDocker('echo should-not-run', {
        image: 'alpine:3.23',
        session: sidecar,
        network: `${network}-absent`,
        detached: true,
        shell: 'sh',
      });
      assert.strictEqual(conflict.success, false);
      assert.strictEqual(docker(['inspect', sidecar]).status, 0);
    }
  );
});
