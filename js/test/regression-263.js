/**
 * Issue #263: `$ --pause <id>` / `$ --unpause <id>` freeze and thaw a
 * detached Docker execution with `docker pause` (cgroup freezer). CPU is
 * released, memory and the process stay, and the same process continues on
 * unpause. Paused executions are reported, never resumed, attached to,
 * cleaned up or recovered, and a stale recorded pause is reconciled against
 * `docker inspect`.
 */
// Own snapshot lock even without the bunfig.toml preload (issue #234).
require('./setup/private-snapshot-lock');
const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs } = require('../src/lib/args-parser');
const {
  ExecutionRecord,
  ExecutionStatus,
  ExecutionStore,
} = require('../src/lib/execution-store');
const pause = require('../src/lib/execution-pause');
const {
  SessionState,
  mapDockerStatusToState,
  probeSession,
} = require('../src/lib/session-probe');
const { attachExecution } = require('../src/lib/execution-attach');
const { resumeExecution } = require('../src/lib/execution-resume');
const { resumeAllExecutions } = require('../src/lib/execution-resume-all');
const { cleanupExecution } = require('../src/lib/execution-cleanup');
const { controlExecution } = require('../src/lib/execution-control');
const { recoverKilledExecution } = require('../src/lib/execution-recovery');
const { queryStatus, listExecutions } = require('../src/lib/status-formatter');
const { canRunLinuxDockerImages } = require('../src/lib/isolation');

const UUID = '26300000-0000-4000-8000-000000000263';
const NAME = 'paused-263';

function makeStore() {
  const appFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'start-263-'));
  const store = new ExecutionStore({ appFolder, useLinks: false });
  store.appFolderForTest = appFolder;
  return store;
}

function makeRecord(options = {}, overrides = {}) {
  return new ExecutionRecord({
    uuid: UUID,
    command: 'sleep 300',
    pid: 999999,
    logPath: path.join(os.tmpdir(), `start-263-${process.pid}.log`),
    status: ExecutionStatus.EXECUTING,
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: NAME,
      image: 'alpine:3.23',
      ...options,
    },
    ...overrides,
  });
}

/**
 * In-memory docker: `state` is running, paused, exited or removed. Answers
 * the pause probe, `pause`/`unpause`/`stop`/`kill`/`rm`, and records calls.
 */
function fakeDocker(initial = 'running') {
  const docker = { state: initial, calls: [] };
  docker.runner = (command, args, extra = {}) => {
    docker.calls.push({ command, args, extra });
    const ok = (stdout = '') => ({
      success: true,
      stdout,
      stderr: '',
      status: 0,
      error: null,
    });
    const fail = (stderr) => ({
      success: false,
      stdout: '',
      stderr,
      status: 1,
      error: null,
    });
    if (command !== 'docker') {
      return fail('not docker');
    }
    if (docker.state === 'removed' && args[0] !== 'rm') {
      return fail(`Error response from daemon: No such container: ${NAME}`);
    }
    switch (args[0]) {
      case 'inspect': {
        const format = args[args.indexOf('-f') + 1];
        if (format === pause.PAUSE_STATE_FORMAT) {
          return ok(`${docker.state} ${docker.state === 'paused'}\n`);
        }
        if (format === '{{.State.Status}}') {
          return ok(`${docker.state}\n`);
        }
        return ok('');
      }
      case 'pause':
        if (docker.state !== 'running') {
          return fail(`container ${NAME} is not running`);
        }
        docker.state = 'paused';
        return ok(`${NAME}\n`);
      case 'unpause':
        if (docker.state !== 'paused') {
          return fail(`container ${NAME} is not paused`);
        }
        docker.state = 'running';
        return ok(`${NAME}\n`);
      case 'stop':
      case 'kill':
        docker.state = 'exited';
        return ok(`${NAME}\n`);
      case 'rm':
        if (docker.state === 'paused') {
          return fail('cannot remove a paused container');
        }
        docker.state = 'removed';
        return ok(`${NAME}\n`);
      default:
        return ok('');
    }
  };
  docker.ran = (verb) => docker.calls.filter((c) => c.args[0] === verb);
  return docker;
}

const pausedProbe = () => ({
  backend: 'docker',
  sessionName: NAME,
  state: SessionState.PAUSED,
  alive: true,
  containerStatus: 'paused',
});

let store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => {
  fs.rmSync(store.appFolderForTest, { recursive: true, force: true });
});

