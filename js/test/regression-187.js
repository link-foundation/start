const { describe, it, expect, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { recoverKilledExecution } = require('../src/lib/execution-recovery');
const {
  ExecutionRecord,
  ExecutionStore,
} = require('../src/lib/execution-store');
const { resumeExecution } = require('../src/lib/execution-resume');
const { resumeAllExecutions } = require('../src/lib/execution-resume-all');
const { SessionState } = require('../src/lib/session-probe');
const { OutputObserver } = require('../src/lib/detached-output');
const {
  activityPath,
  readAttemptLogTail,
} = require('../src/lib/execution-attempt');
const {
  buildDetachedDockerCompletionScript,
  DOCKER_CONTAINER_CLEANUP_POLICY,
} = require('../src/lib/docker-cleanup');
const { finalizeDetachedExecution } = require('../src/lib/detached-finalize');
const {
  enrichDetachedStatus,
  formatRecord,
  formatRecordList,
} = require('../src/lib/status-formatter');

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-187-'));
  directories.push(directory);
  const logPath = path.join(directory, 'execution.log');
  const oldLog =
    'previous output: 🐝\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n' +
    '\n==================================================\nFinished: 2026-01-01 00:01:00.000\nExit Code: 137\n';
  fs.writeFileSync(logPath, oldLog);
  const store = new ExecutionStore({ appFolder: directory, useLinks: false });
  const record = new ExecutionRecord({
    command: 'worker',
    logPath,
    startTime: '2026-01-01T00:00:00.000Z',
    status: 'executed',
    exitCode: 137,
    endTime: '2026-01-01T00:01:00.000Z',
    endTimeSource: 'docker-finished-at',
    observedAt: '2026-01-01T00:01:01.000Z',
    staleDetectedAt: '2026-01-01T00:01:02.000Z',
    containerStartedAt: '2026-01-01T00:00:00.000Z',
    exitReason: 'cgroup-oom-killer',
    oomKilled: true,
    memoryExhausted: true,
    memoryExhaustedReason: 'cgroup-oom-killer',
    cgroupMemory: {
      limitBytes: 128,
      peakBytes: 128,
      oomEvents: 1,
      oomKills: 1,
    },
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: 'issue-187-container-that-does-not-exist',
      containerError: 'previous error',
    },
  });
  store.save(record);
  return { store, record, logPath, oldLog };
}

const stopped = () => ({ alive: false, state: SessionState.STOPPED });
const accepted = () => ({ success: true, stdout: 'container-id\n', status: 0 });

