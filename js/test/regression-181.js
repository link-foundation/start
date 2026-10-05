/**
 * Regression tests for issue #181:
 *
 *   `--on-kill-resume <N>` restarted a killed detached docker execution right
 *   after its watcher saw it end. One host-wide OOM event that kills several
 *   executions made every watcher resume its container in the same second;
 *   all of them rebuilt their working sets at once and triggered the next OOM
 *   event.
 *
 *   `--on-kill-resume-delay <min[-max]>` waits a uniformly random number of
 *   seconds before each recovery. The chosen delay is printed in the
 *   `[Recovery k/N]` line and stored in `recoveryHistory` (`delayMs`), and a
 *   `--stop` during the wait cancels the pending recovery.
 */

const { describe, it, expect, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseArgs } = require('../src/lib/args-parser');
const {
  buildDockerRuntimeMetadata,
  buildDockerRuntimeStatusLines,
} = require('../src/lib/docker-runtime-args');
const {
  formatRecoverySeparator,
  recoverKilledExecution,
} = require('../src/lib/execution-recovery');
const {
  ControlAction,
  controlExecution,
} = require('../src/lib/execution-control');
const {
  parseOnKillResumeDelayValue,
  pickRecoveryDelayMs,
  sleepSync,
  waitForRecoveryDelay,
} = require('../src/lib/recovery-delay');
const {
  ExecutionStore,
  ExecutionRecord,
  ExecutionStatus,
} = require('../src/lib/execution-store');

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

function parse(extra) {
  return parseArgs(['--isolated', 'docker', '--detached', ...extra, '--', 'a'])
    .wrapperOptions;
}

function ok(stdout = '') {
  return { success: true, stdout, stderr: '', status: 0, error: null };
}

function fakeRunner(failures = {}) {
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (failures[args[0]]) {
      return {
        success: false,
        stdout: '',
        stderr: failures[args[0]],
        status: 1,
        error: null,
      };
    }
    if (args[0] === 'inspect') {
      return ok('{}\n');
    }
    return ok('cid\n');
  };
  runner.calls = calls;
  return runner;
}

function makeStore(options = {}) {
  const dir = makeTempDir('recovery-181-');
  const store = new ExecutionStore({
    appFolder: path.join(dir, 'app'),
    useLinks: false,
  });
  const logPath = path.join(dir, 'run.log');
  fs.writeFileSync(logPath, 'main output\n');
  const record = new ExecutionRecord({
    status: ExecutionStatus.EXECUTING,
    command: 'cargo test',
    logPath,
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: 'box',
      onKillResume: 3,
      onKillResumeDelay: '30-90',
      ...options,
    },
  });
  store.save(record);
  return { store, record, logPath };
}

function recover(store, record, extra = {}) {
  const runner = extra.runner || fakeRunner();
  const sleeps = [];
  const outcome = recoverKilledExecution({
    store,
    executionId: record.uuid,
    exitCode: '137',
    oomKilled: 'true',
    startedAt: '2026-10-01T10:00:00Z',
    finishedAt: '2026-10-01T10:05:00Z',
    containerError: '',
    runner,
    startWatcher: () => {},
    now: () => new Date('2026-10-01T10:06:00.000Z'),
    random: () => 0.5,
    sleep: (ms) => sleeps.push(ms),
    ...extra,
  });
  return { outcome, runner, sleeps };
}

describe('issue #181: --on-kill-resume-delay parsing', () => {
  it('accepts a range, a fixed delay and 0, with or without "="', () => {
    expect(
      parse(['--on-kill-resume', '3', '--on-kill-resume-delay', '30-90'])
    ).toMatchObject({ onKillResume: 3, onKillResumeDelay: '30-90' });
    expect(
      parse(['--on-kill-resume=3', '--on-kill-resume-delay=45'])
        .onKillResumeDelay
    ).toBe('45');
    expect(
      parse(['--on-kill-resume', '1', '--on-kill-resume-delay', '0'])
        .onKillResumeDelay
    ).toBe('0');
    expect(parseOnKillResumeDelayValue('1.5-2.5')).toBe('1.5-2.5');
  });

  it('defaults to no delay', () => {
    expect(parse(['--on-kill-resume', '3']).onKillResumeDelay).toBeNull();
  });

  it('rejects malformed and reversed ranges', () => {
    for (const value of ['abc', '90-30', '-5', '30-', '1-2-3']) {
      expect(() => parseOnKillResumeDelayValue(value)).toThrow(
        'Invalid --on-kill-resume-delay value'
      );
    }
    expect(() =>
      parse(['--on-kill-resume', '1', '--on-kill-resume-delay'])
    ).toThrow('requires a seconds argument');
  });

  it('requires --on-kill-resume or --recovery-command', () => {
    expect(() => parse(['--on-kill-resume-delay', '30-90'])).toThrow(
      '--on-kill-resume-delay requires --on-kill-resume or --recovery-command'
    );
    expect(
      parse(['--recovery-command', 'b', '--on-kill-resume-delay', '30-90'])
    ).toMatchObject({ onKillResume: 1, onKillResumeDelay: '30-90' });
  });

  it('shows the delay in the [Isolation] line and stores it', () => {
    const options = { onKillResume: 3, onKillResumeDelay: '30-90' };
    expect(buildDockerRuntimeStatusLines(options)).toContain(
      '[Isolation] On kill: resume up to 3 time(s) after a random 30-90s delay with the original command'
    );
    expect(buildDockerRuntimeMetadata(options).onKillResumeDelay).toBe('30-90');
    expect(
      buildDockerRuntimeMetadata({ onKillResume: 3, onKillResumeDelay: '0' })
        .onKillResumeDelay
    ).toBeNull();
    expect(
      buildDockerRuntimeStatusLines({ onKillResume: 3, onKillResumeDelay: '0' })
    ).toContain(
      '[Isolation] On kill: resume up to 3 time(s) with the original command'
    );
  });
});