describe('issue #263: parsing --pause / --unpause', () => {
  it('parses the identifiers, reason and actor in both forms', () => {
    const a = parseArgs([
      '--pause',
      NAME,
      '--pause-reason',
      'rate limit',
      '--paused-by=hive-mind',
    ]).wrapperOptions;
    expect(a.pause).toBe(NAME);
    expect(a.pauseReason).toBe('rate limit');
    expect(a.pausedBy).toBe('hive-mind');
    expect(parseArgs([`--unpause=${UUID}`]).wrapperOptions.unpause).toBe(UUID);
    expect(
      parseArgs(['--unpause', NAME, '--output-format', 'json']).wrapperOptions
        .outputFormat
    ).toBe('json');
  });

  it('rejects combinations and stray detail options', () => {
    expect(() => parseArgs(['--pause', NAME, '--stop', NAME])).toThrow(
      /Cannot combine .*--pause, --unpause.* in the same invocation/
    );
    expect(() => parseArgs(['--pause', NAME, '--unpause', NAME])).toThrow(
      /Cannot combine/
    );
    expect(() => parseArgs(['--unpause', NAME, '--pause-reason', 'x'])).toThrow(
      '--pause-reason and --paused-by options are only valid with --pause'
    );
    expect(() => parseArgs(['--pause', NAME, '--pause-reason'])).toThrow(
      'Option --pause-reason requires a value'
    );
    expect(() => parseArgs(['--pause'])).toThrow();
  });
});

describe('issue #263: session probe', () => {
  it('reads a paused container as PAUSED and alive, not STOPPED', () => {
    expect(mapDockerStatusToState('paused')).toBe(SessionState.PAUSED);
    const docker = fakeDocker('paused');
    const probe = probeSession(makeRecord(), docker.runner);
    expect(probe.state).toBe(SessionState.PAUSED);
    expect(probe.alive).toBe(true);
  });
});