describe('issue #187: explicit resume attempts', () => {
  it('reattaches the current attempt without enabling kill recovery for snapshot commands', async () => {
    for (const mode of ['docker-start', 'docker-snapshot', 'relaunch']) {
      const command = mode === 'docker-snapshot' ? 'replacement' : undefined;
      const { store, record } = fixture();
      record.options.onKillResume = 1;
      store.save(record);
      await resumeExecution(store, record.uuid, {
        command,
        probe:
          mode === 'relaunch'
            ? () => ({ alive: false, state: SessionState.MISSING })
            : stopped,
        runner: accepted,
        runIsolated: () => ({ success: true, containerId: 'new-container' }),
        startWatcher: (_name, _policy, _log, _uuid, options) => {
          expect(options.recoverOnKill).toBe(mode !== 'docker-snapshot');
        },
      });
      const current = store.get(record.uuid);
      let options;
      resumeAllExecutions(store, {
        probe: () => ({
          alive: true,
          backend: 'docker',
          sessionName: current.options.sessionName,
        }),
        startWatcher: (_name, _policy, _log, _uuid, watcherOptions) => {
          options = watcherOptions;
        },
      });
      expect(options.attemptNumber).toBe(2);
      expect(options.since).toBe(current.attempt.startedAt);
      expect(options.recoverOnKill).toBe(mode !== 'docker-snapshot');
    }
  });
  it('merges attachment metadata without reviving a completed or newer attempt', async () => {
    const { store, record } = fixture();
    await resumeExecution(store, record.uuid, {
      probe: stopped,
      runner: accepted,
      startWatcher: () => {},
    });
    const current = store.get(record.uuid);
    current.status = 'executed';
    current.exitCode = 0;
    store.save(current);
    const patched = store.patchAttempt(record.uuid, 2, {
      watcherAttachedAt: '2026-10-06T09:00:00Z',
    });
    expect(patched.status).toBe('executed');
    expect(patched.exitCode).toBe(0);
    expect(
      store.patchAttempt(record.uuid, 1, { watcherError: 'stale watcher' })
    ).toBeNull();
    expect(store.get(record.uuid).attempt.watcherError).toBeUndefined();
    expect(enrichDetachedStatus(null)).toBeNull();
  });
  it('keeps boundaries and evidence when an explicit resume is automatically recovered', async () => {
    const { store, record, logPath } = fixture();
    record.options.onKillResume = 1;
    store.save(record);
    await resumeExecution(store, record.uuid, {
      probe: stopped,
      runner: accepted,
      startWatcher: () => {},
    });
    const current = store.get(record.uuid);
    const outcome = recoverKilledExecution({
      store,
      executionId: record.uuid,
      exitCode: 137,
      oomKilled: true,
      startedAt: current.attempt.startedAt,
      finishedAt: new Date().toISOString(),
      cgroupMemory: '128 128 1 1',
      runner: accepted,
      startWatcher: (_name, _policy, _log, _uuid, options) => {
        expect(options.attemptNumber).toBe(3);
        expect(store.get(record.uuid).attempt.number).toBe(3);
      },
    });
    expect(outcome.recovered).toBe(true);
    const saved = store.get(record.uuid);
    expect(saved.attemptHistory.map((a) => a.exitCode)).toEqual([137, 137]);
    expect(saved.attemptHistory[1].cgroupMemory.oomKills).toBe(1);
    expect(saved.cgroupMemory).toBeUndefined();
    expect(saved.attempt.lastOutputAt).toBeNull();
    expect(saved.attempt.logOffset).toBeGreaterThan(current.attempt.logOffset);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('automatic-recovery');
  });

  it('runs the timestamped output capture and finalizer through the real watcher shell', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const { store, record, logPath } = fixture();
    await resumeExecution(store, record.uuid, {
      probe: stopped,
      runner: accepted,
      startWatcher: () => {},
    });
    const current = store.get(record.uuid);
    const directory = path.dirname(logPath);
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    const at = new Date().toISOString();
    fs.writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh
case "$1" in
  logs) printf '%s command output 🐝\\n' "$TEST_OUTPUT_AT" ;;
  wait) echo 0 ;;
  inspect) case "$3" in
    *State.Running*) echo false ;;
    *State.ExitCode*) echo "0 false $TEST_OUTPUT_AT $TEST_OUTPUT_AT" ;;
    *State.Error*) echo '' ;;
    *) exit 1 ;;
  esac ;;
