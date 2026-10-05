/**
 * Regression tests for issue #182:
 *
 *   Docker's `State.OOMKilled` is container-wide and sticky (moby/moby#43564):
 *   it cannot say how many processes the OOM killer took, whether the
 *   container hit its own `--memory` limit or the whole host ran out, or how
 *   close the run came to its limit. The kernel provides raw counters per cgroup
 *   (`memory.events` `oom`/`oom_kill`, `memory.peak`, `memory.max`), but the
 *   cgroup is gone once the container stops.
 *
 *   The detached watcher now samples the container's cgroup v2 counters while
 *   it runs, writes a `Memory:` line into the post-mortem, stores them as
 *   `cgroupMemory` in the execution record (shown by `--status`), and hands
 *   them to the kill recovery, which notes them in `recoveryHistory`.
 */

const { describe, it, expect, afterEach } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  OOM_SCOPE,
  buildCgroupMemoryLogSnippet,
  buildCgroupSamplerStartSnippet,
  buildCgroupSamplerStopSnippet,
  describeCgroupOomScope,
  formatCgroupMemory,
  formatCgroupMemoryLogLine,
  parseCgroupMemorySample,
} = require('../src/lib/cgroup-memory');
const {
  buildDetachedDockerCompletionScript,
  DOCKER_CONTAINER_CLEANUP_POLICY,
} = require('../src/lib/docker-cleanup');
const {
  buildDetachedFinalizeSnippet,
  finalizeDetachedExecution,
} = require('../src/lib/detached-finalize');
const {
  buildRecoverySnippet,
  recoverKilledExecution,
} = require('../src/lib/execution-recovery');
const {
  ExecutionStore,
  ExecutionRecord,
  ExecutionStatus,
} = require('../src/lib/execution-store');
const { formatRecordAsText } = require('../src/lib/status-formatter');

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

// The watcher body is a POSIX `sh` script; Windows has no `/bin/sh`.
const needsPosixShell = () => {
  if (process.platform !== 'win32') {
    return false;
  }
  console.log('  Skipping: the watcher needs a POSIX /bin/sh');
  return true;
};

const CONTAINER_ID = `182c${'0'.repeat(60)}`;
const OOM_SAMPLE = '268435456 268300000 0 3';
const OOM_COUNTERS = {
  limitBytes: 268435456,
  peakBytes: 268300000,
  oomEvents: 0,
  oomKills: 3,
};

/**
 * A fake cgroup v2 tree, `/proc` and `docker`. `docker logs` runs `during`
 * (a shell snippet) after 1.5s, so the sampler has taken a sample by then.
 */
function makeFakeHost({ events, max = '268435456', peak = '268300000' }) {
  const dir = makeTempDir('cgroup-182-');
  const cgroupRoot = path.join(dir, 'cgroup');
  const scope = path.join(
    cgroupRoot,
    'system.slice',
    `docker-${CONTAINER_ID}.scope`
  );
  fs.mkdirSync(scope, { recursive: true });
  fs.writeFileSync(path.join(scope, 'memory.events'), events);
  fs.writeFileSync(path.join(scope, 'memory.max'), `${max}\n`);
  if (peak !== null) {
    fs.writeFileSync(path.join(scope, 'memory.peak'), `${peak}\n`);
  }
  const procRoot = path.join(dir, 'proc');
  fs.mkdirSync(path.join(procRoot, '4242'), { recursive: true });
  fs.writeFileSync(
    path.join(procRoot, '4242', 'cgroup'),
    `0::/system.slice/docker-${CONTAINER_ID}.scope\n`
  );
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  return {
    dir,
    scope,
    binDir,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      START_COMMAND_CGROUP_ROOT: cgroupRoot,
      START_COMMAND_PROC_ROOT: procRoot,
      TMPDIR: dir,
    },
  };
}

