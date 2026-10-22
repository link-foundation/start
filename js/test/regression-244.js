/**
 * Issue #244: `--init` / `--no-init` run Docker's bundled tini as PID 1, so
 * orphaned processes of a long-running task are reaped instead of piling up
 * as zombies. The default stays off; START_COMMAND_DOCKER_INIT=1 turns it on
 * per host. The flag is stored with the record, carried into resumes and
 * stacked launches, and changes neither exit codes nor OOM evidence.
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
  DOCKER_INIT_ENV,
  dockerInitFromEnv,
  validate: validateDockerInitOption,
} = require('../src/lib/docker-init-option');
const {
  buildDockerRuntimeArgs,
  buildDockerRuntimeStatusLines,
  buildDockerRuntimeMetadata,
} = require('../src/lib/docker-runtime-args');
const {
  buildLaunchOptions,
  buildResumePlan,
} = require('../src/lib/execution-resume');
const { SessionState } = require('../src/lib/session-probe');
const { buildNextLevelCommand } = require('../src/lib/command-builder');
const {
  parseIsolationMetadata,
  generateIsolationLines,
} = require('../src/lib/output-blocks');
const { canRunLinuxDockerImages } = require('../src/lib/isolation');

const CLI = path.join(__dirname, '../src/bin/cli.js');
const IMAGE = 'alpine:3.23';

function parse(args, env = {}) {
  const saved = process.env[DOCKER_INIT_ENV];
  if (env[DOCKER_INIT_ENV] === undefined) {
    delete process.env[DOCKER_INIT_ENV];
  } else {
    process.env[DOCKER_INIT_ENV] = env[DOCKER_INIT_ENV];
  }
  try {
    return parseArgs(args).wrapperOptions;
  } finally {
    if (saved === undefined) {
      delete process.env[DOCKER_INIT_ENV];
    } else {
      process.env[DOCKER_INIT_ENV] = saved;
    }
  }
}

describe('issue #244: parsing --init / --no-init', () => {
  it('turns init on with --init and off with --no-init', () => {
    expect(parse(['-i', 'docker', '--init', '--', 'ls']).init).toBe(true);
    expect(parse(['-i', 'docker', '--no-init', '--', 'ls']).init).toBe(false);
  });

  it('defaults to off', () => {
    expect(parse(['-i', 'docker', '--', 'ls']).init).toBe(false);
    expect(parse(['--', 'ls']).init).toBe(false);
  });

  it('takes the default from START_COMMAND_DOCKER_INIT', () => {
    for (const value of ['1', 'true', 'YES', ' on ']) {
      const env = { [DOCKER_INIT_ENV]: value };
      expect(parse(['-i', 'docker', '--', 'ls'], env).init).toBe(true);
    }
    for (const value of ['0', 'false', 'off', '']) {
      const env = { [DOCKER_INIT_ENV]: value };
      expect(parse(['-i', 'docker', '--', 'ls'], env).init).toBe(false);
    }
  });

  it('lets --no-init override the environment default', () => {
    const env = { [DOCKER_INIT_ENV]: '1' };
    expect(parse(['-i', 'docker', '--no-init', '--', 'ls'], env).init).toBe(
      false
    );
  });

  it('ignores the environment default without docker, without an error', () => {
    const env = { [DOCKER_INIT_ENV]: '1' };
    expect(parse(['--', 'ls'], env).init).toBe(false);
    expect(parse(['-i', 'screen', '-d', '--', 'ls'], env).init).toBe(false);
  });

  it('rejects --init without docker in the stack', () => {
    expect(() => parse(['--init', '--', 'ls'])).toThrow(
      '--init option is only valid when isolation stack includes docker'
    );
    expect(() => parse(['-i', 'screen', '-d', '--init', '--', 'ls'])).toThrow(
      '--init option is only valid when isolation stack includes docker'
    );
  });

  it('accepts --no-init without docker, since it is the default', () => {
    expect(parse(['--no-init', '--', 'ls']).init).toBe(false);
  });

  it('validates again without changing the result', () => {
    const { validateOptions } = require('../src/lib/args-parser');
    const env = { [DOCKER_INIT_ENV]: '1' };
    for (const args of [
      ['--', 'ls'],
      ['-i', 'docker', '--', 'ls'],
      ['-i', 'docker', '--no-init', '--', 'ls'],
      ['-i', 'docker', '--init', '--', 'ls'],
    ]) {
      const options = parse(args, env);
      const before = options.init;
      validateOptions(options);
      expect(options.init).toBe(before);
    }
  });

  it('accepts a stack that contains docker', () => {
    expect(
      parse(['-i', 'screen docker', '--init', '--', 'ls']).init
    ).toBeTrue();
  });

  it('reads the environment value case-insensitively', () => {
    expect(dockerInitFromEnv({ [DOCKER_INIT_ENV]: 'True' })).toBe(true);
    expect(dockerInitFromEnv({})).toBe(false);
  });

  it('validates with an explicit environment', () => {
    const options = { isolated: 'docker', isolatedStack: ['docker'] };
    options.init = null;
    validateDockerInitOption(options, { [DOCKER_INIT_ENV]: 'on' });
    expect(options.init).toBe(true);
  });
});

describe('issue #244: docker run arguments, status and metadata', () => {
  it('puts --init right after --privileged and before -e', () => {
    expect(
      buildDockerRuntimeArgs({ privileged: true, init: true, env: ['A=1'] })
    ).toEqual(['--privileged', '--init', '-e', 'A=1']);
    expect(buildDockerRuntimeArgs({ init: true })).toEqual(['--init']);
    expect(buildDockerRuntimeArgs({ init: false })).not.toContain('--init');
  });

  it('shows the init status line only when on', () => {
    expect(buildDockerRuntimeStatusLines({ init: true })).toContain(
      '[Isolation] Init: true'
    );
    expect(
      buildDockerRuntimeStatusLines({ init: false }).join('\n')
    ).not.toContain('Init');
  });

  it('stores init in the record metadata', () => {
    expect(buildDockerRuntimeMetadata({ init: true }).init).toBe(true);
    expect(buildDockerRuntimeMetadata({ init: false }).init).toBeNull();
  });

  it('renders an init row in the start block, before user', () => {
    const metadata = parseIsolationMetadata([
      '[Isolation] Environment: docker, Mode: detached',
      '[Isolation] Image: alpine:3.23',
      '[Isolation] Init: true',
      '[Isolation] User: box (isolated)',
    ]);
    expect(metadata.init).toBe(true);
    const lines = generateIsolationLines(metadata, 'box').join('\n');
    expect(lines).toMatch(/init\s+true/);
    expect(lines.indexOf('init')).toBeLessThan(lines.indexOf('user'));
    const off = parseIsolationMetadata(['[Isolation] Environment: docker']);
    expect(generateIsolationLines(off, 'box').join('\n')).not.toMatch(/init/);
  });
});

function makeRecord(options = {}) {
  return {
    uuid: '24400000-0000-4000-8000-000000000244',
    status: 'executed',
    command: 'npm test',
    logPath: '/tmp/session.log',
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: 'box',
      image: 'ubuntu:24.04',
      ...options,
    },
  };
}

const stopped = {
  backend: 'docker',
  sessionName: 'box',
  state: SessionState.STOPPED,
  alive: false,
  containerStatus: 'exited',
};

describe('issue #244: resume and stacked launches keep the choice', () => {
  it('relaunches with the stored init flag', () => {
    expect(buildLaunchOptions(makeRecord({ init: true })).init).toBe(true);
    expect(buildLaunchOptions(makeRecord()).init).toBe(false);
  });

  it('carries --init into the snapshot run', () => {
    const plan = buildResumePlan(
      makeRecord({ init: true }),
      'echo hi',
      stopped
    );
    expect(plan.steps[1].args).toContain('--init');
  });

  it('starts records from before #244 without --init', () => {
    const plan = buildResumePlan(makeRecord(), 'echo hi', stopped);
    expect(plan.steps[1].args).not.toContain('--init');
  });

  it('passes --init to the nested level of a stack', () => {
    const command = buildNextLevelCommand(
      {
        isolated: 'screen',
        isolatedStack: ['screen', 'docker'],
        imageStack: [null, IMAGE],
        init: true,
      },
      'ls'
    );
    expect(command).toContain('--init');
    expect(
      buildNextLevelCommand(
        { isolated: 'screen', isolatedStack: ['screen', 'docker'] },
        'ls'
      )
    ).not.toContain('--init');
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

function waitUntil(check, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = check();
    if (value) {
      return value;
    }
    spawnSync('sleep', ['0.2']);
  }
  return null;
}

/** Start a detached, kept container through the CLI. */
function launch(name, flags, command, root) {
  return spawnSync(
    process.execPath,
    [
      CLI,
      '--isolated',
      'docker',
      ...flags,
      '--detached',
      '--keep-container',
      '--image',
      IMAGE,
      '--session',
      name,
      '--',
      command,
    ],
    {
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        HOME: root,
        START_APP_FOLDER: path.join(root, 'app'),
        START_LOG_DIR: path.join(root, 'logs'),
        START_DISABLE_AUTO_ISSUE: '1',
        START_DISABLE_LOG_UPLOAD: '1',
        START_EXECUTION_ID: '',
        [DOCKER_INIT_ENV]: '',
      },
    }
  );
}

