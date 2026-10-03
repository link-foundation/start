/**
 * Regression tests for issue #176:
 *
 *   1. `$ --resume <id> -- <cmd>` snapshots the stopped container with
 *      `docker commit` and starts a new one with `docker run`. `docker commit`
 *      does not keep the HostConfig, so the memory / CPU / PIDs limits the old
 *      container had (often applied later with `docker update`) were silently
 *      dropped. They must be read with `docker inspect` and re-applied.
 *   2. `--on-kill-resume N --recovery-command B` resumes a detached docker
 *      session whose main process was killed (exit 137 / OOMKilled) in the same
 *      container, under the same execution UUID and log, up to N times.
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
  getDockerContainerCleanupPolicy,
} = require('../src/lib/docker-cleanup');
const {
  buildResourceLimitsStatusLine,
  formatDockerBytes,
  formatDockerCpus,
  normalizeResourceLimits,
  parseDockerResourceLimits,
  readDockerResourceLimits,
} = require('../src/lib/docker-resource-limits');
const {
  buildDockerRuntimeArgs,
  buildDockerRuntimeMetadata,
  buildDockerRuntimeStatusLines,
} = require('../src/lib/isolation');
const {
  RECOVERY_ATTEMPT_ENV,
  RECOVERY_MARKER_PATH,
  RECOVERY_SELECTOR,
  buildRecoverySelectorArgs,
  formatRecoverySeparator,
  isKilledExit,
  recoverKilledExecution,
} = require('../src/lib/execution-recovery');
const {
  ResumeMode,
  buildResumePlan,
  resumeExecution,
} = require('../src/lib/execution-resume');
const {
  ControlAction,
  controlExecution,
  runCommand,
} = require('../src/lib/execution-control');
const { SessionState } = require('../src/lib/session-probe');
const { parseArgs } = require('../src/lib/args-parser');

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

const needsPosixShell = () => {
  if (process.platform !== 'win32') {
    return false;
  }
  console.log('  Skipping: the test needs a POSIX /bin/sh');
  return true;
};

/** HostConfig of the container from the issue after `docker update`. */
const UPDATED_HOST_CONFIG = {
  Memory: 268435456,
  MemorySwap: 268435456,
  NanoCpus: 500000000,
  CpuQuota: 0,
  CpuPeriod: 0,
  CpuShares: 0,
  CpusetCpus: '',
  PidsLimit: 64,
  ShmSize: 67108864,
  Ulimits: null,
};

const ISSUE_LIMITS = [
  '--memory=256m',
  '--memory-swap=256m',
  '--cpus=0.5',
  '--pids-limit=64',
];

function ok(stdout = '') {
  return { success: true, stdout, stderr: '', status: 0, error: null };
}

/** Fake `runner` that answers `docker inspect` and records every call. */
function fakeRunner(hostConfig, failures = {}) {
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
    if (args[0] === 'inspect' && args.includes('{{json .HostConfig}}')) {
      return ok(`${JSON.stringify(hostConfig)}\n`);
    }
    return ok('cid\n');
  };
  runner.calls = calls;
  return runner;
}

function stoppedProbe() {
  return {
    backend: 'docker',
    sessionName: 'box',
    state: SessionState.STOPPED,
    alive: false,
    containerStatus: 'exited',
  };
}

