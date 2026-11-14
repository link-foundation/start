/**
 * Issue #265: `--stop` on a docker execution used Docker's default 10 s grace
 * period, so a graceful-shutdown handler that needs longer was SIGKILLed
 * (exit 137) before it could finish. The grace period is now configurable:
 *
 *   $ --stop <uuid> --stop-timeout <s>                  -> docker stop -t <s>
 *   $ --isolated docker --stop-timeout <s> -- <command> -> docker run --stop-timeout <s>
 *   START_DOCKER_STOP_TIMEOUT=<s>                       -> default for both
 *
 * and the stop message says how long the container has before SIGKILL.
 */
// Own snapshot lock even without the bunfig.toml preload (issue #234).
require('./setup/private-snapshot-lock');
const { describe, it, expect } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('../src/lib/args-parser');
const {
  DOCKER_DEFAULT_STOP_TIMEOUT,
  DOCKER_STOP_TIMEOUT_ENV,
  resolveStopTimeout,
  validate: validateStopTimeout,
} = require('../src/lib/docker-stop-timeout');
const {
  buildDockerRuntimeArgs,
  buildDockerRuntimeStatusLines,
  buildDockerRuntimeMetadata,
} = require('../src/lib/docker-runtime-args');
const {
  ControlAction,
  controlExecution,
  getControlCommand,
} = require('../src/lib/execution-control');
const {
  ExecutionRecord,
  ExecutionStatus,
  ExecutionStore,
} = require('../src/lib/execution-store');
const {
  buildLaunchOptions,
  buildResumePlan,
} = require('../src/lib/execution-resume');
const { SessionState } = require('../src/lib/session-probe');
const { buildNextLevelCommand } = require('../src/lib/command-builder');
const { canRunLinuxDockerImages } = require('../src/lib/isolation');

const CLI = path.join(__dirname, '../src/bin/cli.js');
const IMAGE = 'alpine:3.23';

function parse(args, env = {}) {
  const saved = process.env[DOCKER_STOP_TIMEOUT_ENV];
  if (env[DOCKER_STOP_TIMEOUT_ENV] === undefined) {
    delete process.env[DOCKER_STOP_TIMEOUT_ENV];
  } else {
    process.env[DOCKER_STOP_TIMEOUT_ENV] = env[DOCKER_STOP_TIMEOUT_ENV];
  }
  try {
    return parseArgs(args).wrapperOptions;
  } finally {
    if (saved === undefined) {
      delete process.env[DOCKER_STOP_TIMEOUT_ENV];
    } else {
      process.env[DOCKER_STOP_TIMEOUT_ENV] = saved;
    }
  }
}

const UUID = '26500000-0000-4000-8000-000000000265';

function makeRecord(options = {}) {
  return new ExecutionRecord({
    uuid: UUID,
    command: 'npm test',
    pid: 4242,
    logPath: '/tmp/session-265.log',
    status: ExecutionStatus.EXECUTING,
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: 'box',
      image: 'ubuntu:24.04',
      ...options,
    },
  });
}

