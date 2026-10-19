/**
 * Regression tests for issue #225: after a kept docker container was removed,
 * `$ --status` kept reporting it exactly as before — same `containerId`,
 * nothing saying the container no longer exists.
 *
 * `docker inspect` exits 1 with `No such object` / `No such container` for a
 * removed container, which used to be folded into the same `null` as a docker
 * that cannot be reached at all.
 */

const { describe, it, expect, afterEach } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ExecutionRecord,
  ExecutionStatus,
  ExecutionStore,
} = require('../src/lib/execution-store');
const { queryStatus } = require('../src/lib/status-formatter');
const {
  DOCKER_CONTAINER_CLEANUP_POLICY,
  buildDetachedDockerCompletionScript,
} = require('../src/lib/docker-cleanup');
const { finalizeDetachedExecution } = require('../src/lib/detached-finalize');
const {
  CONTAINER_STATE_REMOVED,
  isDockerNotFound,
} = require('../src/lib/container-removal');

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

// The stubs below are POSIX `sh` scripts; Windows has no `/bin/sh`.
const needsPosixShell = () => {
  if (process.platform !== 'win32') {
    return false;
  }
  console.log('  Skipping: the docker stub needs a POSIX /bin/sh');
  return true;
};

const NOT_FOUND = 'printf \'error: no such object: %s\\n\' "$4" >&2; exit 1';
const UNREACHABLE =
  "printf 'failed to connect to the docker API at unix:///var/run/docker.sock; " +
  'check if the path is correct and if the daemon is running: dial unix ' +
  "/var/run/docker.sock: connect: no such file or directory\\n' >&2; exit 1";
const EXITED = "echo 'false 1 false 2026-10-19T00:00:00Z 2026-10-19T00:00:10Z'";

/** Fake `docker` whose every `inspect` runs `inspectBody`. */
function withFakeDocker(inspectBody, fn) {
  const dir = makeTempDir('fake-docker-225-');
  const dockerPath = path.join(dir, 'docker');
  fs.writeFileSync(
    dockerPath,
    [
      '#!/bin/sh',
      `echo "$*" >> '${dir}/calls'`,
      '[ "$1" = inspect ] || exit 1',
      inspectBody,
      '',
    ].join('\n'),
    'utf8'
  );
  fs.chmodSync(dockerPath, 0o755);
  const original = process.env.START_DOCKER_BIN;
  process.env.START_DOCKER_BIN = dockerPath;
  try {
    return fn(() =>
      fs.existsSync(`${dir}/calls`)
        ? fs.readFileSync(`${dir}/calls`, 'utf8').trim().split('\n')
        : []
    );
  } finally {
    if (original === undefined) {
      delete process.env.START_DOCKER_BIN;
    } else {
      process.env.START_DOCKER_BIN = original;
    }
  }
}

function keptContainerRecord(overrides = {}) {
  return new ExecutionRecord({
    command: "sh -c 'echo working; exit 1'",
    status: ExecutionStatus.EXECUTED,
    exitCode: 1,
    startTime: '2026-10-19T00:00:00.000Z',
    endTime: '2026-10-19T00:00:10.000Z',
    endTimeSource: 'docker-finished-at',
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: 'status-removal-demo',
      containerId: 'd2a8c0ffee',
    },
    ...overrides,
  });
}

function storeWith(record) {
  const store = new ExecutionStore({
    appFolder: makeTempDir('store-225-'),
    useLinks: false,
  });
  store.save(record);
  return store;
}

function statusJson(store, id) {
  const result = queryStatus(store, id, 'json');
  expect(result.success).toBe(true);
  return JSON.parse(result.output);
}

describe('issue #225: docker not-found is told apart from docker errors', () => {
  it('recognises the not-found answers of docker inspect', () => {
    for (const stderr of [
      'error: no such object: status-removal-demo',
      'Error: No such object: status-removal-demo',
      'Error response from daemon: No such container: status-removal-demo',
    ]) {
      expect(isDockerNotFound({ status: 1, stderr })).toBe(true);
    }
  });

  it('does not read an unreachable daemon as a removed container', () => {
    for (const stderr of [
      'failed to connect to the docker API at unix:///var/run/docker.sock: connect: no such file or directory',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      '',
    ]) {
      expect(isDockerNotFound({ status: 1, stderr })).toBe(false);
    }
    expect(isDockerNotFound({ status: 0, stderr: 'No such object' })).toBe(
      false
    );
    expect(isDockerNotFound({ error: new Error('ENOENT'), status: null })).toBe(
      false
    );
  });
});

