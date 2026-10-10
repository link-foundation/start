const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resumeExecution } = require('../src/lib/execution-resume');
const { recoverKilledExecution } = require('../src/lib/execution-recovery');
const { SessionState } = require('../src/lib/session-probe');
const {
  buildDetachedDockerCompletionScript,
  DOCKER_CONTAINER_CLEANUP_POLICY,
} = require('../src/lib/docker-cleanup');

function fixture(options = {}) {
  let current = {
    uuid: 'issue-198-uuid',
    command: 'original',
    status: 'executed',
    exitCode: 137,
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: 'box',
      containerId: 'same-id',
      ...options,
    },
  };
  const store = {
    get: () => globalThis.structuredClone(current),
    save: (r) => {
      current = globalThis.structuredClone(r);
    },
  };
  return { store, current: () => current };
}

function mockDocker(calls, scripts = []) {
  return (_bin, args) => {
    calls.push(args);
    if (args[0] === 'cp') {
      scripts.push(fs.readFileSync(args[1], 'utf8'));
    }
    return {
      success: true,
      stdout:
        args[0] === 'info'
          ? JSON.stringify({ DockerRootDir: '/docker' })
          : args.includes('--size')
            ? '1024'
            : args.includes('{{.State.Running}}')
              ? 'true'
              : args.includes('{{json .HostConfig}}')
                ? '{}'
                : args[0] === 'run'
                  ? 'new-container-id'
                  : '',
      status: 0,
    };
  };
}

const stopped = () => ({ state: SessionState.STOPPED, alive: false });

test('replacement command resumes the same container without a snapshot or changed ID', async () => {
  const { store, current } = fixture({ commandHandoff: true });
  const calls = [],
    scripts = [];
  const result = await resumeExecution(store, 'box', {
    command: "printf '%s' 'new $command'",
    probe: stopped,
    runner: mockDocker(calls, scripts),
    startWatcher: () => true,
  });
  assert.equal(result.success, true, result.error);
  assert.ok(calls.some((args) => args[0] === 'cp'));
  assert.ok(calls.some((args) => args[0] === 'start'));
  assert.ok(
    !calls.some((args) => ['commit', 'run', 'create'].includes(args[0]))
  );
  assert.equal(current().options.containerId, 'same-id');
  assert.equal(current().options.sessionName, 'box');
  assert.ok(scripts[0].includes('new $command'));
});

test('automatic recovery replaces a prior explicit handoff and exports its attempt', () => {
  const { store } = fixture({
    commandHandoff: true,
    onKillResume: 1,
    recoveryCommand: 'printf recovered',
  });
  const scripts = [];
  const result = recoverKilledExecution({
    store,
    executionId: 'issue-198-uuid',
    exitCode: 137,
    oomKilled: false,
    runner: mockDocker([], scripts),
    startWatcher: () => true,
  });
  assert.equal(result.recovered, true, result.reason);
  assert.ok(scripts[0].includes('START_COMMAND_RECOVERY_ATTEMPT=1'));
  assert.ok(scripts[0].includes('printf recovered'));
});

test('legacy snapshots preflight before commit and remove originals only with non-forced rm after start', async () => {
  const { store, current } = fixture();
  const calls = [];
  const result = await resumeExecution(store, 'box', {
    command: 'new',
    probe: stopped,
    removeOriginal: true,
    runner: mockDocker(calls),
    snapshotOptions: { freeBytes: () => 100 * 1024 ** 3 },
    startWatcher: () => true,
  });
  assert.equal(result.success, true, result.error);
  assert.ok(
    calls.findIndex((a) => a.includes('--size')) <
      calls.findIndex((a) => a[0] === 'commit')
  );
  assert.ok(
    calls.findIndex((a) => a[0] === 'run') <
      calls.findIndex((a) => a[0] === 'rm')
  );
  assert.deepEqual(
    calls.find((a) => a[0] === 'rm'),
    ['rm', 'box']
  );
  assert.equal(current().options.commandHandoff, true);
  assert.equal(current().options.snapshotImage, 'start-command-resume/box:1');
  assert.match(result.output, /snapshotting/);
});

test('disk shortage rolls back the reservation without committing or removing the original', async () => {
  const { store, current } = fixture();
  const calls = [];
  const result = await resumeExecution(store, 'box', {
    command: 'new',
    probe: stopped,
    removeOriginal: true,
    runner: mockDocker(calls),
    snapshotOptions: { freeBytes: () => 0 },
    startWatcher: () => true,
  });
  assert.equal(result.success, false);
  assert.match(result.error, /Insufficient disk/);
  assert.ok(!calls.some((a) => ['commit', 'rm', 'rmi'].includes(a[0])));
  assert.equal(current().options.sessionName, 'box');
  assert.equal(current().options.launchPending, undefined);
});