describe('issue #265: parsing --stop-timeout', () => {
  it('accepts both flag forms with --stop', () => {
    expect(parse(['--stop', UUID, '--stop-timeout', '120']).stopTimeout).toBe(
      120
    );
    expect(parse(['--stop', UUID, '--stop-timeout=0']).stopTimeout).toBe(0);
  });

  it('accepts the flag on a docker launch, also in a stack', () => {
    expect(
      parse(['--isolated', 'docker', '--stop-timeout', '30', '--', 'ls'])
        .stopTimeout
    ).toBe(30);
    expect(
      parse([
        '--isolated',
        'screen docker',
        '--image',
        `_ ${IMAGE}`,
        '--stop-timeout=45',
        '--',
        'ls',
      ]).stopTimeout
    ).toBe(45);
  });

  it('rejects a missing, negative, fractional or textual value', () => {
    expect(() => parse(['--stop', UUID, '--stop-timeout'])).toThrow(
      /requires a number of seconds/
    );
    expect(() => parse(['--stop', UUID, '--stop-timeout', '-5'])).toThrow(
      /requires a number of seconds/
    );
    for (const value of ['1.5', 'ten', '10s', '']) {
      expect(() => parse(['--stop', UUID, `--stop-timeout=${value}`])).toThrow(
        /non-negative whole number of seconds/
      );
    }
  });

  it('rejects the flag outside --stop and docker launches', () => {
    for (const args of [
      ['--stop-timeout', '30', '--', 'ls'],
      ['--isolated', 'screen', '--stop-timeout', '30', '--', 'ls'],
      ['--terminate', UUID, '--stop-timeout', '30'],
    ]) {
      expect(() => parse(args)).toThrow(
        /only valid with --stop or when isolation stack includes docker/
      );
    }
  });

  it('defaults a docker launch from START_DOCKER_STOP_TIMEOUT', () => {
    const env = { [DOCKER_STOP_TIMEOUT_ENV]: '90' };
    const launch = ['--isolated', 'docker', '--', 'ls'];
    expect(parse(launch, env).stopTimeout).toBe(90);
    expect(parse(launch).stopTimeout).toBeNull();
    expect(parse(launch, { [DOCKER_STOP_TIMEOUT_ENV]: '' }).stopTimeout).toBe(
      null
    );
    // The flag wins over the environment.
    expect(
      parse(['--isolated', 'docker', '--stop-timeout', '5', '--', 'ls'], env)
        .stopTimeout
    ).toBe(5);
    // Non-docker launches ignore it.
    expect(
      parse(['--isolated', 'screen', '--', 'ls'], env).stopTimeout
    ).toBeNull();
    expect(() => parse(launch, { [DOCKER_STOP_TIMEOUT_ENV]: 'soon' })).toThrow(
      /Invalid START_DOCKER_STOP_TIMEOUT value/
    );
  });

  it('validates idempotently', () => {
    const options = { isolated: 'docker', isolatedStack: ['docker'] };
    validateStopTimeout(options, { [DOCKER_STOP_TIMEOUT_ENV]: '7' });
    validateStopTimeout(options, {});
    expect(options.stopTimeout).toBe(7);
  });
});

describe('issue #265: docker run --stop-timeout at launch', () => {
  it('adds --stop-timeout to the runtime args, including 0', () => {
    const args = buildDockerRuntimeArgs({ stopTimeout: 30 });
    expect(args.join(' ')).toContain('--stop-timeout 30');
    expect(buildDockerRuntimeArgs({ stopTimeout: 0 }).join(' ')).toContain(
      '--stop-timeout 0'
    );
    expect(buildDockerRuntimeArgs({})).not.toContain('--stop-timeout');
  });

  it('shows and records the launch grace period', () => {
    expect(buildDockerRuntimeStatusLines({ stopTimeout: 30 })).toContain(
      '[Isolation] Stop timeout: 30s'
    );
    expect(buildDockerRuntimeMetadata({ stopTimeout: 30 }).stopTimeout).toBe(
      30
    );
    expect(buildDockerRuntimeMetadata({}).stopTimeout).toBeNull();
  });
});