function status(name, root) {
  const r = spawnSync(
    process.execPath,
    [CLI, '--status', name, '--output-format', 'json'],
    {
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        HOME: root,
        START_APP_FOLDER: path.join(root, 'app'),
        START_LOG_DIR: path.join(root, 'logs'),
        START_DISABLE_AUTO_ISSUE: '1',
      },
    }
  );
  return r.stdout || '';
}

describe('issue #244: real docker', () => {
  it.skipIf(!dockerReady)(
    'runs docker-init as PID 1 and reaps an orphan, recorded in --status',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-244-'));
      const names = [`t244-init-${process.pid}`, `t244-plain-${process.pid}`];
      try {
        // The subshell exits at once; its `sleep 0.2` child becomes an
        // orphan of PID 1 and exits 0.2 s later.
        const command = '(sleep 0.2 &) ; sleep 30';
        for (const [name, flags] of [
          [names[0], ['--init']],
          [names[1], []],
        ]) {
          const r = launch(name, flags, command, root);
          expect(r.status).toBe(0);
        }
        spawnSync('sleep', ['1.5']);
        const probe = (name) => ({
          init: docker('inspect', '-f', '{{.HostConfig.Init}}', name).out,
          pid1: docker('exec', name, 'cat', '/proc/1/comm').out,
          zombies: docker(
            'exec',
            name,
            'sh',
            '-c',
            'grep -l "^State:.*Z" /proc/[0-9]*/status 2>/dev/null | wc -l'
          ).out,
        });
        const withInit = probe(names[0]);
        const without = probe(names[1]);
        expect(withInit).toEqual({
          init: 'true',
          pid1: 'docker-init',
          zombies: '0',
        });
        // Unset, Docker reports `<nil>` (no --init flag on the run).
        expect(['false', '<nil>']).toContain(without.init);
        expect(without.pid1).not.toBe('docker-init');
        expect(without.zombies).toBe('1');

        expect(status(names[0], root)).toMatch(/"init":\s*true/);
        expect(status(names[1], root)).not.toMatch(/"init":\s*true/);
      } finally {
        docker('rm', '-f', ...names);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    90000
  );

  it.skipIf(!dockerReady)(
    'keeps exit codes the same with and without --init',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-244-'));
      const names = [];
      try {
        const cases = [
          ['exit3', 'exit 3', 3],
          ['segv', 'sh -c "kill -SEGV \\$\\$"; exit $?', 139],
        ];
        for (const [label, command, expected] of cases) {
          for (const flags of [['--init'], []]) {
            const name = `t244-${label}-${flags.length}-${process.pid}`;
            names.push(name);
            expect(launch(name, flags, command, root).status).toBe(0);
            const code = waitUntil(() => {
              const r = docker(
                'inspect',
                '-f',
                '{{.State.Status}} {{.State.ExitCode}}',
                name
              );
              const [state, exitCode] = r.out.split(' ');
              return state === 'exited' ? Number(exitCode) : null;
            }, 30000);
            expect(code).toBe(expected);
          }
        }
        // Both editions' --status agree on the exit code once the watcher
        // has recorded it.
        for (const name of names) {
          const expected = name.includes('exit3') ? 3 : 139;
          const recorded = waitUntil(() => {
            const match = status(name, root).match(/"exitCode":\s*(-?\d+)/);
            return match && Number(match[1]) === expected;
          }, 30000);
          expect(recorded).toBe(true);
        }
      } finally {
        if (names.length) {
          docker('rm', '-f', ...names);
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    120000
  );

  it.skipIf(!dockerReady)(
    'docker kill gives 137 either way; docker stop gives 143 under tini',
    () => {
      const names = [`t244-k1-${process.pid}`, `t244-k0-${process.pid}`];
      try {
        const results = {};
        for (const name of names) {
          const init = name.includes('-k1-');
          const run = docker(
            'run',
            '-d',
            '--name',
            name,
            ...(init ? ['--init'] : []),
            IMAGE,
            'sleep',
            '30'
          );
          expect(run.status).toBe(0);
          docker('stop', '-t', '2', name);
          results[init ? 'stopInit' : 'stopPlain'] = docker(
            'inspect',
            '-f',
            '{{.State.ExitCode}}',
            name
          ).out;
          docker('start', name);
          docker('kill', name);
          docker('wait', name);
          results[init ? 'killInit' : 'killPlain'] = docker(
            'inspect',
            '-f',
            '{{.State.ExitCode}}',
            name
          ).out;
        }
        expect(results).toEqual({
          stopInit: '143',
          stopPlain: '137',
          killInit: '137',
          killPlain: '137',
        });
      } finally {
        docker('rm', '-f', ...names);
      }
    },
    90000
  );
});