test('snapshot failure removes a completed image and restores the original execution', async () => {
  const { store, current } = fixture();
  const calls = [];
  const base = mockDocker(calls);
  const result = await resumeExecution(store, 'box', {
    command: 'new',
    probe: stopped,
    runner: (bin, args) =>
      args[0] === 'run'
        ? { success: false, stderr: 'launch failed' }
        : base(bin, args),
    snapshotOptions: { freeBytes: () => 100 * 1024 ** 3 },
    startWatcher: () => true,
  });
  assert.equal(result.success, false);
  assert.ok(
    calls.some((a) => a[0] === 'rmi' && a[1] === 'start-command-resume/box:1')
  );
  assert.equal(current().options.sessionName, 'box');
});

test('watcher removes its generated image after the cleanup policy removes its container', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-198-'));
  const docker = path.join(dir, 'docker');
  const events = path.join(dir, 'events');
  try {
    fs.writeFileSync(
      docker,
      `#!/bin/sh
case "$1" in
  wait) echo 0 ;;
  inspect) case "$3" in
    *State.Running*) echo false ;;
    *State.ExitCode*) echo '0 false 2026-10-10T00:00:00Z 2026-10-10T00:00:01Z' ;;
    *snapshot-image*) echo 'start-command-resume/box:1' ;;
    *) echo '' ;;
  esac ;;
  rm|rmi) echo "$*" >> "$TEST_EVENTS" ;;
esac
`,
      { mode: 0o755 }
    );
    const result = spawnSync(
      'sh',
      [
        '-c',
        buildDetachedDockerCompletionScript(
          'box-resume-1',
          DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS,
          null
        ),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}${path.delimiter}${process.env.PATH}`,
          TEST_EVENTS: events,
        },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(events, 'utf8').trim().split('\n'), [
      'rm -f box-resume-1',
      'rmi start-command-resume/box:1',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('changed caller labels use a guarded snapshot and reapply merged labels', async () => {
  const { store, current } = fixture({
    commandHandoff: true,
    labels: ['role=old', 'team=runtime'],
  });
  const calls = [];
  const result = await resumeExecution(store, 'box', {
    probe: stopped,
    resourceOptions: { labels: ['role=new'] },
    runner: mockDocker(calls),
    snapshotOptions: { freeBytes: () => 100 * 1024 ** 3 },
    startWatcher: () => true,
  });
  assert.equal(result.success, true, result.error);
  const run = calls.find((args) => args[0] === 'run');
  assert.ok(run.includes('role=new'));
  assert.ok(run.includes('team=runtime'));
  assert.ok(!run.includes('role=old'));
  assert.ok(calls.some((args) => args[0] === 'commit'));
  assert.deepEqual(current().options.labels, ['role=new', 'team=runtime']);
  assert.equal(current().options.commandHandoff, true);
});

test('original retained by default and when a successor has already stopped', async () => {
  for (const removeOriginal of [false, true]) {
    const { store } = fixture();
    const calls = [];
    const base = mockDocker(calls);
    const result = await resumeExecution(store, 'box', {
      command: 'new',
      probe: stopped,
      removeOriginal,
      runner: (bin, args) =>
        args.includes('{{.State.Running}}')
          ? { success: true, stdout: 'false' }
          : base(bin, args),
      snapshotOptions: { freeBytes: () => 100 * 1024 ** 3 },
      startWatcher: () => true,
    });
    assert.equal(result.success, true, result.error);
    assert.ok(!calls.some((args) => args[0] === 'rm'));
  }
});

test('repeated snapshot successors retain the original root-session attribution', async () => {
  const { store, current } = fixture();
  for (const role of ['first', 'second']) {
    const calls = [];
    const result = await resumeExecution(store, 'box', {
      command: 'new',
      probe: stopped,
      resourceOptions: { labels: [`role=${role}`] },
      runner: mockDocker(calls),
      snapshotOptions: { freeBytes: () => 100 * 1024 ** 3 },
      startWatcher: () => true,
    });
    assert.equal(result.success, true, result.error);
    assert.ok(
      calls
        .find((args) => args[0] === 'run')
        .includes('start-command.root-session=box')
    );
    assert.equal(current().options.rootSession, 'box');
  }
  assert.equal(current().options.resumeCount, 2);
});