describe('issue #265: --stop passes the grace period to docker stop', () => {
  it('passes -t for an explicit --stop-timeout and says so', () => {
    const control = getControlCommand(makeRecord(), ControlAction.STOP, {
      stopTimeout: 120,
      env: {},
    });
    expect(control.args).toEqual(['stop', '-t', '120', 'box']);
    expect(control.stopTimeout).toBe(120);
    expect(control.message).toBe(
      'Requested graceful stop for detached docker container: box (SIGTERM, SIGKILL after 120s)'
    );
  });

  it("keeps Docker's own default, and names it, when nothing is set", () => {
    const control = getControlCommand(makeRecord(), ControlAction.STOP, {
      env: {},
    });
    expect(control.args).toEqual(['stop', 'box']);
    expect(control.stopTimeout).toBe(DOCKER_DEFAULT_STOP_TIMEOUT);
    expect(control.message).toContain('(SIGTERM, SIGKILL after 10s)');
  });

  it('resolves flag, then launch value, then environment', () => {
    const env = { [DOCKER_STOP_TIMEOUT_ENV]: '60' };
    const recorded = makeRecord({ stopTimeout: 30 });
    expect(resolveStopTimeout(recorded, 5, env)).toEqual({
      seconds: 5,
      explicit: true,
    });
    expect(resolveStopTimeout(recorded, null, env)).toEqual({
      seconds: 30,
      explicit: true,
    });
    expect(resolveStopTimeout(makeRecord(), null, env)).toEqual({
      seconds: 60,
      explicit: true,
    });
    expect(
      getControlCommand(recorded, ControlAction.STOP, { env: {} }).args
    ).toEqual(['stop', '-t', '30', 'box']);
    expect(
      getControlCommand(makeRecord(), ControlAction.STOP, { env }).args
    ).toEqual(['stop', '-t', '60', 'box']);
  });

  it('reports an invalid environment value instead of stopping', () => {
    const control = getControlCommand(makeRecord(), ControlAction.STOP, {
      env: { [DOCKER_STOP_TIMEOUT_ENV]: '-1' },
    });
    expect(control.error).toMatch(/Invalid START_DOCKER_STOP_TIMEOUT value/);
  });

  it('rejects --stop-timeout for screen and tmux sessions', () => {
    for (const isolated of ['screen', 'tmux']) {
      const control = getControlCommand(
        makeRecord({ isolated, sessionName: 's' }),
        ControlAction.STOP,
        { stopTimeout: 30, env: {} }
      );
      expect(control.error).toBe(
        `--stop-timeout is only supported for detached docker executions, not ${isolated}.`
      );
    }
  });

  it('leaves --terminate (docker kill) unchanged', () => {
    const control = getControlCommand(
      makeRecord({ stopTimeout: 30 }),
      ControlAction.TERMINATE,
      { env: {} }
    );
    expect(control.args).toEqual(['kill', 'box']);
    expect(control.stopTimeout).toBeUndefined();
  });

  it('runs docker stop -t and prints the grace period', () => {
    const appFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'start-265-'));
    try {
      const store = new ExecutionStore({ appFolder, useLinks: false });
      store.save(makeRecord());
      const calls = [];
      const runner = (command, args) => {
        calls.push({ command, args });
        return { success: true, stdout: '', stderr: '', status: 0 };
      };
      const result = controlExecution(store, UUID, ControlAction.STOP, runner, {
        stopTimeout: 45,
        env: {},
      });
      expect(result.success).toBe(true);
      expect(calls[0]).toEqual({
        command: 'docker',
        args: ['stop', '-t', '45', 'box'],
      });
      expect(result.output).toContain('  method DOCKER_STOP\n  stopTimeout 45');
      expect(result.output).toContain(
        'Requested graceful stop for detached docker container: box (SIGTERM, SIGKILL after 45s)'
      );
    } finally {
      fs.rmSync(appFolder, { recursive: true, force: true });
    }
  });
});

const stopped = {
  backend: 'docker',
  sessionName: 'box',
  state: SessionState.STOPPED,
  alive: false,
  containerStatus: 'exited',
};

describe('issue #265: resume and stacked launches keep the grace period', () => {
  it('relaunches with the recorded --stop-timeout', () => {
    const record = makeRecord({ stopTimeout: 30 });
    expect(buildLaunchOptions(record).stopTimeout).toBe(30);
    const plan = buildResumePlan(record, 'echo hi', stopped);
    expect(plan.steps[1].args.join(' ')).toContain('--stop-timeout 30');
  });

  it('starts records from before #265 without --stop-timeout', () => {
    const plan = buildResumePlan(makeRecord(), 'echo hi', stopped);
    expect(plan.steps[1].args).not.toContain('--stop-timeout');
  });

  it('passes --stop-timeout to the nested docker level of a stack', () => {
    const stacked = {
      isolated: 'screen',
      isolatedStack: ['screen', 'docker'],
      imageStack: [null, IMAGE],
    };
    expect(
      buildNextLevelCommand({ ...stacked, stopTimeout: 0 }, 'ls')
    ).toContain('--stop-timeout 0');
    expect(buildNextLevelCommand(stacked, 'ls')).not.toContain(
      '--stop-timeout'
    );
  });
});