describe('issue #176: resource limits read from docker inspect', () => {
  it('formats sizes and CPUs the way docker run accepts them', () => {
    expect(formatDockerBytes(268435456)).toBe('256m');
    expect(formatDockerBytes(2 * 1024 ** 3)).toBe('2g');
    expect(formatDockerBytes(1536 * 1024)).toBe('1536k');
    expect(formatDockerBytes(1000)).toBe('1000');
    expect(formatDockerCpus(500000000)).toBe('0.5');
    expect(formatDockerCpus(1500000000)).toBe('1.5');
  });

  it('translates the HostConfig from the issue into run flags', () => {
    expect(parseDockerResourceLimits(UPDATED_HOST_CONFIG)).toEqual(
      ISSUE_LIMITS
    );
  });

  it('emits nothing for an unlimited container', () => {
    expect(
      parseDockerResourceLimits({
        Memory: 0,
        MemorySwap: 0,
        NanoCpus: 0,
        PidsLimit: null,
        ShmSize: 67108864,
      })
    ).toEqual([]);
    expect(parseDockerResourceLimits(null)).toEqual([]);
  });

  it('covers quota/period, cpusets, shm, storage options and ulimits', () => {
    expect(
      parseDockerResourceLimits({
        Memory: 512 * 1024 ** 2,
        MemorySwap: -1,
        MemoryReservation: 128 * 1024 ** 2,
        CpuQuota: 50000,
        CpuPeriod: 100000,
        CpuShares: 512,
        CpusetCpus: '0,1',
        CpusetMems: '0',
        PidsLimit: -1,
        ShmSize: 256 * 1024 ** 2,
        StorageOpt: { size: '10G' },
        Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 2048 }],
      })
    ).toEqual([
      '--memory=512m',
      '--memory-swap=-1',
      '--memory-reservation=128m',
      '--cpu-quota=50000',
      '--cpu-period=100000',
      '--cpu-shares=512',
      '--cpuset-cpus=0,1',
      '--cpuset-mems=0',
      '--shm-size=256m',
      '--storage-opt=size=10G',
      '--ulimit=nofile=1024:2048',
    ]);
  });

  it('never emits --memory-swap without --memory', () => {
    expect(parseDockerResourceLimits({ MemorySwap: 268435456 })).toEqual([]);
  });

  it('reads the HostConfig with docker inspect', () => {
    const runner = fakeRunner(UPDATED_HOST_CONFIG);
    expect(readDockerResourceLimits('box', runner)).toEqual(ISSUE_LIMITS);
    expect(runner.calls[0].slice(1)).toEqual([
      'inspect',
      '--format',
      '{{json .HostConfig}}',
      'box',
    ]);
    expect(
      readDockerResourceLimits('box', fakeRunner({}, { inspect: 'gone' }))
    ).toBeNull();
  });

  it('keeps stored limits as flags, including commas in cpusets', () => {
    expect(normalizeResourceLimits('--cpuset-cpus=0,1 --memory=1g')).toEqual([
      '--cpuset-cpus=0,1',
      '--memory=1g',
    ]);
    expect(normalizeResourceLimits(['--cpus=2', 'junk'])).toEqual(['--cpus=2']);
    expect(normalizeResourceLimits(null)).toEqual([]);
    expect(buildResourceLimitsStatusLine(ISSUE_LIMITS)).toBe(
      '[Isolation] Resource limits: --memory=256m --memory-swap=256m --cpus=0.5 --pids-limit=64'
    );
    expect(buildResourceLimitsStatusLine([])).toBeNull();
  });
});