describe('issue #263: --pause', () => {
  it('pauses with an argv array and a timeout, keeping the same record', () => {
    store.save(makeRecord());
    const docker = fakeDocker('running');
    const result = pause.pauseExecution(store, NAME, {
      runner: docker.runner,
      outputFormat: 'json',
      reason: 'rate limit',
      by: 'hive-mind',
    });
    expect(result.success).toBe(true);
    const report = JSON.parse(result.output);
    expect(report).toMatchObject({
      action: 'pause',
      uuid: UUID,
      status: 'paused',
      method: 'DOCKER_PAUSE',
      dockerState: 'paused',
      paused: true,
      pauseCount: 1,
      pausedBy: 'hive-mind',
      pauseReason: 'rate limit',
      resources: { cpu: 'released', memory: 'retained', disk: 'retained' },
    });
    expect(report.message).toContain('memory stays allocated');
    expect(report.message).toContain(`--unpause ${UUID}`);
    const [call] = docker.ran('pause');
    expect(call.args).toEqual(['pause', NAME]);
    expect(call.extra.timeout).toBe(pause.DOCKER_PAUSE_TIMEOUT_MS);
    // Every docker call is bounded, the process-ID lookup included.
    for (const c of docker.calls) {
      expect(c.extra.timeout).toBe(pause.DOCKER_PAUSE_TIMEOUT_MS);
    }

    const all = store.getAll();
    expect(all).toHaveLength(1);
    const saved = all[0];
    expect(saved.uuid).toBe(UUID);
    expect(saved.status).toBe(ExecutionStatus.EXECUTING);
    expect(saved.logPath).toBe(makeRecord().logPath);
    expect(saved.options).toMatchObject({
      paused: true,
      pauseCount: 1,
      pausedBy: 'hive-mind',
      pauseReason: 'rate limit',
      image: 'alpine:3.23',
    });
    expect(Date.parse(saved.options.pausedAt)).not.toBeNaN();
    expect(saved.options.recoveryAttempts).toBeUndefined();
  });

  it('is idempotent on an already paused container', () => {
    store.save(makeRecord());
    const docker = fakeDocker('running');
    pause.pauseExecution(store, NAME, { runner: docker.runner });
    const first = store.get(UUID).options.pausedAt;
    const again = pause.pauseExecution(store, NAME, {
      runner: docker.runner,
      outputFormat: 'json',
    });
    expect(again.success).toBe(true);
    expect(JSON.parse(again.output)).toMatchObject({
      status: 'already-paused',
      method: 'NONE',
      paused: true,
    });
    expect(docker.ran('pause')).toHaveLength(1);
    expect(store.get(UUID).options.pauseCount).toBe(1);
    expect(store.get(UUID).options.pausedAt).toBe(first);
  });

  it('adopts a pause made outside start-command', () => {
    store.save(makeRecord());
    const docker = fakeDocker('paused');
    const result = pause.pauseExecution(store, NAME, { runner: docker.runner });
    expect(result.success).toBe(true);
    expect(result.output).toContain('already-paused');
    expect(store.get(UUID).options.paused).toBe(true);
  });

  it('fails on an exited container and clears a stale pause', () => {
    store.save(makeRecord({ paused: true, pausedAt: 'x', pauseCount: 1 }));
    const docker = fakeDocker('exited');
    const result = pause.pauseExecution(store, NAME, { runner: docker.runner });
    expect(result.success).toBe(false);
    expect(result.error).toContain('is exited, not running');
    expect(result.error).toContain(`--status ${UUID}`);
    expect(result.error).toContain(`--resume ${UUID}`);
    expect(docker.ran('pause')).toHaveLength(0);
    expect(store.get(UUID).options).toMatchObject({
      paused: false,
      pauseEndedBy: 'reconcile',
    });
  });

  it('fails on a removed container and records the removal', () => {
    store.save(
      makeRecord(
        { paused: true, pausedAt: 'x', pauseCount: 1 },
        { status: ExecutionStatus.EXECUTED, exitCode: 137 }
      )
    );
    const docker = fakeDocker('removed');
    const result = pause.pauseExecution(store, NAME, { runner: docker.runner });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no longer exists (removed)');
    expect(result.error).toContain(`--resume ${UUID}`);
    const saved = store.get(UUID);
    expect(saved.containerState).toBe('removed');
    expect(saved.options.paused).toBe(false);
  });

  it('refuses screen, tmux and attached docker executions', () => {
    for (const isolated of ['screen', 'tmux']) {
      const s = makeStore();
      s.save(makeRecord({ isolated }));
      const docker = fakeDocker();
      const result = pause.pauseExecution(s, NAME, { runner: docker.runner });
      expect(result.success).toBe(false);
      expect(result.error).toContain(
        `--pause only supports Docker isolation: ${NAME} uses ${isolated}`
      );
      expect(docker.calls).toHaveLength(0);
      fs.rmSync(s.appFolderForTest, { recursive: true, force: true });
    }
    store.save(makeRecord({ isolationMode: 'attached' }));
    expect(
      pause.unpauseExecution(store, NAME, { runner: fakeDocker().runner }).error
    ).toBe('Only detached Docker executions can be unpaused.');
    expect(pause.pauseExecution(store, 'nope', {}).error).toContain(
      'No execution found'
    );
  });

  it('reports a docker failure without changing the record', () => {
    store.save(makeRecord());
    const docker = fakeDocker('running');
    const runner = (command, args, extra) =>
      args[0] === 'pause'
        ? { success: false, stdout: '', stderr: 'boom', status: 1 }
        : docker.runner(command, args, extra);
    const result = pause.pauseExecution(store, NAME, { runner });
    expect(result).toEqual({
      success: false,
      error: `Failed to pause docker container "${NAME}": boom`,
    });
    expect(store.get(UUID).options.paused).toBeUndefined();
  });
});