function writeFakeDocker(host, { state, during }) {
  fs.writeFileSync(path.join(host.dir, 'during'), `${during}\n`);
  const dockerPath = path.join(host.binDir, 'docker');
  fs.writeFileSync(
    dockerPath,
    [
      '#!/bin/sh',
      `dir='${host.dir}'`,
      'case "$1" in',
      '  inspect)',
      '    case "$3" in',
      `      *'{{.Id}}'*) echo ${CONTAINER_ID} ;;`,
      '      *State.Pid*) echo 4242 ;;',
      '      *State.Running*) echo false ;;',
      '      *State.Error*) echo "" ;;',
      `      *) echo '${state}' ;;`,
      '    esac ;;',
      '  logs) echo work; sleep 1.5; sh "$dir/during" ;;',
      '  rm) echo removed ;;',
      'esac',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.chmodSync(dockerPath, 0o755);
}

const KILLED_STATE =
  '137 true 2026-10-01T10:00:00.000000000Z 2026-10-01T10:05:00.000000000Z';

function runWatcher({ events, during, policy, state = KILLED_STATE, max }) {
  const host = makeFakeHost({ events, max });
  writeFakeDocker(host, { state, during: during(host) });
  const appFolder = path.join(host.dir, 'app');
  const store = new ExecutionStore({ appFolder, useLinks: false });
  const logPath = path.join(host.dir, 'run.log');
  const record = new ExecutionRecord({
    status: ExecutionStatus.EXECUTING,
    command: 'cargo test',
    logPath,
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: 'box',
    },
  });
  store.save(record);
  const result = spawnSync(
    '/bin/sh',
    [
      '-c',
      buildDetachedDockerCompletionScript('box', policy, logPath, record.uuid),
    ],
    {
      encoding: 'utf8',
      env: {
        ...host.env,
        START_APP_FOLDER: appFolder,
        START_DISABLE_TRACKING: '',
      },
      timeout: 20000,
    }
  );
  return {
    status: result.status,
    log: fs.readFileSync(logPath, 'utf8'),
    record: new ExecutionStore({ appFolder, useLinks: false }).get(record.uuid),
    leftovers: fs
      .readdirSync(host.dir)
      .filter((name) => name.startsWith('start-command-cgroup')),
  };
}

describe('issue #182: reading cgroup v2 memory counters', () => {
  it('parses the sample the watcher writes', () => {
    expect(parseCgroupMemorySample(OOM_SAMPLE)).toEqual(OOM_COUNTERS);
    expect(parseCgroupMemorySample('max - 1 1\n')).toEqual({
      limitBytes: null,
      peakBytes: null,
      oomEvents: 1,
      oomKills: 1,
    });
    for (const empty of ['', null, undefined, '- - - -', '1 2 3']) {
      expect(parseCgroupMemorySample(empty)).toBeNull();
    }
  });

  it('leaves OOM scope unknown with only raw counters', () => {
    expect(describeCgroupOomScope(OOM_COUNTERS)).toBe(OOM_SCOPE.UNKNOWN);
    expect(describeCgroupOomScope({ oomEvents: 2, oomKills: 2 })).toBe(
      OOM_SCOPE.UNKNOWN
    );
    expect(describeCgroupOomScope({ oomEvents: 4, oomKills: 0 })).toBeNull();
    expect(describeCgroupOomScope(null)).toBeNull();
  });

  it('formats the counters for --status and for the log', () => {
    expect(formatCgroupMemory(OOM_COUNTERS)).toBe(
      'peak 255.9 MiB of 256.0 MiB limit, oom 0, oom_kill 3 ' +
        '(OOM kill scope unknown)'
    );
    expect(
      formatCgroupMemory({
        limitBytes: null,
        peakBytes: null,
        oomEvents: 1,
        oomKills: 1,
      })
    ).toBe(
      'peak unknown of no limit, oom 1, oom_kill 1 (OOM kill scope unknown)'
    );
    expect(formatCgroupMemoryLogLine('max 1024 0 0')).toBe(
      'Memory:     memory.max=max memory.peak=1024 oom=0 oom_kill=0'
    );
  });
});

describe('issue #182: the watcher samples the cgroup while the container runs', () => {
  it('starts the sampler first and stops it before reading the state', () => {
    for (const logPath of ['/tmp/run.log', null]) {
      const script = buildDetachedDockerCompletionScript(
        'box',
        DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT,
        logPath,
        'uuid-182',
        { recoverOnKill: true }
      );
      expect(script.startsWith(buildCgroupSamplerStartSnippet('box'))).toBe(
        true
      );
      const stop = script.indexOf(buildCgroupSamplerStopSnippet());
      expect(stop).toBeGreaterThan(script.indexOf('docker wait'));
      expect(stop).toBeLessThan(script.indexOf('__start_command_state='));
      expect(script).toContain(buildDetachedFinalizeSnippet('uuid-182'));
      expect(script).toContain(buildRecoverySnippet('uuid-182'));
    }
    expect(buildDetachedFinalizeSnippet('u')).toContain(
      '"$__start_command_cgroup" >/dev/null'
    );
    expect(buildRecoverySnippet('u')).toContain(
      '"$__start_command_cgroup" >/dev/null'
    );
  });

  it('keeps the last sample once the cgroup is gone', () => {
    if (needsPosixShell()) {
      return;
    }
    const host = makeFakeHost({ events: 'oom 0\noom_kill 3\n' });
    writeFakeDocker(host, { state: KILLED_STATE, during: '' });
    const logPath = path.join(host.dir, 'log');
    const script = [
      buildCgroupSamplerStartSnippet('box'),
      'sleep 1.5',
      `rm -rf '${host.scope}'`,
      buildCgroupSamplerStopSnippet(),
      `printf '%s' "$__start_command_cgroup" > '${host.dir}/sample'`,
      buildCgroupMemoryLogSnippet(`'${logPath}'`),
    ].join('; ');
    const result = spawnSync('/bin/sh', ['-c', script], {
      env: host.env,
      timeout: 20000,
    });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(host.dir, 'sample'), 'utf8')).toBe(
      OOM_SAMPLE
    );
    expect(fs.readFileSync(logPath, 'utf8')).toBe(
      `${formatCgroupMemoryLogLine(OOM_SAMPLE)}\n`
    );
  });

  it('writes the counters into the post-mortem and the record', () => {
    if (needsPosixShell()) {
      return;
    }
    const run = runWatcher({
      events: 'low 0\nhigh 0\nmax 9\noom 1\noom_kill 1\n',
      // The cgroup outlives the main process for a moment: the final read
      // still sees the kills of the last second.
      during: (host) =>
        `printf 'oom 1\\noom_kill 3\\n' > '${host.scope}/memory.events'`,
      policy: DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT,
    });
    expect(run.status).toBe(0);
    expect(run.log).toContain('Exit Code:  137 (SIGKILL - 128+9)');
    expect(run.log).toContain(
      'Memory:     memory.max=268435456 memory.peak=268300000 oom=1 oom_kill=3 ' +
        '(OOM kill scope unknown)'
    );
    expect(run.record.status).toBe(ExecutionStatus.EXECUTED);
    expect(run.record.cgroupMemory).toEqual({
      limitBytes: 268435456,
      peakBytes: 268300000,
      oomEvents: 1,
      oomKills: 3,
    });
    expect(run.leftovers).toEqual([]);
    expect(formatRecordAsText(run.record)).toContain(
      'Cgroup Memory:     peak 255.9 MiB of 256.0 MiB limit, oom 1, oom_kill 3'
    );
  });

  it('notes the counters of a removed container too', () => {
    if (needsPosixShell()) {
      return;
    }
    const run = runWatcher({
      events: 'oom 0\noom_kill 0\n',
      max: 'max',
      during: (host) => `rm -rf '${host.scope}'`,
      policy: DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS,
      state:
        '0 false 2026-10-01T10:00:00.000000000Z 2026-10-01T10:05:00.000000000Z',
    });
    expect(run.log).toContain('Container removed: box');
    expect(run.log).toContain(
      'Memory:     memory.max=max memory.peak=268300000 oom=0 oom_kill=0\n'
    );
    expect(run.record.cgroupMemory).toEqual({
      limitBytes: null,
      peakBytes: 268300000,
      oomEvents: 0,
      oomKills: 0,
    });
  });

  it('records nothing without a cgroup v2 sample', () => {
    const dir = makeTempDir('finalize-182-');
    const store = new ExecutionStore({ appFolder: dir, useLinks: false });
    const record = new ExecutionRecord({ command: 'x' });
    store.save(record);
    finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      exitCode: '0',
      oomKilled: 'false',
      finishedAt: '2026-10-01T10:05:00Z',
      cgroupMemory: '',
    });
    const stored = store.get(record.uuid);
    expect(stored.cgroupMemory).toBeUndefined();
    expect(stored.toObject()).not.toHaveProperty('cgroupMemory');
    expect(formatRecordAsText(stored)).not.toContain('Cgroup Memory');
  });

  it('explains an unknown exit with the per-run oom_kill count', () => {
    const dir = makeTempDir('finalize-182-');
    const store = new ExecutionStore({ appFolder: dir, useLinks: false });
    const record = new ExecutionRecord({ command: 'x' });
    store.save(record);
    const { record: finalized } = finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      exitCode: '137',
      oomKilled: 'false',
      finishedAt: '2026-10-01T10:05:00Z',
      cgroupMemory: OOM_SAMPLE,
    });
    expect(finalized.cgroupMemory).toEqual(OOM_COUNTERS);
    expect(finalized.exitReason).toBeTruthy();
  });
});