describe('issue #176: snapshot resume keeps the resource limits', () => {
  function record(options = {}) {
    return {
      uuid: '11111111-2222-3333-4444-555555555555',
      status: 'executed',
      command: 'npm test',
      logPath: null,
      options: {
        isolated: 'docker',
        isolationMode: 'detached',
        sessionName: 'box',
        image: 'ubuntu:24.04',
        ...options,
      },
    };
  }

  it('passes the live limits to docker run of the -resume-N container', () => {
    const plan = buildResumePlan(
      record(),
      'npm run build',
      stoppedProbe(),
      ISSUE_LIMITS
    );
    expect(plan.mode).toBe(ResumeMode.DOCKER_SNAPSHOT);
    expect(plan.resourceLimits).toEqual(ISSUE_LIMITS);
    const runArgs = plan.steps[1].args;
    const imageIndex = runArgs.indexOf('start-command-resume/box:1');
    expect(runArgs.slice(imageIndex - ISSUE_LIMITS.length, imageIndex)).toEqual(
      ISSUE_LIMITS
    );
  });

  it('falls back to the limits stored in the record', () => {
    const plan = buildResumePlan(
      record({ resourceLimits: ['--memory=1g'] }),
      'npm run build',
      stoppedProbe(),
      null
    );
    expect(plan.steps[1].args).toContain('--memory=1g');
  });

  it('carries stored limits into a relaunch', () => {
    const plan = buildResumePlan(
      record({ resourceLimits: ['--pids-limit=64'] }),
      null,
      { backend: 'docker', state: SessionState.MISSING, alive: false }
    );
    expect(plan.mode).toBe(ResumeMode.RELAUNCH);
    expect(plan.launchOptions.resourceLimits).toEqual(['--pids-limit=64']);
  });

  it('inspects the old container before the commit and records the limits', async () => {
    const saved = [];
    const store = {
      get: () => record(),
      save: (r) => saved.push(JSON.parse(JSON.stringify(r))),
    };
    const runner = fakeRunner(UPDATED_HOST_CONFIG);
    const watchers = [];
    const result = await resumeExecution(store, 'box', {
      command: 'npm run build',
      probe: stoppedProbe,
      runner,
      startWatcher: (...args) => watchers.push(args),
    });
    expect(result.success).toBe(true);
    const verbs = runner.calls.map((call) => call[1]);
    expect(verbs.indexOf('inspect')).toBeLessThan(verbs.indexOf('commit'));
    const run = runner.calls.find((call) => call[1] === 'run');
    for (const flag of ISSUE_LIMITS) {
      expect(run).toContain(flag);
    }
    expect(saved[0].options.resourceLimits).toEqual(ISSUE_LIMITS);
    expect(saved[0].options.sessionName).toBe('box-resume-1');
    expect(result.output).toContain('--pids-limit=64');
    // A snapshot container has no recovery selector.
    expect(watchers[0][4]).toEqual({ recoverOnKill: false });
  });

  it('shows the limits in [Isolation] lines and stores them as metadata', () => {
    const options = { resourceLimits: ISSUE_LIMITS };
    expect(buildDockerRuntimeArgs(options)).toEqual(ISSUE_LIMITS);
    expect(buildDockerRuntimeStatusLines(options)).toContain(
      `[Isolation] Resource limits: ${ISSUE_LIMITS.join(' ')}`
    );
    expect(buildDockerRuntimeMetadata(options).resourceLimits).toEqual(
      ISSUE_LIMITS
    );
  });
});

describe('issue #176: --on-kill-resume / --recovery-command options', () => {
  const launch = (...flags) =>
    parseArgs(['--isolated', 'docker', '--detached', ...flags, '--', 'solve']);

  it('parses both options in separate and = forms', () => {
    const { wrapperOptions } = launch(
      '--on-kill-resume',
      '3',
      '--recovery-command',
      'solve --resume'
    );
    expect(wrapperOptions.onKillResume).toBe(3);
    expect(wrapperOptions.recoveryCommand).toBe('solve --resume');
    const eq = launch(
      '--on-kill-resume=2',
      '--recovery-command=b'
    ).wrapperOptions;
    expect(eq.onKillResume).toBe(2);
    expect(eq.recoveryCommand).toBe('b');
  });

  it('defaults to one attempt when only a recovery command is given', () => {
    expect(launch('--recovery-command', 'b').wrapperOptions.onKillResume).toBe(
      1
    );
  });

  it('rejects invalid counts and missing values', () => {
    expect(() => launch('--on-kill-resume', '0')).toThrow(/positive integer/);
    expect(() => launch('--on-kill-resume=x')).toThrow(/positive integer/);
    expect(() => launch('--recovery-command')).toThrow(/requires a command/);
    expect(() => launch('--recovery-command=')).toThrow(/non-empty/);
  });

  it('requires a detached docker-only session', () => {
    expect(() =>
      parseArgs(['--isolated', 'docker', '--on-kill-resume', '2', '--', 'a'])
    ).toThrow(/requires --detached/);
    expect(() =>
      parseArgs([
        '--isolated',
        'screen',
        '--detached',
        '--on-kill-resume',
        '2',
        '--',
        'a',
      ])
    ).toThrow(/only valid with --isolated docker/);
    expect(() => parseArgs(['--on-kill-resume', '2', '--', 'a'])).toThrow(
      /only valid with --isolated docker/
    );
  });

  it('describes the recovery in [Isolation] lines and metadata', () => {
    const options = { onKillResume: 3, recoveryCommand: 'solve --resume' };
    expect(buildDockerRuntimeStatusLines(options)).toContain(
      '[Isolation] On kill: resume up to 3 time(s) with solve --resume'
    );
    expect(buildDockerRuntimeMetadata(options)).toMatchObject({
      onKillResume: 3,
      recoveryCommand: 'solve --resume',
    });
    expect(buildDockerRuntimeStatusLines({ onKillResume: 1 })).toContain(
      '[Isolation] On kill: resume up to 1 time(s) with the original command'
    );
  });
});