describe('issue #181: picking and waiting out the delay', () => {
  it('picks uniformly within the range', () => {
    expect(pickRecoveryDelayMs('30-90', () => 0)).toBe(30000);
    expect(pickRecoveryDelayMs('30-90', () => 0.5)).toBe(60000);
    expect(pickRecoveryDelayMs('30-90', () => 0.999999)).toBe(90000);
    expect(pickRecoveryDelayMs('45', () => 0.7)).toBe(45000);
    expect(pickRecoveryDelayMs('0')).toBe(0);
    expect(pickRecoveryDelayMs(null)).toBe(0);
    for (let i = 0; i < 100; i++) {
      const ms = pickRecoveryDelayMs('30-90');
      expect(ms).toBeGreaterThanOrEqual(30000);
      expect(ms).toBeLessThanOrEqual(90000);
    }
  });

  it('waits in short steps and stops as soon as it is cancelled', () => {
    const sleeps = [];
    expect(
      waitForRecoveryDelay({ delayMs: 2500, sleep: (ms) => sleeps.push(ms) })
    ).toBe(false);
    expect(sleeps).toEqual([1000, 1000, 500]);

    const cancelled = [];
    expect(
      waitForRecoveryDelay({
        delayMs: 60000,
        sleep: (ms) => cancelled.push(ms),
        shouldCancel: () => cancelled.length >= 2,
      })
    ).toBe(true);
    expect(cancelled).toEqual([1000, 1000]);
  });

  it('really blocks the thread for the real sleep', () => {
    const start = Date.now();
    sleepSync(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });
});

describe('issue #181: recovering after the delay', () => {
  it('prints the delay in the [Recovery k/N] line', () => {
    expect(
      formatRecoverySeparator({
        attempt: 1,
        maxAttempts: 3,
        exitCode: 137,
        oomKilled: true,
        containerName: 'box',
        command: null,
        delayMs: 42500,
      })
    ).toBe(
      '\n[Recovery 1/3] Main process was killed (exit 137, SIGKILL, oomKilled=true); resuming container box after a 42.5s delay, running the original command again\n'
    );
  });

  it('waits before docker start and records delayMs in the history', () => {
    const { store, record, logPath } = makeStore();
    const { outcome, runner, sleeps } = recover(store, record);
    expect(outcome).toEqual({
      recovered: true,
      reason: 'resumed',
      attempt: 1,
      delayMs: 60000,
    });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(60000);
    expect(runner.calls.some((call) => call[1] === 'start')).toBe(true);
    expect(fs.readFileSync(logPath, 'utf8')).toContain(
      '[Recovery 1/3] Main process was killed (exit 137, SIGKILL, oomKilled=true); resuming container box after a 60s delay'
    );
    const stored = store.get(record.uuid).options;
    expect(stored.recoveryHistory).toEqual([
      '1: exit 137, oomKilled=true, delayMs=60000, resumed at 2026-10-01T10:06:00.000Z',
    ]);
    expect(stored.lastRecoveryDelayMs).toBe(60000);
  });

  it('keeps the old behaviour and history format without a delay', () => {
    const { store, record } = makeStore({ onKillResumeDelay: null });
    const { outcome, sleeps } = recover(store, record);
    expect(outcome).toEqual({ recovered: true, reason: 'resumed', attempt: 1 });
    expect(sleeps).toEqual([]);
    const stored = store.get(record.uuid).options;
    expect(stored.recoveryHistory).toEqual([
      '1: exit 137, oomKilled=true, resumed at 2026-10-01T10:06:00.000Z',
    ]);
    expect(stored.lastRecoveryDelayMs).toBeUndefined();
  });

  it('a --stop during the wait cancels the pending recovery', () => {
    const { store, record, logPath } = makeStore();
    let stopped = false;
    const { outcome, runner } = recover(store, record, {
      sleep: () => {
        if (!stopped) {
          stopped = true;
          // `docker stop` on the already exited container succeeds.
          controlExecution(store, record.uuid, ControlAction.STOP, () => ok());
        }
      },
    });
    expect(outcome).toMatchObject({
      recovered: false,
      reason: 'stop-requested',
      attempt: 1,
    });
    expect(runner.calls.some((call) => call[1] === 'start')).toBe(false);
    expect(fs.readFileSync(logPath, 'utf8')).toContain(
      '[Recovery 1/3] Not resuming: the session was stopped on request during the delay.'
    );
    expect(store.get(record.uuid).options.recoveryAttempts).toBeUndefined();
  });

  it('a --terminate of the exited container still cancels the recovery', () => {
    const { store, record } = makeStore();
    const result = controlExecution(
      store,
      record.uuid,
      ControlAction.TERMINATE,
      fakeRunner({
        kill: 'Error response from daemon: Cannot kill container: box: Container cid is not running',
      })
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('status recovery-cancelled');
    expect(store.get(record.uuid).options.stopRequestedAt).toBeTruthy();

    const { outcome } = recover(store, record);
    expect(outcome.reason).toBe('stop-requested');
  });

  it('a failed --terminate for another reason still restores the marker', () => {
    const { store, record } = makeStore();
    const result = controlExecution(
      store,
      record.uuid,
      ControlAction.TERMINATE,
      fakeRunner({ kill: 'permission denied' })
    );
    expect(result.success).toBe(false);
    expect(store.get(record.uuid).options.stopRequestedAt).toBeUndefined();
  });
});
