/**
 * Regression tests for issue #174: the detached docker watcher `docker rm -f`ed
 * a still-running container when `docker logs -f` failed (ENOSPC) and
 * finalized it as executed / exit 0.
 *
 *   - `docker logs -f C >> LOG` also returns when its own write to LOG fails,
 *     and on a dockerd restart; the watcher must wait for the real exit;
 *   - a container that is still running must never be removed, get an
 *     `Exit Code:` footer, or be finalized;
 *   - `ExitCode=0` next to a zero `FinishedAt` is Docker's zero value, never an
 *     observed exit 0;
 *   - a child killed by a signal (`code === null`) must never become exit 0.
 */

const { describe, it, expect, afterEach } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  ExecutionStore,
  ExecutionRecord,
  ExecutionStatus,
} = require('../src/lib/execution-store');
const {
  buildDetachedDockerCompletionScript,
  DOCKER_CONTAINER_CLEANUP_POLICY,
} = require('../src/lib/docker-cleanup');
const {
  LOG_CAPTURE_STOPPED_NOTE,
  STILL_RUNNING_NOTE,
} = require('../src/lib/docker-post-mortem');
const {
  WATCHER_LOST_CONTAINER,
  finalizeDetachedExecution,
} = require('../src/lib/detached-finalize');
const { resolveChildExitCode } = require('../src/lib/exit-reason');
const { runWithNodeSpawn } = require('../src/lib/spawn-helpers');

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function detachedDockerRecord(logPath) {
  return new ExecutionRecord({
    status: ExecutionStatus.EXECUTING,
    command: 'work',
    logPath,
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: 'start-command-174',
    },
  });
}

// The watcher body is a POSIX `sh` script; Windows has no `/bin/sh`.
const needsPosixShell = () => {
  if (process.platform !== 'win32') {
    return false;
  }
  console.log('  Skipping: the watcher needs a POSIX /bin/sh');
  return true;
};

/**
 * Run the real watcher script against a scripted fake `docker`.
 *
 * `running` lists the successive answers to `docker inspect -f
 * '{{.State.Running}}'` (`true`, `false`, or `fail` for an inspect that
 * errors, as during a dockerd restart); the last answer sticks. `docker logs`
 * writes one line and fails, exactly like `docker logs -f C >> LOG` whose write
 * hit ENOSPC. Every call is recorded, and `rm` records whether the container was
 * running at that moment.
 */