describe('issue #176: recovery selector inside the container', () => {
  function runSelector(markerContent) {
    const dir = makeTempDir('selector-176-');
    const marker = path.join(dir, 'marker');
    if (markerContent !== null) {
      fs.writeFileSync(marker, markerContent);
    }
    const args = buildRecoverySelectorArgs(['sh', '-c', 'echo main'], {
      shell: 'sh',
      shellFlag: '',
      recoveryCommand: `echo "recovery $${RECOVERY_ATTEMPT_ENV}"`,
    });
    // Point the selector at a temp marker instead of `/` of a container.
    args[2] = args[2].split(RECOVERY_MARKER_PATH).join(marker);
    const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
    return result.stdout.trim();
  }

  it('runs the main command until a recovery is marked', () => {
    if (needsPosixShell()) {
      return;
    }
    expect(runSelector(null)).toBe('main');
    expect(runSelector('2\n')).toBe('recovery 2');
  });

  it('wraps the main argv after the recovery parameters', () => {
    expect(
      buildRecoverySelectorArgs(['bash', '-c', 'a'], {
        shell: 'bash',
        shellFlag: '-l',
        recoveryCommand: 'b',
      })
    ).toEqual([
      'sh',
      '-c',
      RECOVERY_SELECTOR,
      'start-command',
      'bash',
      '-l',
      'b',
      'bash',
      '-c',
      'a',
    ]);
  });
});

