#!/usr/bin/env node
/** Bounded real-Docker reproduction: no stress allocation, 120s command ceiling. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { runInDocker, buildDockerRuntimeMetadata } = require('../js/src/lib/isolation');
const { ExecutionRecord, ExecutionStore } = require('../js/src/lib/execution-store');
const { runCommand } = require('../js/src/lib/execution-control');
const { resumeExecution } = require('../js/src/lib/execution-resume');
const { buildDetachedDockerCompletionScript, DOCKER_CONTAINER_CLEANUP_POLICY } = require('../js/src/lib/docker-cleanup');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-198-smoke-'));
const suffix = randomUUID().slice(0, 8);
const sessions = [`start-198-handoff-${suffix}`, `start-198-legacy-${suffix}`];
const image = process.env.START_SMOKE_IMAGE || 'alpine:3.23';
const limits = process.env.START_SMOKE_LIMITS ? JSON.parse(process.env.START_SMOKE_LIMITS) : [];
const bounded = (command) => `ulimit -v 131072; ${command}`;
const calls = [];
const generatedImages = [];
const store = new ExecutionStore({ appFolder: dir, useLinks: false });
const runner = (bin, args) => { calls.push([bin, ...args]); return runCommand(bin, args); };
function docker(args) {
  const result = runner('docker', args);
  assert.equal(result.success, true, `${args.join(' ')}: ${result.stderr || result.error}`);
  return result.stdout.trim();
}
function savedRecord(name, command, containerId, handoff) {
  const record = new ExecutionRecord({ uuid: randomUUID(), command, status: 'executed', exitCode: 137,
    options: { isolated: 'docker', isolationMode: 'detached',
      ...buildDockerRuntimeMetadata({ image, detached: true, resourceLimits: limits, keepContainer: true }),
      sessionName: name, containerId, commandHandoff: handoff } });
  store.save(record);
  return record;
}
async function replace(record, command, removeOriginal = false) {
  const result = await resumeExecution(store, record.uuid, {
    command: bounded(command), removeOriginal, runner, startWatcher: () => true, outputFormat: 'json',
  });
  assert.equal(result.success, true, result.error);
  return JSON.parse(result.output);
}
async function fileAppears(name, file) {
  for (let attempts = 0; attempts < 30; attempts++) {
    if (runner('docker', ['exec', name, 'test', '-f', file]).success) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Container ${name} did not create ${file}`);
}
(async () => {
  const results = { image, limits, commandMemoryLimitKiB: 131072, commandDurationCeilingSeconds: 120, checkedAt: new Date().toISOString() };
  try {
    const original = bounded('printf preserved > /root/kept; sleep 120');
    const launch = await runInDocker(original, { image, session: sessions[0], detached: true,
      keepContainer: true, resourceLimits: limits, deferCompletionWatcher: true, shell: 'sh' });
    assert.equal(launch.success, true, launch.message);
    await fileAppears(sessions[0], '/root/kept');
    const originalId = docker(['inspect', '-f', '{{.Id}}', sessions[0]]);
    const record = savedRecord(sessions[0], original, originalId, true);
    docker(['kill', sessions[0]]);
    const before = calls.length;
    const first = await replace(record, 'test "$(cat /root/kept)" = preserved; printf replaced > /root/replaced; sleep 120');
    await fileAppears(sessions[0], '/root/replaced');
    assert.equal(first.mode, 'docker-start');
    assert.equal(docker(['inspect', '-f', '{{.Id}}', sessions[0]]), originalId);
    assert.ok(!calls.slice(before).some((call) => ['commit', 'run', 'create'].includes(call[1])));
    results.handoff = { mode: first.mode, sameContainerId: true, preservedFilesystem: true, snapshotCommands: 0 };

    const legacyId = docker(['run', '-d', '--name', sessions[1], ...limits, image, 'sh', '-c', original]);
    await fileAppears(sessions[1], '/root/kept');
    const legacy = savedRecord(sessions[1], original, legacyId, false);
    docker(['kill', sessions[1]]);
    const second = await replace(legacy, 'test "$(cat /root/kept)" = preserved; printf snapshot > /root/snapshot; sleep 120', true);
    sessions.push(second.sessionName);
    generatedImages.push(second.snapshotImage);
    assert.equal(second.mode, 'docker-snapshot');
    assert.ok(!runner('docker', ['inspect', sessions[1]]).success);
    await fileAppears(second.sessionName, '/root/snapshot');
    const snapshotId = docker(['inspect', '-f', '{{.Id}}', second.sessionName]);
    docker(['kill', second.sessionName]);
    const third = await replace(store.get(legacy.uuid), 'test -f /root/snapshot; printf upgraded > /root/upgraded; sleep 120');
    assert.equal(third.mode, 'docker-start');
    await fileAppears(third.sessionName, '/root/upgraded');
    assert.equal(docker(['inspect', '-f', '{{.Id}}', third.sessionName]), snapshotId);
    docker(['kill', third.sessionName]);
    const watcher = spawnSync('sh', ['-c', buildDetachedDockerCompletionScript(third.sessionName, DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS, null)], { encoding: 'utf8' });
    assert.equal(watcher.status, 0, watcher.stderr);
    assert.ok(!runner('docker', ['inspect', third.sessionName]).success);
    assert.ok(!runner('docker', ['image', 'inspect', second.snapshotImage]).success);
    results.legacy = { mode: second.mode, originalRemoved: true, snapshotPreflight: second.message,
      successorSupportsHandoff: true, snapshotImageRemovedByWatcher: true };
    results.dockerCalls = calls.map((call) => call.slice(0, 2));
    const resultPath = path.join(__dirname, '../docs/case-studies/issue-198/data/docker-smoke-results.json');
    fs.writeFileSync(resultPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(JSON.stringify(results, null, 2));
  } finally {
    for (const name of sessions) runCommand('docker', ['rm', '-f', name]);
    for (const name of generatedImages) runCommand('docker', ['rmi', name]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