function runWatcher({ policy, running, state, withLog = true }) {
  const dir = makeTempDir('watcher-174-');
  const binDir = path.join(dir, 'bin');
  const appFolder = path.join(dir, 'app');
  fs.mkdirSync(binDir);
  const logPath = path.join(dir, 'run.log');
  fs.writeFileSync(path.join(dir, 'running'), `${running.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'state'), `${state}\n`);
  const calls = path.join(dir, 'calls');
  const dockerPath = path.join(binDir, 'docker');
  fs.writeFileSync(
    dockerPath,
    [
      '#!/bin/sh',
      `dir='${dir}'`,
      'case "$1" in',
      '  inspect)',
      '    case "$3" in',
      '      *State.Running*)',
      '        answer=$(head -n 1 "$dir/running")',
      '        if [ "$(wc -l < "$dir/running")" -gt 1 ]; then',
      '          tail -n +2 "$dir/running" > "$dir/running.next" && mv "$dir/running.next" "$dir/running"',
      '        fi',
      '        echo "inspect-running $answer" >> "$dir/calls"',
      '        [ "$answer" = fail ] && exit 1',
      '        echo "$answer" > "$dir/current"',
      '        echo "$answer" ;;',
      '      *State.Error*) echo "" ;;',
      // The cgroup sampler (issue #182): no cgroup to find here.
      "      *'{{.Id}}'*|*State.Pid*) echo 0 ;;",
      '      *) echo "inspect-state" >> "$dir/calls"; cat "$dir/state" ;;',
      '    esac ;;',
      '  logs) echo logs >> "$dir/calls"; echo work; exit 1 ;;',
      '  wait) echo wait >> "$dir/calls"; echo 0 ;;',
      '  rm) echo "rm running=$(cat "$dir/current" 2>/dev/null)" >> "$dir/calls" ;;',
      'esac',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.chmodSync(dockerPath, 0o755);

  const store = new ExecutionStore({ appFolder, useLinks: false });
  const record = detachedDockerRecord(withLog ? logPath : null);
  store.save(record);

  const script = buildDetachedDockerCompletionScript(
    'demo',
    policy,
    withLog ? logPath : null,
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
  return {
    status: result.status,
    calls: fs.readFileSync(calls, 'utf8').trim().split('\n'),
    log: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '',
    record: new ExecutionStore({ appFolder, useLinks: false }).get(record.uuid),
  };
}

const FINISHED_7 =
  '7 false 2026-09-27T10:00:00.000000000Z 2026-09-27T10:00:05.000000000Z';
const FINISHED_0 =
  '0 false 2026-09-27T10:00:00.000000000Z 2026-09-27T10:00:05.000000000Z';
const NOT_FINISHED = '0 false 2026-09-27T10:00:00Z 0001-01-01T00:00:00Z';

describe('issue #174: docker logs -f returning is not the container exiting', () => {
  it('waits for the real exit after docker logs -f fails (ENOSPC)', () => {
    if (needsPosixShell()) {
      return;
    }
    const run = runWatcher({
      policy: DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT,
      running: ['true', 'true', 'false'],
      state: FINISHED_7,
    });

    expect(run.status).toBe(0);
    expect(run.calls).toContain('wait');
    expect(run.calls.indexOf('wait')).toBeGreaterThan(
      run.calls.indexOf('logs')
    );
    expect(run.calls.indexOf('inspect-state')).toBeGreaterThan(
      run.calls.lastIndexOf('wait')
    );
    expect(run.log).toContain(LOG_CAPTURE_STOPPED_NOTE);
    expect(run.log).toContain('Exit Code: 7');
    expect(run.log).not.toContain('Exit Code: 0');
    expect(run.record.status).toBe(ExecutionStatus.EXECUTED);
    expect(run.record.exitCode).toBe(7);
    expect(run.record.endTimeSource).toBe('docker-finished-at');
  });

  it('only removes the container once it has really exited', () => {
    if (needsPosixShell()) {
      return;
    }
    const run = runWatcher({
      policy: DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS,
      running: ['true', 'true', 'false'],
      state: FINISHED_0,
    });

    expect(run.calls).toContain('rm running=false');
    expect(run.calls).not.toContain('rm running=true');
    expect(run.log).toContain('Exit Code: 0');
    expect(run.record.exitCode).toBe(0);
  });

  it('keeps waiting across a failed docker inspect (dockerd restart)', () => {
    if (needsPosixShell()) {
      return;
    }
    const run = runWatcher({
      policy: DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT,
      running: ['true', 'true', 'true', 'false'],
      state: FINISHED_7,
    });

    expect(run.calls.filter((call) => call === 'wait').length).toBe(2);
    expect(run.record.exitCode).toBe(7);
  });

  it('applies the same wait to the no-log watcher', () => {
    if (needsPosixShell()) {
      return;
    }
    const run = runWatcher({
      policy: DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS,
      running: ['true', 'false'],
      state: FINISHED_7,
      withLog: false,
    });

    expect(run.calls.filter((call) => call === 'wait').length).toBe(2);
    expect(run.calls).toContain('rm running=false');
    expect(run.calls).not.toContain('rm running=true');
    expect(run.record.exitCode).toBe(7);
  });
});

describe('issue #174: a container that is still running is left alone', () => {
  it('never removes, footers or finalizes a running container', () => {
    if (needsPosixShell()) {
      return;
    }
    // logs -f fails -> running; the wait loop's inspect fails (daemon down) ->
    // the loop ends; once the daemon is back the container is still running.
    const run = runWatcher({
      policy: DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS,
      running: ['true', 'fail', 'true'],
      state: NOT_FINISHED,
    });

    expect(run.calls.some((call) => call.startsWith('rm'))).toBe(false);
    expect(run.log).toContain('Container still running: demo');
    expect(run.log).toContain(STILL_RUNNING_NOTE);
    expect(run.log).not.toContain('Exit Code:');
    expect(run.record.status).toBe(ExecutionStatus.EXECUTING);
    expect(run.record.exitCode).toBeNull();
  });

  it('never removes a running container without a log either', () => {
    if (needsPosixShell()) {
      return;
    }
    const run = runWatcher({
      policy: DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS,
      running: ['fail', 'true'],
      state: NOT_FINISHED,
      withLog: false,
    });

    expect(run.calls.some((call) => call.startsWith('rm'))).toBe(false);
    expect(run.record.status).toBe(ExecutionStatus.EXECUTING);
  });
});

describe('issue #174: a zero FinishedAt is never an exit 0', () => {
  it('keeps the container and records no success in the watcher', () => {
    if (needsPosixShell()) {
      return;
    }
    const run = runWatcher({
      policy: DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT,
      running: ['false'],
      state: NOT_FINISHED,
    });

    expect(run.calls.some((call) => call.startsWith('rm'))).toBe(false);
    expect(run.log).toContain('Exit Code: -1');
    expect(run.log).not.toContain('Exit Code: 0');
    expect(run.record.status).toBe(ExecutionStatus.EXECUTED);
    expect(run.record.exitCode).toBe(-1);
    expect(run.record.exitReason).toBe(WATCHER_LOST_CONTAINER);
    expect(run.record.endTimeSource).toBe('observed-at');
  });

  it('refuses to finalize a record whose container is still running', () => {
    const appFolder = makeTempDir('finalize-174-running-');
    const store = new ExecutionStore({ appFolder, useLinks: false });
    const record = detachedDockerRecord(null);
    store.save(record);

    const outcome = finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      exitCode: '0',
      oomKilled: 'false',
      startedAt: '2026-09-27T10:00:00Z',
      finishedAt: '0001-01-01T00:00:00Z',
      containerError: '',
      running: 'true',
    });

    expect(outcome).toEqual({ updated: false, reason: 'still-running' });
    expect(store.get(record.uuid).status).toBe(ExecutionStatus.EXECUTING);
  });

  it('does not trust exit 0 without a FinishedAt', () => {
    const appFolder = makeTempDir('finalize-174-zero-');
    const store = new ExecutionStore({ appFolder, useLinks: false });
    const record = detachedDockerRecord(null);
    store.save(record);

    finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      exitCode: '0',
      oomKilled: 'false',
      startedAt: '2026-09-27T10:00:00Z',
      finishedAt: '0001-01-01T00:00:00Z',
      running: 'false',
    });

    const stored = store.get(record.uuid);
    expect(stored.exitCode).toBe(-1);
    expect(stored.exitReason).toBe(WATCHER_LOST_CONTAINER);
  });

  it('still records a real exit 0', () => {
    const appFolder = makeTempDir('finalize-174-real-zero-');
    const store = new ExecutionStore({ appFolder, useLinks: false });
    const record = detachedDockerRecord(null);
    store.save(record);

    finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      exitCode: '0',
      oomKilled: 'false',
      startedAt: '2026-09-27T10:00:00Z',
      finishedAt: '2026-09-27T10:00:05Z',
      running: 'false',
    });

    const stored = store.get(record.uuid);
    expect(stored.exitCode).toBe(0);
    expect(stored.exitReason).toBeUndefined();
    expect(stored.endTimeSource).toBe('docker-finished-at');
  });
});

describe('issue #174: a signal death is never exit 0', () => {
  it('maps a null code with a signal to 128+n', () => {
    expect(resolveChildExitCode(null, 'SIGKILL')).toBe(137);
    expect(resolveChildExitCode(null, 'SIGTERM')).toBe(143);
    expect(resolveChildExitCode(null, 'SIGINT')).toBe(130);
  });

  it('maps a missing code without a signal to a failure', () => {
    expect(resolveChildExitCode(null)).toBe(1);
    expect(resolveChildExitCode(undefined)).toBe(1);
    expect(resolveChildExitCode(null, 'SIGNOTREAL')).toBe(1);
  });

  it('keeps real exit codes, including 0', () => {
    expect(resolveChildExitCode(0)).toBe(0);
    expect(resolveChildExitCode(3, null)).toBe(3);
  });

  it('records a self-killed child as 137 in the node spawn path', async () => {
    if (needsPosixShell()) {
      return;
    }
    const dir = makeTempDir('spawn-174-');
    const logFilePath = path.join(dir, 'run.log');
    const exitCode = await new Promise((resolve) => {
      runWithNodeSpawn({
        shell: '/bin/sh',
        shellArgs: ['-c', 'kill -KILL $$'],
        logFilePath,
        startTimeMs: Date.now(),
        onComplete: (code) => resolve(code),
        onError: () => resolve('error'),
      });
    });

    expect(exitCode).toBe(137);
    expect(fs.readFileSync(logFilePath, 'utf8')).toContain('Exit Code: 137');
  });
});