describe('issue #176: resuming a killed session', () => {
  function makeStore(options = {}) {
    const dir = makeTempDir('recovery-176-');
    const store = new ExecutionStore({
      appFolder: path.join(dir, 'app'),
      useLinks: false,
    });
    const logPath = path.join(dir, 'run.log');
    fs.writeFileSync(logPath, 'main output\n');
    const record = new ExecutionRecord({
      status: ExecutionStatus.EXECUTING,
      command: 'solve',
      logPath,
      options: {
        isolated: 'docker',
        isolationMode: 'detached',
        sessionName: 'box',
        onKillResume: 2,
        recoveryCommand: 'solve --resume',
        ...options,
      },
    });
    store.save(record);
    return { store, record, logPath };
  }

  function recover(store, record, extra = {}) {
    const runner = extra.runner || fakeRunner(UPDATED_HOST_CONFIG);
    const watchers = [];
    const outcome = recoverKilledExecution({
      store,
      executionId: record.uuid,
      exitCode: '137',
      oomKilled: 'true',
      startedAt: '2026-10-01T10:00:00Z',
      finishedAt: '2026-10-01T10:05:00Z',
      containerError: '',
      runner,
      startWatcher: (...args) => watchers.push(args),
      now: () => new Date('2026-10-01T10:05:01.000Z'),
      ...extra,
    });
    return { outcome, runner, watchers };
  }

  it('detects a kill by exit 137, or OOMKilled without an exit code', () => {
    expect(isKilledExit(137, false)).toBe(true);
    expect(isKilledExit('137', 'false')).toBe(true);
    expect(isKilledExit('-1', 'true')).toBe(true);
    expect(isKilledExit('1', 'false')).toBe(false);
  });

  it('formats the [Recovery k/N] separator', () => {
    expect(
      formatRecoverySeparator({
        attempt: 1,
        maxAttempts: 3,
        exitCode: 137,
        oomKilled: true,
        containerName: 'box',
        command: 'solve --resume',
      })
    ).toBe(
      '\n[Recovery 1/3] Main process was killed (exit 137, SIGKILL, oomKilled=true); resuming container box, running recovery command: solve --resume\n'
    );
  });

  it('marks the container, restarts it and keeps the same UUID and log', () => {
    const { store, record, logPath } = makeStore();
    const { outcome, runner, watchers } = recover(store, record);
    expect(outcome).toEqual({ recovered: true, reason: 'resumed', attempt: 1 });

    const cp = runner.calls.find((call) => call[1] === 'cp');
    expect(cp[3]).toBe(`box:${RECOVERY_MARKER_PATH}`);
    const verbs = runner.calls.map((call) => call[1]);
    expect(verbs.indexOf('cp')).toBeLessThan(verbs.indexOf('start'));
    expect(runner.calls.find((call) => call[1] === 'start')).toEqual([
      'docker',
      'start',
      'box',
    ]);

    const log = fs.readFileSync(logPath, 'utf8');
    expect(log.startsWith('main output\n')).toBe(true);
    expect(log).toContain('[Recovery 1/2] Main process was killed (exit 137');
    expect(log).toContain('running recovery command: solve --resume');
    expect(log).toContain(
      `[Isolation] Resource limits: ${ISSUE_LIMITS.join(' ')}`
    );

    const updated = store.get(record.uuid);
    expect(updated.uuid).toBe(record.uuid);
    expect(updated.status).toBe(ExecutionStatus.EXECUTING);
    expect(updated.options.recoveryAttempts).toBe(1);
    expect(updated.options.recoveryHistory).toEqual([
      '1: exit 137, oomKilled=true, resumed at 2026-10-01T10:05:01.000Z',
    ]);
    expect(updated.options.resourceLimits).toEqual(ISSUE_LIMITS);

    expect(watchers).toEqual([
      [
        'box',
        getDockerContainerCleanupPolicy(record.options),
        logPath,
        record.uuid,
        { since: '2026-10-01T10:05:01.000Z', recoverOnKill: true },
      ],
    ]);
  });

  it('re-runs the original command when no recovery command is set', () => {
    const { store, record, logPath } = makeStore({ recoveryCommand: null });
    const { outcome, runner } = recover(store, record);
    expect(outcome.recovered).toBe(true);
    expect(runner.calls.some((call) => call[1] === 'cp')).toBe(false);
    expect(fs.readFileSync(logPath, 'utf8')).toContain(
      'running the original command again'
    );
  });

  it('stops after N attempts', () => {
    const { store, record, logPath } = makeStore({ recoveryAttempts: 2 });
    const { outcome, runner } = recover(store, record);
    expect(outcome).toEqual({
      recovered: false,
      reason: 'attempts-exhausted',
    });
    expect(runner.calls).toEqual([]);
    expect(fs.readFileSync(logPath, 'utf8')).toContain(
      '[Recovery] Not resuming: all 2 recovery attempt(s) used.'
    );
  });

  it('does not undo a deliberate --stop', () => {
    const { store, record } = makeStore({
      stopRequestedAt: '2026-10-01T10:04:00Z',
    });
    expect(recover(store, record).outcome.reason).toBe('stop-requested');
  });

  it('ignores ordinary failures and sessions without recovery', () => {
    const { store, record } = makeStore();
    expect(
      recover(store, record, { exitCode: '1', oomKilled: 'false' }).outcome
        .reason
    ).toBe('not-killed');
    const plain = makeStore({ onKillResume: null, recoveryCommand: null });
    expect(recover(plain.store, plain.record).outcome.reason).toBe(
      'not-configured'
    );
  });

  it('reports a failed docker start in the log', () => {
    const { store, record, logPath } = makeStore();
    const { outcome } = recover(store, record, {
      runner: fakeRunner(UPDATED_HOST_CONFIG, { start: 'no such container' }),
    });
    expect(outcome.reason).toBe('resume-failed');
    expect(fs.readFileSync(logPath, 'utf8')).toContain(
      '[Recovery 1/2] Failed: docker start failed: no such container'
    );
    expect(store.get(record.uuid).options.recoveryAttempts).toBeUndefined();
  });

  it('marks a --stop so the watcher does not resume it', () => {
    const { store, record } = makeStore();
    const result = controlExecution(
      store,
      record.uuid,
      ControlAction.STOP,
      () => ok()
    );
    expect(result.success).toBe(true);
    expect(store.get(record.uuid).options.stopRequestedAt).toBeTruthy();

    const failed = makeStore();
    controlExecution(
      failed.store,
      failed.record.uuid,
      ControlAction.STOP,
      () => ({
        success: false,
        stdout: '',
        stderr: 'boom',
        status: 1,
      })
    );
    expect(
      failed.store.get(failed.record.uuid).options.stopRequestedAt
    ).toBeUndefined();
  });
});

