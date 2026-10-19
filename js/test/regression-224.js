/**
 * Regression tests for issue #224: a Docker snapshot resume (`$ --resume` of a
 * container without a command handoff) could not wait for the snapshot lock
 * or for disk, removed the original after a single instant check, offered no
 * way to remove the snapshot images of a container the caller removed, said
 * nothing during a long `docker commit`, always walked the layer with
 * `docker inspect --size`, and had no hook to shrink the layer first.
 */

// Own snapshot lock even without the bunfig.toml preload (issue #234).
require('./setup/private-snapshot-lock');
const { describe, it, expect, afterEach } = require('bun:test');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs } = require('../src/lib/args-parser');
const {
  EX_TEMPFAIL,
  acquireSnapshotLock,
  preflightSnapshot,
} = require('../src/lib/docker-snapshot-safety');
const {
  commitWithProgress,
  formatElapsed,
} = require('../src/lib/docker-snapshot-resume');
const { resumeExecution } = require('../src/lib/execution-resume');
const {
  chainImages,
  cleanupExecution,
} = require('../src/lib/execution-cleanup');
const { SessionState } = require('../src/lib/session-probe');
const {
  ExecutionRecord,
  ExecutionStatus,
  ExecutionStore,
} = require('../src/lib/execution-store');

const GiB = 1024 ** 3;
const tempDirs = [];
const children = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (children.length > 0) {
    children.pop().kill('SIGKILL');
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const SAFETY = require.resolve('../src/lib/docker-snapshot-safety');

/** Hold the snapshot lock in another process for `holdMs`. */
async function holdLockElsewhere(lockPath, holder, holdMs) {
  const ready = `${lockPath}.ready`;
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const lock = require(${JSON.stringify(SAFETY)}).acquireSnapshotLock({lockPath: ${JSON.stringify(lockPath)}, holder: ${JSON.stringify(holder)}});
       require('fs').writeFileSync(${JSON.stringify(ready)}, '1');
       setTimeout(() => { lock.release(); process.exit(0); }, ${holdMs});`,
    ],
    { stdio: 'ignore' }
  );
  children.push(child);
  for (let i = 0; i < 200 && !fs.existsSync(ready); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(fs.existsSync(ready)).toBe(true);
  return child;
}

function snapshotRecord(options = {}) {
  let current = {
    uuid: 'issue-224-uuid',
    command: 'original',
    status: 'executed',
    exitCode: 137,
    logPath: path.join(makeTempDir('log-224-'), 'execution.log'),
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: 'box',
      containerId: 'old-id',
      ...options,
    },
  };
  const store = {
    get: () => globalThis.structuredClone(current),
    save: (record) => {
      current = globalThis.structuredClone(record);
    },
  };
  return { store, current: () => current };
}

/**
 * Fake docker for a snapshot resume; `answers[subcommand]` may override a
 * call by returning a result.
 */
function fakeDocker(calls, answers = {}) {
  return (_bin, args) => {
    calls.push(args);
    const answer = answers[args[0]]?.(args);
    if (answer) {
      return answer;
    }
    const stdout =
      args[0] === 'info'
        ? JSON.stringify({ DockerRootDir: '/docker' })
        : args.includes('--size')
          ? String(GiB)
          : args.includes('{{.State.Running}}')
            ? 'true'
            : args.includes('{{json .HostConfig}}')
              ? '{}'
              : args[0] === 'run'
                ? 'new-container-id'
                : '';
    return { success: true, stdout, stderr: '', status: 0 };
  };
}

const stopped = () => ({ state: SessionState.STOPPED, alive: false });
const plentyOfDisk = { freeBytes: () => 100 * GiB };

describe('issue #224: options', () => {
  it('parses every new option in both forms and keeps them on --resume', () => {
    const { wrapperOptions } = parseArgs([
      '--resume',
      'box',
      '--snapshot-wait',
      '600',
      '--snapshot-disk-wait=1800',
      '--remove-original-after',
      '30',
      '--snapshot-size-hint=12g',
      '--snapshot-prepare',
      'rm -rf /workspace/target',
    ]);
    expect(wrapperOptions.snapshotWait).toBe(600);
    expect(wrapperOptions.snapshotDiskWait).toBe(1800);
    expect(wrapperOptions.removeOriginalAfter).toBe(30);
    expect(wrapperOptions.snapshotSizeHint).toBe(12 * GiB);
    expect(wrapperOptions.snapshotPrepare).toBe('rm -rf /workspace/target');
    // A startup window is a removal request.
    expect(wrapperOptions.removeOriginal).toBe(true);
  });

  it('accepts fractions and plain byte counts', () => {
    const { wrapperOptions } = parseArgs([
      '--resume=box',
      '--snapshot-wait=0.5',
      '--snapshot-size-hint',
      '1024',
    ]);
    expect(wrapperOptions.snapshotWait).toBe(0.5);
    expect(wrapperOptions.snapshotSizeHint).toBe(1024);
  });

  it('rejects the options outside --resume and malformed values', () => {
    for (const flag of [
      '--snapshot-wait=1',
      '--snapshot-disk-wait=1',
      '--remove-original-after=1',
      '--snapshot-size-hint=1',
      '--snapshot-prepare=true',
    ]) {
      const name = flag.split('=')[0];
      expect(() => parseArgs([flag, '--', 'echo'])).toThrow(
        `${name} is only valid with --resume`
      );
    }
    expect(() =>
      parseArgs(['--resume', 'box', '--snapshot-wait', '-1'])
    ).toThrow(/requires a seconds argument/);
    expect(() =>
      parseArgs(['--resume', 'box', '--snapshot-wait=soon'])
    ).toThrow(/Invalid --snapshot-wait value/);
    expect(() =>
      parseArgs(['--resume', 'box', '--snapshot-size-hint=12 GiB'])
    ).toThrow(/Invalid --snapshot-size-hint value/);
    expect(() => parseArgs(['--resume', 'box', '--snapshot-prepare='])).toThrow(
      /non-empty command/
    );
  });

  it('takes both waits from the environment unless a flag sets them', () => {
    // Only these two keys are restored: replacing `process.env` itself would
    // drop its case-insensitive keys on Windows (PATH vs Path, ComSpec) and
    // break every later spawn in this Bun process.
    const names = ['START_SNAPSHOT_LOCK_WAIT', 'START_SNAPSHOT_DISK_WAIT'];
    const saved = names.map((name) => process.env[name]);
    process.env.START_SNAPSHOT_LOCK_WAIT = '120';
    process.env.START_SNAPSHOT_DISK_WAIT = '60';
    try {
      const fromEnv = parseArgs(['--resume', 'box']).wrapperOptions;
      expect(fromEnv.snapshotWait).toBe(120);
      expect(fromEnv.snapshotDiskWait).toBe(60);
      const fromFlag = parseArgs([
        '--resume',
        'box',
        '--snapshot-wait=5',
      ]).wrapperOptions;
      expect(fromFlag.snapshotWait).toBe(5);
      // Other modes ignore the variables.
      expect(parseArgs(['--status', 'box']).wrapperOptions.snapshotWait).toBe(
        null
      );
      process.env.START_SNAPSHOT_LOCK_WAIT = 'later';
      expect(() => parseArgs(['--resume', 'box'])).toThrow(
        /START_SNAPSHOT_LOCK_WAIT/
      );
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[index];
        }
      });
    }
  });

  it('gives --cleanup and --cleanup-dry-run an optional execution', () => {
    expect(parseArgs(['--cleanup']).wrapperOptions.cleanupTarget).toBe(null);
    expect(parseArgs(['--cleanup', 'box']).wrapperOptions).toMatchObject({
      cleanup: true,
      cleanupDryRun: false,
      cleanupTarget: 'box',
    });
    expect(parseArgs(['--cleanup-dry-run=box']).wrapperOptions).toMatchObject({
      cleanup: true,
      cleanupDryRun: true,
      cleanupTarget: 'box',
    });
    expect(() => parseArgs(['--cleanup='])).toThrow(/requires a UUID/);
  });
});

describe('issue #224 item 1: waiting for the snapshot lock', () => {
  it('fails fast with exit code 75 and names the holder by default', async () => {
    const lockPath = path.join(makeTempDir('lock-224-'), 'snapshot.lock');
    await holdLockElsewhere(lockPath, 'task-a', 10000);
    let error;
    try {
      acquireSnapshotLock({ lockPath, holder: 'task-b' });
    } catch (caught) {
      error = caught;
    }
    expect(error.exitCode).toBe(EX_TEMPFAIL);
    expect(error.message).toContain('resume of task-a is in progress');
    expect(error.message).toContain('--snapshot-wait');
  });

  it('waits for the holder with --snapshot-wait and says so once', async () => {
    const lockPath = path.join(makeTempDir('lock-224-'), 'snapshot.lock');
    await holdLockElsewhere(lockPath, 'task-a', 1500);
    const lines = [];
    const started = Date.now();
    const lock = acquireSnapshotLock({
      lockPath,
      holder: 'task-b',
      waitSeconds: 20,
      notify: (line) => lines.push(line),
    });
    try {
      expect(Date.now() - started).toBeGreaterThan(900);
      expect(lines).toEqual([
        '[Resume] Waiting up to 20s for the snapshot of task-a to finish before snapshotting task-b.',
      ]);
      // The new holder is published for the next waiter.
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).holder).toBe(
        'task-b'
      );
    } finally {
      lock.release();
    }
  });

  it('gives up with exit code 75 when the wait runs out', async () => {
    const lockPath = path.join(makeTempDir('lock-224-'), 'snapshot.lock');
    await holdLockElsewhere(lockPath, 'task-a', 10000);
    let error;
    try {
      acquireSnapshotLock({
        lockPath,
        holder: 'task-b',
        waitSeconds: 1.5,
        notify: () => {},
      });
    } catch (caught) {
      error = caught;
    }
    expect(error.exitCode).toBe(EX_TEMPFAIL);
    expect(error.message).toContain('Still busy after waiting 1.5s');
  });

  it('serializes two concurrent CLI resumes instead of failing the second', async () => {
    const lockPath = path.join(makeTempDir('lock-224-'), 'snapshot.lock');
    await holdLockElsewhere(lockPath, 'task-a', 1200);
    const { store } = snapshotRecord();
    const calls = [];
    const lines = [];
    const result = await resumeExecution(store, 'box', {
      command: 'true',
      probe: stopped,
      runner: fakeDocker(calls),
      snapshotOptions: { ...plentyOfDisk, lockPath, waitSeconds: 10 },
      notify: (line) => lines.push(line),
      startWatcher: () => true,
    });
    expect(result.success).toBe(true);
    expect(lines[0]).toContain('snapshot of task-a to finish');
    expect(calls.some((args) => args[0] === 'commit')).toBe(true);
  });

  it('reports exit code 75 from a busy lock without committing', async () => {
    const lockPath = path.join(makeTempDir('lock-224-'), 'snapshot.lock');
    await holdLockElsewhere(lockPath, 'task-a', 10000);
    const { store, current } = snapshotRecord();
    const calls = [];
    const result = await resumeExecution(store, 'box', {
      command: 'true',
      probe: stopped,
      runner: fakeDocker(calls),
      snapshotOptions: { ...plentyOfDisk, lockPath },
      startWatcher: () => true,
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(75);
    expect(calls.some((args) => args[0] === 'commit')).toBe(false);
    expect(current().options.sessionName).toBe('box');
    const { reportResult } = require('../src/lib/query-commands');
    const original = console.error;
    console.error = () => {};
    try {
      expect(reportResult(result)).toBe(75);
    } finally {
      console.error = original;
    }
  });
});

describe('issue #224 item 2: waiting for disk', () => {
  function clock() {
    let now = 0;
    return {
      now: () => now,
      sleep: (ms) => {
        now += ms;
      },
    };
  }

  it('re-checks free space until it suffices, measuring the layer once', () => {
    const calls = [];
    const free = [5 * GiB, 8 * GiB, 40 * GiB];
    const lines = [];
    const result = preflightSnapshot('box', fakeDocker(calls), {
      freeBytes: () => free.shift(),
      diskWaitSeconds: 600,
      diskPollSeconds: 10,
      notify: (line) => lines.push(line),
      ...clock(),
    });
    expect(result.required).toBe(12 * GiB);
    expect(calls.filter((args) => args.includes('--size'))).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[Resume\] Waiting up to 600s for disk: Insufficient disk at \/docker: need 12\.00 GiB/
    );
  });

  it('refuses with exit code 75 when the wait runs out, or at once without one', () => {
    let error;
    try {
      preflightSnapshot('box', fakeDocker([]), {
        freeBytes: () => GiB,
        diskWaitSeconds: 30,
        diskPollSeconds: 10,
        notify: () => {},
        ...clock(),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error.exitCode).toBe(75);
    expect(error.message).toContain('Still short after waiting 30s');
    try {
      preflightSnapshot('box', fakeDocker([]), { freeBytes: () => GiB });
    } catch (caught) {
      error = caught;
    }
    expect(error.exitCode).toBe(75);
    expect(error.message).toContain('Docker snapshot resume refused');
  });

  it('keeps exit code 1 for a layer it cannot measure', () => {
    let error;
    try {
      preflightSnapshot(
        'box',
        fakeDocker([], {
          inspect: () => ({ success: false, stdout: '', stderr: 'boom' }),
        })
      );
    } catch (caught) {
      error = caught;
    }
    expect(error.message).toContain('writable layer size');
    expect(error.exitCode).toBe(undefined);
  });
});

describe('issue #224 item 3: --remove-original-after', () => {
  it('removes the original only after the window, once the watcher is attached', async () => {
    const { store } = snapshotRecord();
    const calls = [];
    const events = [];
    const result = await resumeExecution(store, 'box', {
      command: 'true',
      probe: stopped,
      runner: fakeDocker(calls),
      removeOriginal: true,
      removeOriginalAfter: 30,
      snapshotOptions: plentyOfDisk,
      notify: () => {},
      sleep: async (ms) => {
        events.push(`sleep ${ms}`);
      },
      startWatcher: () => {
        events.push('watcher');
        return true;
      },
    });
    expect(result.success).toBe(true);
    expect(events).toEqual(['watcher', 'sleep 30000']);
    const running = calls.filter((args) => args.includes('{{.State.Running}}'));
    expect(running).toEqual([
      ['inspect', '-f', '{{.State.Running}}', 'box-resume-1'],
    ]);
    expect(calls.at(-1)).toEqual(['rm', 'box']);
    expect(result.output).toContain('Stopped original container removed: box');
  });

  it('keeps the original when the replacement died within the window', async () => {
    const { store } = snapshotRecord();
    const calls = [];
    const result = await resumeExecution(store, 'box', {
      command: 'true',
      probe: stopped,
      runner: fakeDocker(calls, {
        inspect: (args) =>
          args.includes('{{.State.Running}}')
            ? { success: true, stdout: 'false' }
            : undefined,
      }),
      removeOriginal: true,
      removeOriginalAfter: 5,
      snapshotOptions: plentyOfDisk,
      notify: () => {},
      sleep: async () => {},
      startWatcher: () => true,
    });
    expect(result.success).toBe(true);
    expect(calls.some((args) => args[0] === 'rm')).toBe(false);
    expect(result.output).toContain(
      'Original container retained: the snapshot container is not running 5s after launch.'
    );
  });
});

describe('issue #224 item 4: $ --cleanup <execution>', () => {
  function chainRecord(overrides = {}) {
    return new ExecutionRecord({
      command: 'true',
      status: ExecutionStatus.EXECUTED,
      exitCode: 0,
      startTime: '2026-10-19T00:00:00.000Z',
      endTime: '2026-10-19T00:00:10.000Z',
      options: {
        isolated: 'docker',
        isolationMode: 'detached',
        sessionName: 'box-resume-1-resume-2',
        sessionNameHistory: ['box', 'box-resume-1'],
        snapshotImage: 'start-command-resume/box-resume-1:2',
        containerId: 'c0ffee',
      },
      ...overrides,
    });
  }

  function storeWith(record) {
    const store = new ExecutionStore({
      appFolder: makeTempDir('store-224-'),
      useLinks: false,
    });
    store.save(record);
    return store;
  }

  const gone = (kind) => (args) => ({
    success: false,
    stdout: '',
    stderr: `Error response from daemon: No such ${kind}: ${args.at(-1)}`,
    status: 1,
  });

  it('derives the images of a resume chain newest first', () => {
    expect(chainImages('box-resume-1-resume-2')).toEqual([
      'start-command-resume/box-resume-1:2',
      'start-command-resume/box:1',
    ]);
    expect(chainImages('box')).toEqual([]);
  });

  it('removes the containers, then their snapshot images, never forced', () => {
    const record = chainRecord();
    const store = storeWith(record);
    const calls = [];
    const result = cleanupExecution(store, record.uuid, {
      runner: fakeDocker(calls, {
        inspect: (args) =>
          args.at(-1) === 'box-resume-1'
            ? {
                success: true,
                stdout: 'start-command-resume/box:1\n',
              }
            : gone('container')(args),
        rm: (args) =>
          args.at(-1) === 'box'
            ? gone('container')(args)
            : { success: true, stdout: '' },
      }),
    });
    expect(result.success).toBe(true);
    const removals = calls.filter((args) => ['rm', 'rmi'].includes(args[0]));
    expect(removals).toEqual([
      ['rm', 'box-resume-1-resume-2'],
      ['rm', 'box-resume-1'],
      ['rm', 'box'],
      ['rmi', 'start-command-resume/box-resume-1:2'],
      ['rmi', 'start-command-resume/box:1'],
    ]);
    expect(result.output.split('\n')).toEqual([
      'Removed container box-resume-1-resume-2',
      'Removed container box-resume-1',
      'Already gone: container box',
      'Removed image start-command-resume/box-resume-1:2',
      'Removed image start-command-resume/box:1',
    ]);
    // Issue #225: the status now says the container is gone.
    expect(store.get(record.uuid).containerState).toBe('removed');
  });

  it('reports what Docker keeps and fails without forcing it', () => {
    const record = chainRecord();
    const store = storeWith(record);
    const result = cleanupExecution(store, record.uuid, {
      runner: fakeDocker([], {
        inspect: gone('container'),
        rm: () => ({ success: true, stdout: '' }),
        rmi: (args) =>
          args.at(-1).endsWith(':1')
            ? {
                success: false,
                stderr:
                  'Error response from daemon: conflict: unable to remove repository reference (must force) - container 1234 is using its referenced image',
                status: 1,
              }
            : { success: true, stdout: '' },
      }),
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain(
      'Retained image start-command-resume/box:1 (Error response from daemon: conflict'
    );
    expect(result.error).toBe(
      '1 Docker object(s) retained; nothing was forced.'
    );
  });

  it('only lists with --cleanup-dry-run', () => {
    const record = chainRecord();
    const store = storeWith(record);
    const calls = [];
    const result = cleanupExecution(store, record.uuid, {
      dryRun: true,
      runner: fakeDocker(calls, {
        image: gone('image'),
        inspect: gone('container'),
      }),
    });
    expect(result.success).toBe(true);
    expect(calls.some((args) => ['rm', 'rmi'].includes(args[0]))).toBe(false);
    expect(result.output.split('\n')[0]).toBe(
      'Would remove container box-resume-1-resume-2'
    );
    expect(result.output).toContain(
      'Already gone: image start-command-resume/box:1'
    );
    expect(store.get(record.uuid).containerState).toBe(undefined);
  });

  it('refuses unknown and non-Docker executions', () => {
    const store = storeWith(
      chainRecord({ options: { isolated: 'screen', sessionName: 's' } })
    );
    expect(cleanupExecution(store, 'missing').error).toContain(
      'No execution found'
    );
    expect(cleanupExecution(store, 's').error).toContain(
      'is not a Docker execution'
    );
  });

  it('runs from the command line with a stub docker', () => {
    if (process.platform === 'win32') {
      return;
    }
    const appFolder = makeTempDir('app-224-');
    const record = chainRecord();
    new ExecutionStore({ appFolder, useLinks: false }).save(record);
    const bin = makeTempDir('bin-224-');
    const docker = path.join(bin, 'docker');
    fs.writeFileSync(
      docker,
      [
        '#!/bin/sh',
        `echo "$*" >> '${bin}/calls'`,
        'case "$1" in',
        '  inspect) echo "no such object: $4" >&2; exit 1;;',
        '  rm|rmi) exit 0;;',
        'esac',
        'exit 1',
        '',
      ].join('\n')
    );
    fs.chmodSync(docker, 0o755);
    const run = spawnSync(
      process.execPath,
      [path.join(__dirname, '../src/bin/cli.js'), '--cleanup', 'box'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          START_APP_FOLDER: appFolder,
          START_DOCKER_BIN: docker,
        },
      }
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Removed container box-resume-1-resume-2');
    expect(run.stdout).toContain('Removed image start-command-resume/box:1');
    const removals = fs
      .readFileSync(`${bin}/calls`, 'utf8')
      .split('\n')
      .filter((line) => /^(rm|rmi) /.test(line));
    expect(removals).toHaveLength(5);
    expect(removals.some((line) => /\s(-f|--force)\b/.test(line))).toBe(false);
  });
});

describe('issue #224 item 5: progress during docker commit', () => {
  it('formats elapsed time in seconds, then minutes', () => {
    expect(formatElapsed(45)).toBe('45s');
    expect(formatElapsed(720)).toBe('12 min');
    expect(formatElapsed(725)).toBe('12 min 5s');
  });

  it('writes elapsed-time lines to the log while the commit runs', async () => {
    const logPath = path.join(makeTempDir('log-224-'), 'execution.log');
    const lines = [];
    const result = await commitWithProgress(
      { command: 'docker', args: ['commit', 'box', 'image'] },
      {
        sessionName: 'box',
        logPath,
        notify: (line) => lines.push(line),
        intervalSeconds: 0.05,
        runAsync: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ success: true, stdout: 'sha' }), 400)
          ),
      }
    );
    expect(result.stdout).toBe('sha');
    const log = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(log.length).toBeGreaterThan(2);
    expect(log[0]).toBe(
      '[Resume] snapshotting box: 0s elapsed (docker commit reports no progress)'
    );
    expect(log.at(-1)).toBe('[Resume] snapshot of box committed after 0s');
    expect(lines).toEqual(log);
  });

  it('logs the commit of a real resume', async () => {
    const { store, current } = snapshotRecord();
    const result = await resumeExecution(store, 'box', {
      command: 'true',
      probe: stopped,
      runner: fakeDocker([]),
      snapshotOptions: plentyOfDisk,
      notify: () => {},
      startWatcher: () => true,
    });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(current().logPath, 'utf8')).toContain(
      '[Resume] snapshot of box committed after'
    );
  });
});

describe('issue #224 item 6: --snapshot-size-hint', () => {
  it('skips docker inspect --size', () => {
    const calls = [];
    const result = preflightSnapshot('box', fakeDocker(calls), {
      freeBytes: () => 100 * GiB,
      sizeHint: 4 * GiB,
    });
    expect(calls.some((args) => args.includes('--size'))).toBe(false);
    expect(result.required).toBe(18 * GiB);
    expect(result.message).toBe(
      '[Resume] snapshotting 4.00 GiB (size hint); disk preflight passed (18.00 GiB required).'
    );
  });
});

describe('issue #224 item 7: --snapshot-prepare', () => {
  it('starts, execs, kills and waits the original before the preflight and commit', async () => {
    const { store } = snapshotRecord();
    const calls = [];
    const result = await resumeExecution(store, 'box', {
      command: 'true',
      probe: stopped,
      runner: fakeDocker(calls),
      snapshotOptions: { ...plentyOfDisk, prepare: 'rm -rf /tmp/cache' },
      notify: () => {},
      startWatcher: () => true,
    });
    expect(result.success).toBe(true);
    const order = calls.map((args) => args.slice(0, 2).join(' '));
    const prepare = order.indexOf('start box');
    expect(order.slice(prepare, prepare + 4)).toEqual([
      'start box',
      'exec box',
      'kill box',
      'wait box',
    ]);
    expect(calls[order.indexOf('exec box')]).toEqual([
      'exec',
      'box',
      'sh',
      '-c',
      'rm -rf /tmp/cache',
    ]);
    expect(prepare).toBeLessThan(
      calls.findIndex((args) => args.includes('--size'))
    );
    expect(order.indexOf('wait box')).toBeLessThan(order.indexOf('commit box'));
  });

  it('still kills the original and snapshots when the command fails', async () => {
    const { store, current } = snapshotRecord();
    const calls = [];
    const result = await resumeExecution(store, 'box', {
      command: 'true',
      probe: stopped,
      runner: fakeDocker(calls, {
        exec: () => ({ success: false, stderr: 'rm: busy', status: 1 }),
      }),
      snapshotOptions: { ...plentyOfDisk, prepare: 'rm -rf /busy' },
      notify: () => {},
      startWatcher: () => true,
    });
    expect(result.success).toBe(true);
    expect(calls.some((args) => args[0] === 'kill')).toBe(true);
    expect(calls.some((args) => args[0] === 'commit')).toBe(true);
    expect(fs.readFileSync(current().logPath, 'utf8')).toContain(
      '[Resume] snapshot prepare failed in box (rm: busy); snapshotting the files as they are'
    );
  });

  it('never runs for a docker start resume, which commits nothing', async () => {
    const { store } = snapshotRecord({ commandHandoff: true });
    const calls = [];
    const result = await resumeExecution(store, 'box', {
      command: 'true',
      probe: stopped,
      runner: fakeDocker(calls),
      snapshotOptions: { ...plentyOfDisk, prepare: 'rm -rf /tmp/cache' },
      startWatcher: () => true,
    });
    expect(result.success).toBe(true);
    expect(calls.some((args) => args[0] === 'exec')).toBe(false);
    expect(calls.some((args) => args[0] === 'commit')).toBe(false);
  });
});