esac
`,
      { mode: 0o755 }
    );
    const script = buildDetachedDockerCompletionScript(
      current.options.sessionName,
      DOCKER_CONTAINER_CLEANUP_POLICY.KEEP,
      logPath,
      record.uuid,
      { since: current.attempt.startedAt, attemptNumber: 2 }
    );
    const output = spawnSync('/bin/sh', ['-c', script], {
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        START_APP_FOLDER: directory,
        TEST_OUTPUT_AT: at,
        START_COMMAND_CGROUP_ROOT: path.join(directory, 'no-cgroup'),
        START_COMMAND_PROC_ROOT: path.join(directory, 'no-proc'),
      },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    expect(output.status).toBe(0);
    const saved = store.get(record.uuid);
    expect(saved.status).toBe('executed');
    expect(saved.exitCode).toBe(0);
    expect(saved.attempt.lastOutputAt).toBe(at);
    expect(saved.cgroupMemory).toBeUndefined();
    expect(fs.readFileSync(logPath, 'utf8')).toContain('command output 🐝');
  }, 10000);

  it('archives terminal evidence and resets every attempt-local field', async () => {
    const { store, record, oldLog } = fixture();
    const outcome = await resumeExecution(store, record.uuid, {
      probe: stopped,
      runner: accepted,
      startWatcher: () => {},
    });
    expect(outcome.success).toBe(true);
    const saved = store.get(record.uuid);
    expect(saved.status).toBe('executing');
    expect(saved.exitCode).toBeNull();
    for (const field of [
      'endTimeSource',
      'observedAt',
      'staleDetectedAt',
      'containerStartedAt',
      'exitReason',
      'oomKilled',
      'memoryExhausted',
      'memoryExhaustedReason',
      'cgroupMemory',
    ]) {
      expect(saved[field]).toBeUndefined();
    }
    expect(saved.options.containerError).toBeUndefined();
    expect(saved.attempt.number).toBe(2);
    expect(saved.attempt.logOffset).toBe(Buffer.byteLength(oldLog));
    expect(saved.attempt.startedAt).not.toBe(record.startTime);
    expect(saved.attempt.launchAcceptedAt).toBeDefined();
    expect(saved.attempt.lastOutputAt).toBeNull();
    expect(saved.attemptHistory[0].exitCode).toBe(137);
    expect(saved.attemptHistory[0].memoryExhausted).toBe(true);
    expect(saved.attemptHistory[0].cgroupMemory.oomKills).toBe(1);
  });

  it('does not resolve the previous footer or memory marker as current evidence', async () => {
    const { store, record } = fixture();
    await resumeExecution(store, record.uuid, {
      probe: stopped,
      runner: accepted,
      startWatcher: () => {},
    });
    const current = store.get(record.uuid);
    const enriched = enrichDetachedStatus(current);
    expect(enriched.status).toBe('executing');
    expect(enriched.exitCode).toBeNull();
    expect(enriched.memoryExhausted).toBeUndefined();
    const status = JSON.parse(formatRecord(enriched, 'json'));
    const list = JSON.parse(formatRecordList([enriched], 'json'));
    expect(status.attempt.logOffset).toBe(current.attempt.logOffset);
    expect(list.executions[0].attempt.startedAt).toBe(
      current.attempt.startedAt
    );
  });

  it('persists the new attempt before a watcher can finalize an immediate exit', async () => {
    const { store, record } = fixture();
    await resumeExecution(store, record.uuid, {
      probe: stopped,
      runner: accepted,
      startWatcher: (name, policy, logPath, uuid, options) => {
        expect(store.get(uuid).status).toBe('executing');
        expect(options.since).toBe(store.get(uuid).attempt.startedAt);
        const outcome = finalizeDetachedExecution({
          store,
          executionId: uuid,
          exitCode: 0,
          oomKilled: false,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          attemptNumber: store.get(uuid).attempt.number,
        });
        expect(outcome.updated).toBe(true);
      },
    });
    expect(store.get(record.uuid).status).toBe('executed');
    expect(store.get(record.uuid).exitCode).toBe(0);
  });

  it('records a structured boundary before launch and accepted launch separately from output', async () => {
    const { store, record, logPath, oldLog } = fixture();
    await resumeExecution(store, record.uuid, {
      probe: stopped,
      runner: () => {
        expect(fs.readFileSync(logPath, 'utf8').slice(oldLog.length)).toContain(
          'resume-started'
        );
        return accepted();
      },
      startWatcher: () => {},
    });
    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('launch-accepted');
    expect(log).toContain('watcher-attached');
    expect(store.get(record.uuid).attempt.lastOutputAt).toBeNull();
  });

  it('preserves the stopped record when launch fails and logs that failure', async () => {
    const { store, record, logPath } = fixture();
    const outcome = await resumeExecution(store, record.uuid, {
      probe: stopped,
      runner: () => ({ success: false, stderr: 'launch rejected', status: 1 }),
      startWatcher: () => {
        throw new Error('must not attach');
      },
    });
    expect(outcome.success).toBe(false);
    expect(store.get(record.uuid).exitCode).toBe(137);
    expect(store.get(record.uuid).memoryExhausted).toBe(true);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('launch-failed');
  });

  it('records previous and new container names for a snapshot resume', async () => {
    const { store, record, logPath } = fixture();
    const result = await resumeExecution(store, record.uuid, {
      command: 'replacement',
      probe: stopped,
      runner: accepted,
      startWatcher: () => {},
    });
    expect(result.success).toBe(true);
    const saved = store.get(record.uuid);
    expect(saved.attempt.sessionName).toBe(
      `${record.options.sessionName}-resume-1`
    );
    expect(saved.attempt.previousSessionName).toBe(record.options.sessionName);
    expect(saved.attemptHistory[0].command).toBe('worker');
    expect(fs.readFileSync(logPath, 'utf8')).toContain(
      saved.attempt.sessionName
    );
  });

  it('defers the relaunch watcher until the accepted attempt is saved', async () => {
    const { store, record } = fixture();
    let attached = false;
    const result = await resumeExecution(store, record.uuid, {
      probe: () => ({ alive: false, state: SessionState.MISSING }),
      runIsolated: (backend, command, options) => {
        expect(options.deferCompletionWatcher).toBe(true);
        expect(store.get(record.uuid).status).toBe('executing');
        expect(store.get(record.uuid).options.launchPending).toBe(true);
        return { success: true, containerId: 'replacement-container' };
      },
      startWatcher: () => {
        attached = true;
        expect(store.get(record.uuid).status).toBe('executing');
      },
    });
    expect(result.success).toBe(true);
    expect(attached).toBe(true);
    expect(store.get(record.uuid).attempt.mode).toBe('relaunch');
  });

  it('reports watcher failure while preserving the accepted launch', async () => {
    const { store, record, logPath } = fixture();
    const result = await resumeExecution(store, record.uuid, {
      probe: stopped,
      runner: accepted,
      startWatcher: () => {
        throw new Error('cannot spawn watcher');
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Launch accepted');
    const saved = store.get(record.uuid);
    expect(saved.status).toBe('executing');
    expect(saved.attempt.launchAcceptedAt).toBeDefined();
    expect(saved.attempt.watcherAttachedAt).toBeNull();
    expect(saved.attempt.watcherError).toBe('cannot spawn watcher');
    expect(fs.readFileSync(logPath, 'utf8')).toContain(
      'watcher-attachment-failed'
    );
  });

  it('rejects a finalizer carrying evidence from a previous attempt', async () => {
    const { store, record } = fixture();
    await resumeExecution(store, record.uuid, {
      probe: stopped,
      runner: accepted,
      startWatcher: () => {},
    });
    const result = finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      attemptNumber: 1,
      exitCode: 137,
      oomKilled: true,
      startedAt: record.startTime,
      finishedAt: record.endTime,
    });
    expect(result.reason).toBe('stale-attempt');
    expect(store.get(record.uuid).exitCode).toBeNull();
  });

  it('does not reuse a previous fatal marker when the new run exits 139', async () => {
    const { store, record, logPath } = fixture();
    await resumeExecution(store, record.uuid, {
      probe: stopped,
      runner: accepted,
      startWatcher: () => {},
    });
    const current = store.get(record.uuid);
    const at = new Date().toISOString();
    finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      attemptNumber: current.attempt.number,
      exitCode: 139,
      oomKilled: false,
      startedAt: at,
      finishedAt: at,
    });
    const terminal = enrichDetachedStatus(store.get(record.uuid));
    expect(terminal.memoryExhausted).toBeUndefined();
    expect(terminal.cgroupMemory).toBeUndefined();
    expect(terminal.exitReason).not.toBe('cgroup-oom-killer');
    expect(fs.readFileSync(logPath, 'utf8')).toContain('"event":"terminal"');
  });

  it('keeps successive attempts and their terminal evidence through store round trips', async () => {
    const { store, record } = fixture();
    for (let i = 0; i < 2; i++) {
      await resumeExecution(store, record.uuid, {
        probe: stopped,
        runner: accepted,
        startWatcher: () => {},
      });
      const current = store.get(record.uuid);
      const at = new Date().toISOString();
      finalizeDetachedExecution({
        store,
        executionId: record.uuid,
        attemptNumber: current.attempt.number,
        exitCode: i,
        oomKilled: false,
        startedAt: at,
        finishedAt: at,
      });
    }
    const saved = store.get(record.uuid);
    expect(saved.attempt.number).toBe(3);
    expect(saved.attemptHistory.map((a) => a.exitCode)).toEqual([137, 0]);
    expect(saved.attemptHistory[0].cgroupMemory.oomKills).toBe(1);
  });

  it('reports output time only after fresh timestamped command output, even without a newline', async () => {
    const { store, record, logPath } = fixture();
    await resumeExecution(store, record.uuid, {
      probe: stopped,
      runner: accepted,
      startWatcher: () => {},
    });
    const current = store.get(record.uuid);
    const observer = new OutputObserver(
      logPath,
      current.attempt.number,
      current.attempt.startedAt
    );
    observer.write(
      Buffer.from(
        'Docker administrative error\n2026-01-01T00:00:00Z old output\n'
      )
    );
    expect(
      enrichDetachedStatus(store.get(record.uuid)).attempt.lastOutputAt
    ).toBeNull();
    const at = new Date().toISOString();
    const output = Buffer.from(`${at} quiet run emits 🐝 without a newline`);
    observer.write(output.subarray(0, 10));
    observer.write(output.subarray(10));
    expect(
      enrichDetachedStatus(store.get(record.uuid)).attempt.lastOutputAt
    ).toBe(at);
    expect(fs.readFileSync(logPath).includes(output)).toBe(true);
    fs.appendFileSync(
      logPath,
      '\n[Start Command Lifecycle] administrative activity\n'
    );
    expect(
      enrichDetachedStatus(store.get(record.uuid)).attempt.lastOutputAt
    ).toBe(at);
    fs.writeFileSync(activityPath(current), '2026-01-01T00:00:00Z');
    expect(
      enrichDetachedStatus(store.get(record.uuid)).attempt.lastOutputAt
    ).toBeNull();
  });

  it('bounds reads and never scans prior evidence after log truncation', async () => {
    const { store, record, logPath } = fixture();
    await resumeExecution(store, record.uuid, {
      probe: stopped,
      runner: accepted,
      startWatcher: () => {},
    });
    const current = store.get(record.uuid);
    fs.appendFileSync(logPath, `\n${'x'.repeat(70 * 1024)}\nfresh\n`);
    expect(readAttemptLogTail(current, 64 * 1024).length).toBeLessThanOrEqual(
      64 * 1024
    );
    fs.writeFileSync(logPath, 'old footer truncated');
    expect(readAttemptLogTail(current, 64 * 1024)).toBe('');
  });

  it('builds a watcher that filters historical output and carries the attempt identity', () => {
    const script = buildDetachedDockerCompletionScript(
      'box',
      DOCKER_CONTAINER_CLEANUP_POLICY.KEEP,
      '/tmp/log with spaces',
      'uuid',
      { since: '2026-10-06T08:00:00Z', attemptNumber: 2 }
    );
    expect(script).toContain('docker logs -f --timestamps --since');
    expect(script).toContain('detached-output.js');
    expect(script).toContain("'2' >/dev/null");
  });
});
