#!/usr/bin/env bun
/**
 * Reproduces the flaky failure of `js/test/docker-network-integration.js`
 * ("reaches a private sidecar and the internet through two networks") seen in
 * CI run 31380353470 and captures the container logs that the test itself
 * discards, so the failing half of the command can be identified.
 *
 * Usage: bun experiments/docker-network-flake-repro.mjs [iterations]
 */

const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const { runInDocker } = require('../js/src/lib/isolation');

const docker = (args) => spawnSync('docker', args, { encoding: 'utf8' });
const iterations = Number(process.argv[2] || 20);

let failures = 0;
for (let i = 1; i <= iterations; i++) {
  const suffix = randomUUID().slice(0, 8);
  const network = `flake-net-${suffix}`;
  const sidecar = `flake-side-${suffix}`;
  const connected = `flake-conn-${suffix}`;

  docker(['network', 'create', '--internal', network]);
  docker([
    'run', '-d', '--name', sidecar, '--network', network,
    '--network-alias', 'formal-ai', 'alpine:3.23', 'sleep', '60',
  ]);

  await runInDocker(
    'set -x; ping -c 1 formal-ai && wget -q --spider https://api.github.com',
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
  const wait = docker(['wait', connected]);
  const code = wait.stdout.trim();
  const logs = docker(['logs', connected]);
  const combined = `${logs.stdout}${logs.stderr}`;
  if (code !== '0') {
    failures++;
    console.log(`--- iteration ${i}: container exit ${code} ---`);
    console.log(combined.trim());
    console.log(docker(['exec', sidecar, 'true']).status === 0 ? '(sidecar alive)' : '(sidecar dead)');
  } else {
    console.log(`iteration ${i}: ok`);
  }
  docker(['rm', '-f', sidecar, connected]);
  docker(['network', 'rm', network]);
}
console.log(`\n${failures}/${iterations} failed`);