describe('issue #263: --unpause', () => {
  it('unpauses a paused container and clears the pause state', () => {
    store.save(makeRecord());
    const docker = fakeDocker('running');
    pause.pauseExecution(store, NAME, { runner: docker.runner, by: 'me' });
    const result = pause.unpauseExecution(store, UUID, {
      runner: docker.runner,
      outputFormat: 'json',
    });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      action: 'unpause',
      status: 'unpaused',
      method: 'DOCKER_UNPAUSE',
      dockerState: 'running',
      paused: false,
    });
    expect(docker.ran('unpause')[0].args).toEqual(['unpause', NAME]);
    const opts = store.get(UUID).options;
    expect(opts).toMatchObject({
      paused: false,
      pauseCount: 1,
      pauseEndedBy: 'unpause',
    });
    expect(opts.pausedAt).toBeUndefined();
    expect(opts.pausedBy).toBeUndefined();
    expect(store.getAll()).toHaveLength(1);
  });

  it('is idempotent on a running container and reconciles the record', () => {
    store.save(makeRecord({ paused: true, pausedAt: 'x', pauseCount: 2 }));
    const docker = fakeDocker('running');
    const result = pause.unpauseExecution(store, NAME, {
      runner: docker.runner,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('status not-paused');
    expect(docker.ran('unpause')).toHaveLength(0);
    expect(store.get(UUID).options).toMatchObject({
      paused: false,
      pauseCount: 2,
      pauseEndedBy: 'reconcile',
    });
  });

  it('fails on exited and removed containers with a recovery path', () => {
    store.save(makeRecord({ paused: true }));
    const exited = pause.unpauseExecution(store, NAME, {
      runner: fakeDocker('exited').runner,
    });
    expect(exited.success).toBe(false);
    expect(exited.error).toContain('is exited, not paused');
    expect(exited.error).toContain(`--resume ${UUID}`);
    const removed = pause.unpauseExecution(store, NAME, {
      runner: fakeDocker('removed').runner,
    });
    expect(removed.success).toBe(false);
    expect(removed.error).toContain('no longer exists (removed)');
    expect(removed.error).toContain(`--status ${UUID}`);
  });

  it('renders text and links-notation reports', () => {
    store.save(makeRecord());
    const docker = fakeDocker('running');
    const text = pause.pauseExecution(store, NAME, {
      runner: docker.runner,
      outputFormat: 'text',
    }).output;
    expect(text).toContain('Docker State:  paused');
    expect(text).toContain('CPU released, memory retained, disk retained');
    const lino = pause.unpauseExecution(store, NAME, {
      runner: docker.runner,
    }).output;
    expect(lino.split('\n')[0]).toBe('executionControl');
    expect(lino).toContain('  status unpaused');
  });
});