describe('issue #176: completion watcher hands kills to the recovery', () => {
  it('builds the recovery branch only when requested', () => {
    const plain = buildDetachedDockerCompletionScript(
      'box',
      DOCKER_CONTAINER_CLEANUP_POLICY.KEEP,
      '/tmp/run.log',
      'uuid-1'
    );
    expect(plain).not.toContain('execution-recovery');
    const script = buildDetachedDockerCompletionScript(
      'box',
      DOCKER_CONTAINER_CLEANUP_POLICY.KEEP,
      '/tmp/run.log',
      'uuid-1',
      { since: '2026-10-01T10:05:01.000Z', recoverOnKill: true }
    );
    expect(script).toContain("--since '2026-10-01T10:05:01.000Z'");
    expect(script).toContain('execution-recovery.js');
    expect(script).toContain('= 137 ]');
    // Recovery runs before the cleanup / footer / finalize branch.
    expect(script.indexOf('execution-recovery.js')).toBeLessThan(
      script.indexOf('detached-finalize.js')
    );
  });

  /**
   * Run the real watcher against a fake docker that reports `state`, and
   * `afterStart` once `docker start` has been called (default: `state`).
   */
  function runWatcher(state, options, afterStart = state) {
    const dir = makeTempDir('watcher-176-');
    const binDir = path.join(dir, 'bin');
    const appFolder = path.join(dir, 'app');
    fs.mkdirSync(binDir);
    const logPath = path.join(dir, 'run.log');
    const dockerPath = path.join(binDir, 'docker');
    fs.writeFileSync(
      dockerPath,
      [
        '#!/bin/sh',
        `dir='${dir}'`,
        'echo "$*" >> "$dir/calls"',
        'case "$1" in',
        '  inspect)',
        '    case "$3" in',
        '      *State.Running*) echo false ;;',
        '      *State.Error*) echo "" ;;',
        '      *HostConfig*) echo "{}" ;;',
        `      *) if [ -e "$dir/started" ]; then echo '${afterStart}'; else echo '${state}'; fi ;;`,
        '    esac ;;',
        '  start) : > "$dir/started" ;;',
        '  logs) echo work ;;',
        '  wait) echo 137 ;;',
        'esac',
        '',
      ].join('\n')
    );
    fs.chmodSync(dockerPath, 0o755);
    const store = new ExecutionStore({ appFolder, useLinks: false });
    const record = new ExecutionRecord({
      status: ExecutionStatus.EXECUTING,
      command: 'solve',
      logPath,
      options: {
        isolated: 'docker',
        isolationMode: 'detached',
        sessionName: 'box',
        onKillResume: 1,
        ...options,
      },
    });
    store.save(record);
    const script = buildDetachedDockerCompletionScript(
      'box',
      DOCKER_CONTAINER_CLEANUP_POLICY.KEEP,
      logPath,
      record.uuid,
      { recoverOnKill: true }
    );
    spawnSync('/bin/sh', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        START_APP_FOLDER: appFolder,
        START_DISABLE_TRACKING: '',
      },
      timeout: 20000,
    });
    const read = () => ({
      calls: fs.readFileSync(path.join(dir, 'calls'), 'utf8'),
      log: fs.readFileSync(logPath, 'utf8'),
      record: new ExecutionStore({ appFolder, useLinks: false }).get(
        record.uuid
      ),
    });
    // A resumed run is finalized by the detached watcher the recovery starts.
    const deadline = Date.now() + 15000;
    while (read().record.status !== ExecutionStatus.EXECUTED) {
      if (Date.now() > deadline) {
        break;
      }
      spawnSync('sleep', ['0.2']);
    }
    return read();
  }

  const KILLED =
    '137 true 2026-10-01T10:00:00.000000000Z 2026-10-01T10:05:00.000000000Z';
  const FAILED =
    '1 false 2026-10-01T10:00:00.000000000Z 2026-10-01T10:05:00.000000000Z';

  const DONE =
    '0 false 2026-10-01T10:05:01.000000000Z 2026-10-01T10:06:00.000000000Z';

  it('resumes a killed run through the real recovery entry point', () => {
    if (needsPosixShell()) {
      return;
    }
    // The watcher runs `execution-recovery.js` as the main module, which
    // starts the next watcher; that used to throw on a half-built exports
    // object, so the old watcher finalized the resumed run as exit 137.
    const { calls, log, record } = runWatcher(KILLED, {}, DONE);
    expect(calls).toContain('start box');
    expect(calls).toContain('--since');
    expect(log).toContain('[Recovery 1/1]');
    expect(log).not.toContain('Exit Code: 137');
    expect(record.status).toBe(ExecutionStatus.EXECUTED);
    expect(record.exitCode).toBe(0);
    expect(record.options.recoveryAttempts).toBe(1);
  }, 30000);

  it('finalizes an ordinary failure without resuming', () => {
    if (needsPosixShell()) {
      return;
    }
    const { calls, log, record } = runWatcher(FAILED, {});
    expect(calls).not.toContain('start box');
    expect(log).not.toContain('[Recovery');
    expect(record.status).toBe(ExecutionStatus.EXECUTED);
    expect(record.exitCode).toBe(1);
  });

  it('finalizes a stopped session instead of resuming it', () => {
    if (needsPosixShell()) {
      return;
    }
    const { calls, log, record } = runWatcher(KILLED, {
      stopRequestedAt: '2026-10-01T10:04:00Z',
    });
    expect(calls).not.toContain('start box');
    expect(log).toContain('[Recovery] Not resuming: the session was stopped');
    expect(record.status).toBe(ExecutionStatus.EXECUTED);
    expect(record.exitCode).toBe(137);
  });

  it('finalizes once the attempts are used up', () => {
    if (needsPosixShell()) {
      return;
    }
    const { calls, log, record } = runWatcher(KILLED, {
      recoveryAttempts: 1,
    });
    expect(calls).not.toContain('start box');
    expect(log).toContain('all 1 recovery attempt(s) used');
    expect(record.status).toBe(ExecutionStatus.EXECUTED);
  });
});