const dockerReady = (() => {
  try {
    return canRunLinuxDockerImages();
  } catch {
    return false;
  }
})();

function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: (r.stdout || '').trim(), err: r.stderr };
}

function cli(args, root, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 90000,
    env: {
      ...process.env,
      HOME: root,
      START_APP_FOLDER: path.join(root, 'app'),
      START_LOG_DIR: path.join(root, 'logs'),
      START_DISABLE_AUTO_ISSUE: '1',
      START_DISABLE_LOG_UPLOAD: '1',
      START_EXECUTION_ID: '',
      [DOCKER_STOP_TIMEOUT_ENV]: '',
      ...extraEnv,
    },
  });
}

function waitForLog(name, text, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (docker('logs', name).out.includes(text)) {
      return true;
    }
    spawnSync('sleep', ['0.2']);
  }
  return false;
}

describe('issue #265: real docker', () => {
  it.skipIf(!dockerReady)(
    'lets a slow SIGTERM handler finish instead of SIGKILL at 10s',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-265-'));
      const name = `t265-grace-${process.pid}`;
      // The handler needs ~2s; a 1s grace period kills it, 5s does not.
      const command =
        "trap 'echo got-term; sleep 2; echo cleanup-done; exit 0' TERM; " +
        'echo ready; while true; do sleep 0.1; done';
      try {
        const launched = cli(
          [
            '--isolated',
            'docker',
            '--stop-timeout',
            '5',
            '--detached',
            '--keep-container',
            '--image',
            IMAGE,
            '--session',
            name,
            '--',
            command,
          ],
          root
        );
        expect(launched.status).toBe(0);
        expect(
          docker('inspect', '-f', '{{.Config.StopTimeout}}', name).out
        ).toBe('5');
        expect(waitForLog(name, 'ready', 30000)).toBe(true);

        // --stop uses the recorded launch value.
        const stop = cli(['--stop', name], root);
        expect(stop.status).toBe(0);
        expect(stop.stdout).toContain('stopTimeout 5');
        expect(stop.stdout).toContain('(SIGTERM, SIGKILL after 5s)');
        expect(docker('inspect', '-f', '{{.State.ExitCode}}', name).out).toBe(
          '0'
        );
        expect(docker('logs', name).out).toContain('cleanup-done');
      } finally {
        docker('rm', '-f', name);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    120000
  );

  it.skipIf(!dockerReady)(
    'kills after a shorter --stop --stop-timeout',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-265-'));
      const name = `t265-short-${process.pid}`;
      const command =
        "trap 'echo got-term; sleep 5; echo cleanup-done; exit 0' TERM; " +
        'echo ready; while true; do sleep 0.1; done';
      try {
        const launched = cli(
          [
            '--isolated',
            'docker',
            '--detached',
            '--keep-container',
            '--image',
            IMAGE,
            '--session',
            name,
            '--',
            command,
          ],
          root
        );
        expect(launched.status).toBe(0);
        expect(waitForLog(name, 'ready', 30000)).toBe(true);
        const started = Date.now();
        const stop = cli(['--stop', name, '--stop-timeout', '1'], root);
        const elapsed = Date.now() - started;
        expect(stop.status).toBe(0);
        expect(stop.stdout).toContain('(SIGTERM, SIGKILL after 1s)');
        // Well under Docker's 10s default.
        expect(elapsed).toBeLessThan(8000);
        expect(docker('inspect', '-f', '{{.State.ExitCode}}', name).out).toBe(
          '137'
        );
        expect(docker('logs', name).out).not.toContain('cleanup-done');
      } finally {
        docker('rm', '-f', name);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    120000
  );
});
