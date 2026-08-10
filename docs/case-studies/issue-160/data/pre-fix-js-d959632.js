#!/usr/bin/env bun
/** Real-daemon integration coverage for Docker network isolation (issues #154, #156). */

const { after, before, describe, it } = require('node:test');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const { runInDocker } = require('../src/lib/isolation');

const suffix = randomUUID().slice(0, 8);
const network = `start-network-${suffix}`;
const sidecar = `start-sidecar-${suffix}`;
const connected = `start-connected-${suffix}`;
const control = `start-control-${suffix}`;
const missing = `start-missing-${suffix}`;
const missingAttached = `start-missing-attached-${suffix}`;
let dockerAvailable = false;

function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

describe('Docker named network integration', { timeout: 60000 }, () => {
  before(() => {
    dockerAvailable =
      process.platform === 'linux' && docker(['info']).status === 0;
    if (!dockerAvailable) {
      return;
    }

    const created = docker(['network', 'create', '--internal', network]);
    assert.strictEqual(created.status, 0, created.stderr);
    const started = docker([
      'run',
      '-d',
      '--name',
      sidecar,
      '--network',
      network,
      '--network-alias',
      'formal-ai',
      'alpine:3.23',
      'sleep',
      '60',
    ]);
    assert.strictEqual(started.status, 0, started.stderr);
  });

  after(() => {
    if (!dockerAvailable) {
      return;
    }
    docker(['rm', '-f', sidecar, connected, control, missing, missingAttached]);
    docker(['network', 'rm', network]);
  });

  it('reaches a private sidecar and the internet through two networks', async () => {
    if (!dockerAvailable) {
      return;
    }

    const joined = await runInDocker(
      'ping -c 1 formal-ai && wget -q --spider https://api.github.com',
      {
        image: 'alpine:3.23',
        session: connected,
        network: 'bridge',
        networks: ['bridge', network],
        detached: true,
        shell: 'sh',
        keepContainer: true,
      }
    );
    assert.strictEqual(joined.success, true, joined.message);
    const joinedExit = docker(['wait', connected]);
    assert.strictEqual(joinedExit.status, 0, joinedExit.stderr);
    assert.strictEqual(joinedExit.stdout.trim(), '0');

    const unconnected = await runInDocker('ping -c 1 formal-ai', {
      image: 'alpine:3.23',
      session: control,
      shell: 'sh',
      alwaysCleanupContainer: true,
    });
    assert.strictEqual(unconnected.success, false);
  });

  it('fails for a missing network without orphaning a container', async () => {
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
      network: 'bridge',
      networks: ['bridge', `${network}-absent`],
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
  });
});
