// Finite real-Docker check: tiny commands, 256 MiB hard cap, no stress load.
// Run from the repository root with: bun experiments/issue-236/docker-smoke.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const edition = process.argv[2] || 'js';
assert.ok(['js', 'rust'].includes(edition));
const images = new Set();
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'reservation-236-'));
const session = `reservation-236-${process.pid}`;
const env = {
  ...process.env,
  START_APP_FOLDER: state,
  START_SNAPSHOT_LOCK: path.join(state, 'snapshot.lock'),
  START_DISABLE_AUTO_ISSUE: '1',
  START_DISABLE_LOG_UPLOAD: '1',
};
const containers = new Set([session]);
function run(program, argv, allowFailure = false) {
  const result = spawnSync(program, argv, { cwd: root, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (!allowFailure)
    assert.equal(
      result.status,
      0,
      `${program}: ${result.stdout}\n${result.stderr}`
    );
  return result;
}
function cli(argv) {
  return edition === 'rust'
    ? run(path.join(root, 'rust/target/release/start'), argv)
    : run(process.execPath, [path.join(root, 'js/src/bin/cli.js'), ...argv]);
}
function status(id) {
  return JSON.parse(cli(['--status', id, '--output-format', 'json']).stdout);
}
function waitForExit(name) {
  assert.equal(run('docker', ['wait', name]).stdout.trim(), '0');
}
function inspect(name) {
  const config = JSON.parse(
    run('docker', ['inspect', '--format', '{{json .HostConfig}}', name]).stdout
  );
  assert.equal(config.Memory, 268435456);
  assert.equal(config.MemoryReservation, 67108864);
}
try {
  console.log(
    cli([
      '--isolated',
      'docker',
      '--detached',
      '--image',
      'alpine:3.20',
      '--keep-container',
      '--session',
      session,
      '--memory',
      '256m',
      '--memory-reservation',
      '64m',
      '--',
      'echo',
      'hi',
    ]).stdout
  );
  waitForExit(session);
  inspect(session);
  const record = status(session);
  assert.equal(record.options.resourceLimitSpecs.memoryReservation, '64m');
  assert.equal(record.options.resolvedLimits.memoryReservation, 67108864);
  console.log(`Launch/status verified for ${record.uuid}`);
  console.log(cli(['--resume', record.uuid]).stdout);
  waitForExit(session);
  inspect(session);
  console.log(
    cli([
      '--resume',
      record.uuid,
      '--label',
      'issue236=snapshot',
      '--',
      'echo',
      'resumed',
    ]).stdout
  );
  const resumed = status(record.uuid);
  containers.add(resumed.options.sessionName);
  waitForExit(resumed.options.sessionName);
  inspect(resumed.options.sessionName);
  const image = run('docker', [
    'inspect',
    '--format',
    '{{index .Config.Labels "start-command.snapshot-image"}}',
    resumed.options.sessionName,
  ]).stdout.trim();
  if (image) images.add(image);
  assert.equal(resumed.options.resolvedLimits.memoryReservation, 67108864);
  console.log('Snapshot resume retains 64 MiB reservation under 256 MiB cap');
} finally {
  for (const name of containers) run('docker', ['rm', '-f', name], true);
  for (const image of images) run('docker', ['image', 'rm', image], true);
  fs.rmSync(state, { recursive: true, force: true });
}