/**
 * End-to-end check against a real Docker daemon: a limit applied with
 * `docker update` must be present on the `-resume-1` container. Skipped when
 * Docker cannot run Linux containers here.
 */
describe('issue #176: real docker snapshot resume', () => {
  const docker = (...args) => runCommand('docker', args);
  const image = 'alpine:3.20';

  function dockerUsable() {
    if (process.platform === 'win32' || !docker('info').success) {
      return false;
    }
    return (
      docker('image', 'inspect', image).success || docker('pull', image).success
    );
  }

  it('re-applies docker update limits to the -resume-1 container', async () => {
    if (!dockerUsable()) {
      console.log('  Skipping: docker with Linux containers is unavailable');
      return;
    }
    const name = `start-command-176-${process.pid}`;
    const resumed = `${name}-resume-1`;
    const snapshot = `start-command-resume/${name}:1`;
    try {
      expect(
        docker('run', '-d', '--name', name, image, 'sleep', '1').success
      ).toBe(true);
      expect(docker('update', '--pids-limit', '64', name).success).toBe(true);
      // Memory limits need cgroup support that nested daemons may lack.
      const memory = docker(
        'update',
        '--memory',
        '256m',
        '--memory-swap',
        '256m',
        name
      ).success;
      docker('wait', name);

      const dir = makeTempDir('real-176-');
      const store = new ExecutionStore({
        appFolder: path.join(dir, 'app'),
        useLinks: false,
      });
      const record = new ExecutionRecord({
        status: ExecutionStatus.EXECUTED,
        command: 'sleep 1',
        logPath: path.join(dir, 'run.log'),
        options: {
          isolated: 'docker',
          isolationMode: 'detached',
          sessionName: name,
          image,
        },
      });
      store.save(record);

      const result = await resumeExecution(store, record.uuid, {
        command: 'sleep 30',
        startWatcher: () => {},
      });
      expect(result.success).toBe(true);

      const inspected = docker(
        'inspect',
        '--format',
        '{{json .HostConfig}}',
        resumed
      );
      expect(inspected.success).toBe(true);
      const hostConfig = JSON.parse(inspected.stdout);
      expect(hostConfig.PidsLimit).toBe(64);
      if (memory) {
        expect(hostConfig.Memory).toBe(268435456);
        expect(hostConfig.MemorySwap).toBe(268435456);
      }
      expect(store.get(record.uuid).options.resourceLimits).toContain(
        '--pids-limit=64'
      );
    } finally {
      docker('rm', '-f', name, resumed);
      docker('rmi', '-f', snapshot);
    }
  }, 120000);
});
