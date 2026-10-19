/**
 * Issue #230: every backend exports START_EXECUTION_ID, START_SESSION_NAME and
 * START_ATTEMPT to the command it runs, so a supervisor can recognise its
 * own executions without parsing the start block.
 */
const { describe, it, expect } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildExecutionEnv,
  buildExecutionEnvExport,
  executionEnvFromOptions,
  isNestedLaunchOf,
  prefixWithExecutionEnv,
} = require('../src/lib/execution-env');
const { buildDockerRuntimeArgs } = require('../src/lib/docker-runtime-args');
const {
  buildCommandHandoffArgs,
  writeExecutionEnvHandoff,
} = require('../src/lib/docker-command-handoff');
const { nextAttemptNumber } = require('../src/lib/execution-attempt');

const CLI = path.join(__dirname, '../src/bin/cli.js');
const UUID = '23000000-0000-4000-8000-000000000230';
const PRINT =
  'echo "ID=$START_EXECUTION_ID S=$START_SESSION_NAME A=$START_ATTEMPT"';

function run(args, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-230-'));
  return spawnSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      START_APP_FOLDER: path.join(root, 'app'),
      START_LOG_DIR: path.join(root, 'logs'),
      START_DISABLE_AUTO_ISSUE: '1',
      START_DISABLE_LOG_UPLOAD: '1',
      START_EXECUTION_ID: '',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
}

function hasCommand(name) {
  return spawnSync('sh', ['-c', `command -v ${name}`]).status === 0;
}

describe('issue #230: START_* execution identity variables', () => {
  it('builds the three variables, attempt 1 by default', () => {
    expect(buildExecutionEnv({ executionId: UUID, sessionName: 's' })).toEqual({
      START_EXECUTION_ID: UUID,
      START_SESSION_NAME: 's',
      START_ATTEMPT: '1',
    });
    expect(buildExecutionEnv({})).toEqual({});
    expect(
      executionEnvFromOptions({
        sessionId: UUID,
        session: 'tmux-1',
        attemptNumber: 4,
      })
    ).toMatchObject({ START_SESSION_NAME: 'tmux-1', START_ATTEMPT: '4' });
  });

  it('quotes the export prefix used by screen, tmux and ssh', () => {
    const env = buildExecutionEnv({
      executionId: UUID,
      sessionName: "it's",
      attempt: 2,
    });
    expect(buildExecutionEnvExport(env)).toBe(
      `export START_EXECUTION_ID='${UUID}' START_SESSION_NAME='it'\\''s' START_ATTEMPT='2'`
    );
    const out = spawnSync('sh', ['-c', prefixWithExecutionEnv(PRINT, env)], {
      encoding: 'utf8',
    }).stdout;
    expect(out.trim()).toBe(`ID=${UUID} S=it's A=2`);
  });

  it('passes them to docker run after the user --env, so they win', () => {
    const args = buildDockerRuntimeArgs({
      env: [`START_EXECUTION_ID=spoofed`],
      sessionId: UUID,
      containerName: 'box',
      attemptNumber: 3,
    });
    const envs = args.filter((_, i) => args[i - 1] === '-e');
    expect(envs).toEqual([
      'START_EXECUTION_ID=spoofed',
      `START_EXECUTION_ID=${UUID}`,
      'START_SESSION_NAME=box',
      'START_ATTEMPT=3',
    ]);
  });

  it('the docker handoff selector sources the next attempt variables', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-230-handoff-'));
    const marker = path.join(dir, 'marker');
    const calls = [];
    writeExecutionEnvHandoff(
      'box',
      buildExecutionEnv({ executionId: UUID, sessionName: 'box', attempt: 2 }),
      (cmd, argv) => {
        calls.push(argv);
        fs.copyFileSync(argv[1], `${marker}.env`);
        return { status: 0 };
      }
    );
    expect(calls[0][2]).toBe('box:/.start-command-resume-box.env');
    const [shell, ...rest] = buildCommandHandoffArgs(
      ['sh', '-c', PRINT],
      marker
    );
    const out = spawnSync(shell, rest, {
      encoding: 'utf8',
      env: { ...process.env, START_ATTEMPT: '1' },
    }).stdout;
    expect(out.trim()).toBe(`ID=${UUID} S=box A=2`);
  });

  it('numbers the next attempt after resumes and recoveries', () => {
    expect(nextAttemptNumber({})).toBe(2);
    expect(nextAttemptNumber({ attempt: { number: 3 } })).toBe(4);
    expect(nextAttemptNumber({ options: { resumeCount: 1 } })).toBe(3);
  });

  it('recognises the next level of a stacked isolation', () => {
    expect(isNestedLaunchOf(UUID, { START_EXECUTION_ID: UUID })).toBe(true);
    expect(isNestedLaunchOf(UUID, { START_EXECUTION_ID: 'other' })).toBe(false);
    expect(isNestedLaunchOf(UUID, {})).toBe(false);
  });

  if (process.platform === 'win32') {
    return;
  }

  it("$ --session-id X -- sh -c 'echo $START_EXECUTION_ID' prints X", () => {
    const result = run([
      '--session-id',
      UUID,
      '--',
      'sh',
      '-c',
      'echo $START_EXECUTION_ID',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`\n${UUID}\n`);
  });

  it('a direct run exports an empty session name and attempt 1', () => {
    const result = run(['--session-id', UUID, '--', 'sh', '-c', PRINT]);
    expect(result.stdout).toContain(`ID=${UUID} S= A=1`);
  });

  it('a generated execution id is exported too', () => {
    const result = run(['--', 'sh', '-c', PRINT]);
    const match = /ID=([0-9a-f-]{36}) S= A=1/.exec(result.stdout);
    expect(match).not.toBeNull();
    expect(result.stdout).toContain(match[1]);
  });

  it('the command-stream runner exports them', () => {
    const result = run(
      ['--session-id', UUID, '--use-command-stream', '--', 'sh', '-c', PRINT],
      {}
    );
    expect(result.stdout).toContain(`ID=${UUID} S= A=1`);
  });

  it.skipIf(!hasCommand('screen'))(
    'screen exports them with the session name',
    () => {
      const session = `start-230-${process.pid}`;
      const result = run([
        '-i',
        'screen',
        '--session',
        session,
        '--session-id',
        UUID,
        '--',
        'sh',
        '-c',
        PRINT,
      ]);
      expect(result.stdout).toContain(`ID=${UUID} S=${session} A=1`);
    },
    30000
  );

  it.skipIf(!hasCommand('tmux'))(
    'tmux exports them with the session name',
    () => {
      const session = `start-230-tmux-${process.pid}`;
      const result = run([
        '-i',
        'tmux',
        '--session',
        session,
        '--session-id',
        UUID,
        '--',
        'sh',
        '-c',
        PRINT,
      ]);
      expect(result.stdout).toContain(`ID=${UUID} S=${session} A=1`);
    },
    30000
  );
});