describe('issue #225: --status reports a removed container', () => {
  it('adds containerState removed and keeps containerId for history', () => {
    if (needsPosixShell()) {
      return;
    }
    const record = keptContainerRecord();
    const store = storeWith(record);
    withFakeDocker(NOT_FOUND, (calls) => {
      const status = statusJson(store, 'status-removal-demo');
      expect(status.containerState).toBe(CONTAINER_STATE_REMOVED);
      expect(
        Number.isFinite(Date.parse(status.containerRemovedObservedAt))
      ).toBe(true);
      expect(status.options.containerId).toBe('d2a8c0ffee');
      expect(status.status).toBe('executed');
      expect(status.exitCode).toBe(1);
      // Probed by id, so a later container reusing the name is not mistaken
      // for this one.
      expect(calls()).toContain('inspect -f {{.Id}} d2a8c0ffee');
    });
  });

  it('persists the observation and keeps its first time', () => {
    if (needsPosixShell()) {
      return;
    }
    const record = keptContainerRecord();
    const store = storeWith(record);
    withFakeDocker(NOT_FOUND, () => {
      const first = statusJson(store, record.uuid).containerRemovedObservedAt;
      const stored = store.get(record.uuid);
      expect(stored.containerState).toBe(CONTAINER_STATE_REMOVED);
      expect(stored.containerRemovedObservedAt).toBe(first);
      expect(statusJson(store, record.uuid).containerRemovedObservedAt).toBe(
        first
      );
    });
  });

  it('shows the removal in the links-notation and text formats', () => {
    if (needsPosixShell()) {
      return;
    }
    const store = storeWith(keptContainerRecord());
    withFakeDocker(NOT_FOUND, () => {
      const links = queryStatus(store, 'status-removal-demo', null).output;
      expect(links).toContain('  containerState removed');
      expect(links).toMatch(/\n {2}containerRemovedObservedAt \S+/);
      expect(links).toContain('    containerId d2a8c0ffee');
      const text = queryStatus(store, 'status-removal-demo', 'text').output;
      expect(text).toContain('Container State:   removed');
      expect(text).toMatch(/\nContainer Removed: \d{4}-/);
    });
  });

  it('falls back to the session name when no container id was recorded', () => {
    if (needsPosixShell()) {
      return;
    }
    const record = keptContainerRecord();
    delete record.options.containerId;
    const store = storeWith(record);
    withFakeDocker(NOT_FOUND, () => {
      expect(statusJson(store, record.uuid).containerState).toBe('removed');
    });
  });

  it('says nothing when docker cannot be reached', () => {
    if (needsPosixShell()) {
      return;
    }
    const store = storeWith(keptContainerRecord());
    withFakeDocker(UNREACHABLE, () => {
      const status = statusJson(store, 'status-removal-demo');
      expect(status.containerState).toBeUndefined();
      expect(status.containerRemovedObservedAt).toBeUndefined();
    });
    expect(store.get('status-removal-demo').containerState).toBeUndefined();
  });

  it('says nothing while the container still exists', () => {
    if (needsPosixShell()) {
      return;
    }
    const store = storeWith(keptContainerRecord());
    withFakeDocker(EXITED, () => {
      expect(
        statusJson(store, 'status-removal-demo').containerState
      ).toBeUndefined();
    });
  });

  it('leaves an executing record untouched when its container is not visible (#136)', () => {
    if (needsPosixShell()) {
      return;
    }
    const record = keptContainerRecord({
      status: ExecutionStatus.EXECUTING,
      exitCode: null,
      endTime: null,
      endTimeSource: undefined,
    });
    const store = storeWith(record);
    withFakeDocker(NOT_FOUND, () => {
      const status = statusJson(store, record.uuid);
      expect(status.status).toBe('executing');
      expect(status.containerState).toBeUndefined();
    });
    expect(store.get(record.uuid).status).toBe('executing');
  });
});