describe('issue #263: other commands on a paused execution', () => {
  it('--attach is refused without starting an interactive session', () => {
    store.save(makeRecord({ paused: true }));
    let interactive = 0;
    const result = attachExecution(store, NAME, {
      probe: pausedProbe,
      interactiveRunner: () => {
        interactive += 1;
        return { status: 0 };
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('is paused');
    expect(result.error).toContain(`--unpause ${UUID}`);
    expect(interactive).toBe(0);
  });

  it('--resume is refused and takes no snapshot', async () => {
    store.save(makeRecord({ paused: true }));
    const docker = fakeDocker('paused');
    const result = await resumeExecution(store, NAME, {
      probe: pausedProbe,
      runner: docker.runner,
      runIsolated: () => {
        throw new Error('must not launch');
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain(`--unpause ${UUID}`);
    expect(docker.ran('commit')).toHaveLength(0);
    expect(docker.ran('start')).toHaveLength(0);
    expect(store.getAll()).toHaveLength(1);
  });

  it('--resume-all skips a paused execution with a reason', () => {
    store.save(makeRecord({ paused: true }));
    const result = resumeAllExecutions(store, {
      probe: pausedProbe,
      runner: fakeDocker('paused').runner,
      outputFormat: 'json',
      startWatcher: () => {
        throw new Error('must not watch');
      },
    });
    expect(result.success).toBe(true);
    const summary = JSON.parse(result.output);
    expect(summary.executions[0]).toMatchObject({
      uuid: UUID,
      state: 'paused',
      action: 'paused',
    });
    expect(summary.executions[0].message).toContain('Skipped paused container');
  });

  it('--cleanup <id> retains a paused container', () => {
    store.save(makeRecord({ paused: true }));
    const docker = fakeDocker('paused');
    const result = cleanupExecution(store, NAME, { runner: docker.runner });
    expect(result.success).toBe(false);
    expect(result.output).toBe(`Retained container ${NAME} (paused)`);
    expect(docker.ran('rm')).toHaveLength(0);
    expect(docker.ran('rmi')).toHaveLength(0);
  });

  for (const action of ['stop', 'terminate']) {
    it(`--${action} counts as intentional and clears the pause`, () => {
      store.save(makeRecord({ onKillResume: 3 }));
      const docker = fakeDocker('running');
      pause.pauseExecution(store, NAME, { runner: docker.runner });
      const result = controlExecution(store, NAME, action, docker.runner);
      expect(result.success).toBe(true);
      const opts = store.get(UUID).options;
      expect(opts.paused).toBe(false);
      expect(opts.pauseEndedBy).toBe(action);
      expect(Date.parse(opts.stopRequestedAt)).not.toBeNaN();

      const recovery = recoverKilledExecution({
        store,
        executionId: UUID,
        exitCode: 137,
        oomKilled: false,
        runner: docker.runner,
      });
      expect(recovery).toEqual({
        recovered: false,
        reason: 'stop-requested',
      });
      expect(store.getAll()).toHaveLength(1);
    });
  }

  it('stop intent is recorded for a paused execution without --on-kill-resume', () => {
    store.save(makeRecord());
    const docker = fakeDocker('running');
    pause.pauseExecution(store, NAME, { runner: docker.runner });
    controlExecution(store, NAME, 'stop', docker.runner);
    expect(store.get(UUID).options.stopRequestedAt).toBeDefined();
  });

  it('a paused execution killed from outside is never auto-recovered', () => {
    store.save(makeRecord({ onKillResume: 3, paused: true }));
    const recovery = recoverKilledExecution({
      store,
      executionId: UUID,
      exitCode: 137,
      oomKilled: false,
      runner: fakeDocker('exited').runner,
    });
    expect(recovery).toEqual({ recovered: false, reason: 'paused' });
  });
});

/**
 * Fake `docker` binary for code that spawns docker itself (status probes,
 * cleanupStale): `state` is the JSON of the one container, or "removed".
 */
function withDockerBinary(state, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-263-'));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const script = path.join(dir, 'docker.js');
  fs.writeFileSync(
    script,
    `const fs = require('fs');
let args = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
if (args[0] !== 'inspect') process.exit(1);
args = args.slice(1);
if (args[0] === '--type') args = args.slice(2);
// On Windows START_DOCKER_BIN runs through cmd.exe, which splits the format
// at its spaces: its words are the ones holding a {{.Field}} placeholder.
let next = args.indexOf('-f') + 1;
const words = [];
while (next < args.length && args[next].includes('}}')) words.push(args[next++]);
const format = words.join(' ');
const targets = args.slice(next);
let missing = false;
for (const t of targets) {
  if (c === 'removed' || (t !== c['.Name'].slice(1) && !c['.Id'].startsWith(t))) {
    missing = true;
    process.stderr.write('Error response from daemon: No such container: ' + t + '\\n');
    continue;
  }
  process.stdout.write(format.replace(/\\{\\{\\s*(\\.[A-Za-z.]+)\\s*\\}\\}/g, (_, f) => (f in c ? c[f] : '')) + '\\n');
}
process.exit(missing ? 1 : 0);
`
  );
  const windows = process.platform === 'win32';
  const bin = path.join(dir, windows ? 'docker.cmd' : 'docker');
  fs.writeFileSync(
    bin,
    windows
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\nexit /b %errorlevel%\r\n`
      : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`
  );
  fs.chmodSync(bin, 0o755);
  const original = process.env.START_DOCKER_BIN;
  process.env.START_DOCKER_BIN = bin;
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.START_DOCKER_BIN;
    } else {
      process.env.START_DOCKER_BIN = original;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const container = (status) => ({
  '.Name': `/${NAME}`,
  '.Id': 'abc263def',
  '.State.Pid': status === 'exited' ? '0' : '4242',
  '.State.Running': String(status === 'running' || status === 'paused'),
  '.State.ExitCode': status === 'exited' ? '137' : '0',
  '.State.OOMKilled': 'false',
  '.State.StartedAt': '2026-11-13T08:00:00Z',
  '.State.FinishedAt':
    status === 'exited' ? '2026-11-13T08:05:00Z' : '0001-01-01T00:00:00Z',
  '.State.Status': status,
  '.State.Paused': String(status === 'paused'),
});

describe('issue #263: --status, --list and reconciliation', () => {
  it('--status reports a paused execution as executing, with pause fields', () => {
    store.save(makeRecord({ paused: true, pausedAt: '2026-11-13T08:01:00Z' }));
    const obj = withDockerBinary(container('paused'), () =>
      JSON.parse(queryStatus(store, NAME, 'json').output)
    );
    expect(obj.status).toBe('executing');
    expect(obj.dockerState).toBe('paused');
    expect(obj.paused).toBe(true);
    expect(obj.pausedAt).toBe('2026-11-13T08:01:00Z');
    expect(obj.exitCode).toBeNull();
    const keys = Object.keys(obj);
    expect(keys.indexOf('dockerState')).toBe(keys.indexOf('status') + 1);
  });

  it('--status text shows the docker state and pause', () => {
    store.save(makeRecord({ paused: true, pausedAt: '2026-11-13T08:01:00Z' }));
    const text = withDockerBinary(
      container('paused'),
      () => queryStatus(store, NAME, 'text').output
    );
    expect(text).toContain('Docker State:      paused');
    expect(text).toContain('Paused:            true');
    expect(text).toContain('Paused At:         2026-11-13T08:01:00Z');
  });

  it('--list and --list --running include paused executions', () => {
    store.save(makeRecord({ paused: true, pausedAt: '2026-11-13T08:01:00Z' }));
    for (const running of [false, true]) {
      const list = withDockerBinary(container('paused'), () =>
        JSON.parse(listExecutions(store, 'json', { running }).output)
      );
      const rows = Array.isArray(list) ? list : list.executions;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        uuid: UUID,
        status: 'executing',
        dockerState: 'paused',
        paused: true,
      });
    }
  });

  it('a stale paused:true is reconciled when docker says it exited', () => {
    store.save(makeRecord({ paused: true, pausedAt: '2026-11-13T08:01:00Z' }));
    const obj = withDockerBinary(container('exited'), () =>
      JSON.parse(queryStatus(store, NAME, 'json').output)
    );
    expect(obj.dockerState).toBe('exited');
    expect(obj.paused).toBe(false);
    expect(obj.status).not.toBe('executing');
    expect(store.get(UUID).options).toMatchObject({
      paused: false,
      pauseEndedBy: 'reconcile',
    });
  });

  it('a stale paused:true is reconciled when docker says it is running', () => {
    store.save(makeRecord({ paused: true, pausedAt: '2026-11-13T08:01:00Z' }));
    const obj = withDockerBinary(container('running'), () =>
      JSON.parse(queryStatus(store, NAME, 'json').output)
    );
    expect(obj).toMatchObject({
      status: 'executing',
      dockerState: 'running',
      paused: false,
    });
    expect(store.get(UUID).options.paused).toBe(false);
  });

  it('a removed container (reboot) shows as removed, not paused', () => {
    store.save(makeRecord({ paused: true, pausedAt: '2026-11-13T08:01:00Z' }));
    const obj = withDockerBinary('removed', () =>
      JSON.parse(queryStatus(store, NAME, 'json').output)
    );
    expect(obj.dockerState).toBe('removed');
    expect(obj.paused).toBe(false);
    expect(store.get(UUID).options.paused).toBe(false);
  });

  it('a pause made outside start-command is adopted by --status', () => {
    store.save(makeRecord());
    const obj = withDockerBinary(container('paused'), () =>
      JSON.parse(queryStatus(store, NAME, 'json').output)
    );
    expect(obj.paused).toBe(true);
    expect(store.get(UUID).options.paused).toBe(true);
  });

  it('keeps the recorded pause when docker cannot be asked', () => {
    const record = makeRecord({ paused: true, pausedAt: 'p' });
    const fields = pause.observedPauseFields(record, {});
    expect(fields).toEqual({
      dockerState: 'unknown',
      paused: true,
      pausedAt: 'p',
    });
    expect(
      pause.observedPauseFields(makeRecord({ isolated: 'screen' }), {})
    ).toBeNull();
  });

  it('cleanupStale never cleans a docker-confirmed paused execution', () => {
    store.save(makeRecord({ paused: true }, { platform: process.platform }));
    const kept = withDockerBinary(container('paused'), () =>
      store.cleanupStale()
    );
    expect(kept.cleaned).toBe(0);
    expect(store.get(UUID).status).toBe(ExecutionStatus.EXECUTING);
    // A stale recorded pause does not hide the dead record forever.
    const cleaned = withDockerBinary('removed', () => store.cleanupStale());
    expect(cleaned.cleaned).toBe(1);
  });
});

describe('issue #263: detached watcher', () => {
  it('keeps waiting while the container is paused and stops once it exits', () => {
    const {
      buildDockerWaitForExitSnippet,
    } = require('../src/lib/docker-post-mortem');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-263-'));
    const stateFile = path.join(dir, 'state');
    // Docker keeps `.State.Running=true` for a paused container.
    fs.writeFileSync(stateFile, 'true');
    fs.writeFileSync(
      path.join(dir, 'docker'),
      `#!/bin/sh\nif [ "$1" = inspect ]; then cat ${JSON.stringify(stateFile)}; echo; exit 0; fi\nsleep 0.1; exit 1\n`
    );
    fs.chmodSync(path.join(dir, 'docker'), 0o755);
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    const snippet = buildDockerWaitForExitSnippet(NAME);
    try {
      const paused = spawnSync('sh', ['-c', snippet], {
        env,
        timeout: 1500,
      });
      // Still in its wait loop when the timeout killed it: not completed.
      expect(paused.signal).toBe('SIGTERM');
      fs.writeFileSync(stateFile, 'false');
      const exited = spawnSync('sh', ['-c', snippet], {
        env,
        timeout: 10000,
      });
      expect(exited.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const dockerReady = (() => {
  try {
    return canRunLinuxDockerImages();
  } catch {
    return false;
  }
})();

describe('issue #263: real docker', () => {
  it.skipIf(!dockerReady)(
    'pause/unpause keeps the same process and the CLI reports it',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-263-e2e-'));
      const name = `t263-${process.pid}`;
      const env = {
        ...process.env,
        HOME: root,
        START_APP_FOLDER: path.join(root, 'app'),
        START_LOG_DIR: path.join(root, 'logs'),
        START_DISABLE_AUTO_ISSUE: '1',
        START_DISABLE_LOG_UPLOAD: '1',
        START_EXECUTION_ID: '',
      };
      delete env.START_DOCKER_BIN;
      const cli = (...args) =>
        spawnSync(
          process.execPath,
          [path.join(__dirname, '../src/bin/cli.js'), ...args],
          { encoding: 'utf8', timeout: 60000, env }
        );
      const docker = (...args) =>
        (
          spawnSync('docker', args, { encoding: 'utf8', timeout: 60000 })
            .stdout || ''
        ).trim();
      try {
        const launched = cli(
          '--isolated',
          'docker',
          '--detached',
          '--image',
          'alpine:3.23',
          '--session',
          name,
          '--',
          'sleep 300'
        );
        expect(launched.status).toBe(0);
        const pidBefore = docker('inspect', '-f', '{{.State.Pid}}', name);
        expect(Number(pidBefore)).toBeGreaterThan(0);

        const paused = cli('--pause', name, '--output-format', 'json');
        expect(paused.status).toBe(0);
        expect(JSON.parse(paused.stdout)).toMatchObject({
          status: 'paused',
          paused: true,
        });
        expect(docker('inspect', '-f', '{{.State.Status}}', name)).toBe(
          'paused'
        );
        expect(cli('--pause', name).stdout).toContain('already-paused');

        const status = JSON.parse(
          cli('--status', name, '--output-format', 'json').stdout
        );
        expect(status).toMatchObject({
          status: 'executing',
          dockerState: 'paused',
          paused: true,
        });
        const running = cli('--list', '--running', '--output-format', 'json');
        expect(running.stdout).toContain(name);

        const attach = cli('--attach', name);
        expect(attach.status).not.toBe(0);
        expect(attach.stderr + attach.stdout).toContain('--unpause');
        const resume = cli('--resume', name);
        expect(resume.status).not.toBe(0);
        expect(resume.stderr + resume.stdout).toContain('--unpause');
        expect(cli('--cleanup', name).status).not.toBe(0);
        expect(docker('inspect', '-f', '{{.State.Status}}', name)).toBe(
          'paused'
        );

        const unpaused = cli('--unpause', name, '--output-format', 'json');
        expect(unpaused.status).toBe(0);
        expect(JSON.parse(unpaused.stdout).status).toBe('unpaused');
        expect(docker('inspect', '-f', '{{.State.Pid}}', name)).toBe(pidBefore);
        expect(cli('--unpause', name).stdout).toContain('not-paused');

        expect(cli('--pause', name).status).toBe(0);
        expect(cli('--terminate', name).status).toBe(0);
        const ended = JSON.parse(
          cli('--status', name, '--output-format', 'json').stdout
        );
        expect(ended.paused).toBe(false);
        expect(ended.options.stopRequestedAt).toBeDefined();
        const again = cli('--unpause', name);
        expect(again.status).not.toBe(0);
        expect(again.stderr).toContain('--resume');
      } finally {
        spawnSync('docker', ['rm', '-f', name], { timeout: 60000 });
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    180000
  );
});