describe('issue #182: the kill recovery keeps the killed run counters', () => {
  function ok(stdout = '') {
    return { success: true, stdout, stderr: '', status: 0, error: null };
  }

  it('logs them and notes them in recoveryHistory', () => {
    const dir = makeTempDir('recovery-182-');
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
      cgroupMemory: OOM_COUNTERS,
      options: {
        isolated: 'docker',
        isolationMode: 'detached',
        sessionName: 'box',
        onKillResume: 2,
      },
    });
    store.save(record);
    const outcome = recoverKilledExecution({
      store,
      executionId: record.uuid,
      exitCode: '137',
      oomKilled: 'true',
      startedAt: '2026-10-01T10:00:00Z',
      finishedAt: '2026-10-01T10:05:00Z',
      containerError: '',
      cgroupMemory: OOM_SAMPLE,
      runner: (command, args) => ok(args[0] === 'inspect' ? '{}\n' : 'cid\n'),
      startWatcher: () => {},
      now: () => new Date('2026-10-01T10:06:00.000Z'),
    });
    expect(outcome.recovered).toBe(true);
    expect(fs.readFileSync(logPath, 'utf8')).toContain(
      `${formatCgroupMemoryLogLine(OOM_SAMPLE)}\n\n[Recovery 1/2]`
    );
    const stored = store.get(record.uuid);
    expect(stored.options.recoveryHistory).toEqual([
      '1: exit 137, oomKilled=true, oomEvents=0, oomKills=3, resumed at 2026-10-01T10:06:00.000Z',
    ]);
    // The resumed run gets a fresh cgroup: the old counters must not explain
    // its exit.
    expect(stored.cgroupMemory).toBeUndefined();
  });
});