describe('issue #225: start-command records its own removals', () => {
  it('the finalizer records a removal by the cleanup policy', () => {
    const record = keptContainerRecord({
      status: ExecutionStatus.EXECUTING,
      exitCode: null,
      endTime: null,
      endTimeSource: undefined,
    });
    const store = storeWith(record);
    const outcome = finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      exitCode: '0',
      oomKilled: 'false',
      startedAt: '2026-10-19T00:00:00Z',
      finishedAt: '2026-10-19T00:00:10Z',
      running: 'false',
      containerRemoved: 'true',
    });
    expect(outcome.updated).toBe(true);
    const stored = store.get(record.uuid);
    expect(stored.containerState).toBe('removed');
    expect(stored.containerRemovedObservedAt).toBeDefined();
    expect(stored.options.containerId).toBe('d2a8c0ffee');
  });

  it('the finalizer records a removal on an already finalized record', () => {
    const record = keptContainerRecord();
    const store = storeWith(record);
    const outcome = finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      running: 'false',
      containerRemoved: 'true',
    });
    expect(outcome.reason).toBe('container-removed');
    expect(store.get(record.uuid).containerState).toBe('removed');
  });

  it('the finalizer records nothing when the container was kept', () => {
    const record = keptContainerRecord({
      status: ExecutionStatus.EXECUTING,
      exitCode: null,
      endTime: null,
    });
    const store = storeWith(record);
    finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      exitCode: '1',
      finishedAt: '2026-10-19T00:00:10Z',
      startedAt: '2026-10-19T00:00:00Z',
      running: 'false',
      containerRemoved: 'false',
    });
    expect(store.get(record.uuid).containerState).toBeUndefined();
  });

  /** Run the real watcher against a fake docker whose `rm` exits `rmStatus`. */
  function runWatcher(policy, exitCode, rmStatus) {
    const dir = makeTempDir('watcher-225-');
    const binDir = path.join(dir, 'bin');
    const appFolder = path.join(dir, 'app');
    fs.mkdirSync(binDir);
    const logPath = path.join(dir, 'run.log');
    fs.writeFileSync(
      path.join(binDir, 'docker'),
      [
        '#!/bin/sh',
        '[ "$START_COMMAND_CGROUP_SAMPLING" = 1 ] && exit 1',
        'case "$1" in',
        '  inspect)',
        '    case "$3" in',
        '      *HostConfig*) exit 1 ;;',
        '      *State.Running*) echo false ;;',
        '      *State.Error*) echo "" ;;',
        "      *'{{.Id}}'*|*State.Pid*) echo 0 ;;",
        `      *) echo '${exitCode} false 2026-10-19T00:00:00Z 2026-10-19T00:00:10Z' ;;`,
        '    esac ;;',
        '  logs) echo work ;;',
        '  wait) echo 0 ;;',
        `  rm) exit ${rmStatus} ;;`,
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      'utf8'
    );
    fs.chmodSync(path.join(binDir, 'docker'), 0o755);
    const store = new ExecutionStore({ appFolder, useLinks: false });
    const record = keptContainerRecord({
      status: ExecutionStatus.EXECUTING,
      exitCode: null,
      endTime: null,
      endTimeSource: undefined,
      logPath,
    });
    store.save(record);
    const script = buildDetachedDockerCompletionScript(
      'status-removal-demo',
      policy,
      logPath,
      record.uuid
    );
    const result = spawnSync('/bin/sh', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        START_APP_FOLDER: appFolder,
        START_DISABLE_TRACKING: '',
      },
      timeout: 20000,
    });
    expect(result.status).toBe(0);
    return new ExecutionStore({ appFolder, useLinks: false }).get(record.uuid);
  }

  it('the watcher marks the record when its docker rm succeeded', () => {
    if (needsPosixShell()) {
      return;
    }
    const record = runWatcher(DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS, 0, 0);
    expect(record.status).toBe('executed');
    expect(record.containerState).toBe('removed');
    expect(record.containerRemovedObservedAt).toBeDefined();
  });

  it('the watcher does not mark a kept container', () => {
    if (needsPosixShell()) {
      return;
    }
    const record = runWatcher(DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT, 1, 0);
    expect(record.status).toBe('executed');
    expect(record.exitCode).toBe(1);
    expect(record.containerState).toBeUndefined();
  });

  it('the watcher does not mark a container whose docker rm failed', () => {
    if (needsPosixShell()) {
      return;
    }
    const record = runWatcher(DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS, 0, 1);
    expect(record.status).toBe('executed');
    expect(record.containerState).toBeUndefined();
  });
});
