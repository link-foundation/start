/**
 * Regression tests for issue #178:
 *
 *   `--on-kill-resume N` resumed an execution whenever Docker reported
 *   `State.OOMKilled=true`, whatever the exit code. Docker sets that flag when
 *   *any* process in the container's cgroup is OOM-killed (a compiler, a test
 *   runner, a child `node`) and keeps it set until the container is started
 *   again. A main process that survived that and then exited 0 (success) or 1
 *   (a deliberate failure) on its own was resumed as if it had been killed.
 *
 *   A container counts as killed only when the main process was: exit 137,
 *   or `OOMKilled=true` with no usable exit code (the watcher's `-1`).
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
const { SHELL_VARS } = require('../src/lib/docker-post-mortem');
const {
  buildRecoverySnippet,
  isKilledExit,
  recoverKilledExecution,
} = require('../src/lib/execution-recovery');

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

const needsPosixShell = () => {
  if (process.platform !== 'win32') {
    return false;
  }
  console.log('  Skipping: the test needs a POSIX /bin/sh');
  return true;
};

/** `(exitCode, oomKilled)` pairs from the issue and whether they are kills. */
const CASES = [
  ['137', 'false', true],
  ['137', 'true', true],
  ['0', 'true', false],
  ['1', 'true', false],
  ['1', 'false', false],
  ['0', 'false', false],
  ['-1', 'true', true],
  ['-1', 'false', false],
];

describe('issue #178: sticky OOMKilled is not a kill of the main process', () => {
  it('isKilledExit only trusts OOMKilled without an exit code', () => {
    for (const [exitCode, oomKilled, killed] of CASES) {
      expect([exitCode, oomKilled, isKilledExit(exitCode, oomKilled)]).toEqual([
        exitCode,
        oomKilled,
        killed,
      ]);
    }
    expect(isKilledExit(137, false)).toBe(true);
    expect(isKilledExit(0, true)).toBe(false);
    expect(isKilledExit(1, true)).toBe(false);
    expect(isKilledExit(null, true)).toBe(true);
    expect(isKilledExit(undefined, 'true')).toBe(true);
    expect(isKilledExit('', 'true')).toBe(true);
    expect(isKilledExit(null, false)).toBe(false);
  });

  it('the watcher shell condition agrees with isKilledExit', () => {
    if (needsPosixShell()) {
      return;
    }
    // Only the condition: the command after it would start a real recovery.
    const snippet = buildRecoverySnippet('uuid');
    const condition = snippet.slice(0, snippet.indexOf('; }; } && ') + 6);
    expect(condition.endsWith('; }; }')).toBe(true);
    for (const [exitCode, oomKilled, killed] of [
      ...CASES,
      ['', 'true', true],
      ['unknown', 'true', true],
    ]) {
      const result = spawnSync(
        '/bin/sh',
        [
          '-c',
          `${SHELL_VARS.exit}='${exitCode}'; ${SHELL_VARS.oom}='${oomKilled}'; ` +
            `if ${condition}; then echo recover; else echo keep; fi`,
        ],
        { encoding: 'utf8' }
      );
      expect([exitCode, oomKilled, result.stdout.trim()]).toEqual([
        exitCode,
        oomKilled,
        killed ? 'recover' : 'keep',
      ]);
      expect(result.stderr).toBe('');
    }
  });

  function makeRecord(dir) {
    const appFolder = path.join(dir, 'app');
    const logPath = path.join(dir, 'run.log');
    fs.writeFileSync(logPath, 'main output\n');
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
      },
    });
    store.save(record);
    return { appFolder, logPath, store, record };
  }

  it('recoverKilledExecution does not resume an exit 0/1 with OOMKilled', () => {
    const { store, record } = makeRecord(makeTempDir('recovery-178-'));
    for (const exitCode of ['0', '1']) {
      const calls = [];
      const outcome = recoverKilledExecution({
        store,
        executionId: record.uuid,
        exitCode,
        oomKilled: 'true',
        runner: (...args) => {
          calls.push(args);
          return { success: true, stdout: '', stderr: '', status: 0 };
        },
        startWatcher: () => calls.push('watcher'),
      });
      expect(outcome).toEqual({ recovered: false, reason: 'not-killed' });
      expect(calls).toEqual([]);
    }
    expect(store.get(record.uuid).options.recoveryAttempts).toBeUndefined();
  });

  /** Run the real watcher against a fake docker that reports `state`. */
  function runWatcher(state) {
    const dir = makeTempDir('watcher-178-');
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir);
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
        `      *) echo '${state}' ;;`,
        '    esac ;;',
        '  logs) echo work ;;',
        'esac',
        '',
      ].join('\n')
    );
    fs.chmodSync(dockerPath, 0o755);
    const { appFolder, logPath, record } = makeRecord(dir);
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
    return {
      calls: fs.readFileSync(path.join(dir, 'calls'), 'utf8'),
      log: fs.readFileSync(logPath, 'utf8'),
      record: new ExecutionStore({ appFolder, useLinks: false }).get(
        record.uuid
      ),
    };
  }

  const TIMES = '2026-10-03T12:00:00.000000000Z 2026-10-03T16:55:20.000000000Z';

  for (const exitCode of [0, 1]) {
    it(`the watcher finalizes exit ${exitCode} with OOMKilled=true without resuming`, () => {
      if (needsPosixShell()) {
        return;
      }
      const { calls, log, record } = runWatcher(`${exitCode} true ${TIMES}`);
      expect(calls).not.toContain('start box');
      expect(log).not.toContain('[Recovery');
      // Still reported as an OOM event in the post-mortem and the record.
      expect(log).toContain('OOMKilled:  true');
      expect(record.status).toBe(ExecutionStatus.EXECUTED);
      expect(record.exitCode).toBe(exitCode);
      expect(record.oomKilled).toBe(true);
      expect(record.options.recoveryAttempts).toBeUndefined();
    }, 30000);
  }
});
