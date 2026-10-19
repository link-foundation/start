/**
 * Issue #229: a new launch with an existing --session-id used to replace the
 * execution record and truncate its log. It is now refused unless
 * --append-attempt is given, which keeps the record and appends the new
 * attempt to the same log.
 */
const { describe, it, expect } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('../src/lib/args-parser');
const {
  ExecutionStore,
  ExecutionRecord,
} = require('../src/lib/execution-store');
const {
  LaunchRefusedError,
  alreadyExistsMessage,
  claimLaunch,
  mergeAppendedAttempt,
  preflightLaunch,
} = require('../src/lib/launch-identity');

const CLI = path.join(__dirname, '../src/bin/cli.js');
const UUID = '22900000-0000-4000-8000-000000000229';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-229-'));
  const app = path.join(root, 'app');
  const logs = path.join(root, 'logs');
  return {
    root,
    app,
    logs,
    env: {
      ...process.env,
      START_APP_FOLDER: app,
      START_LOG_DIR: logs,
      START_DISABLE_AUTO_ISSUE: '1',
      START_DISABLE_LOG_UPLOAD: '1',
      START_EXECUTION_ID: '',
    },
  };
}

function run(box, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: box.env,
    encoding: 'utf8',
    timeout: 20000,
  });
}

function storeOf(box) {
  return new ExecutionStore({ appFolder: box.app });
}

describe('issue #229: an existing --session-id is never overwritten', () => {
  if (process.platform === 'win32') {
    return;
  }

  it('refuses a second launch and keeps the first log intact', () => {
    const box = sandbox();
    const first = run(box, ['--session-id', UUID, '--', 'echo', 'first-run']);
    expect(first.status).toBe(0);
    const logPath = storeOf(box).get(UUID).logPath;
    const before = fs.readFileSync(logPath, 'utf8');

    const second = run(box, ['--session-id', UUID, '--', 'echo', 'second']);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain(alreadyExistsMessage(UUID));
    expect(second.stdout).not.toContain('second');
    expect(fs.readFileSync(logPath, 'utf8')).toBe(before);
    const record = storeOf(box).get(UUID);
    expect(record.command).toBe('echo first-run');
    expect(record.attemptHistory || []).toEqual([]);
  });

  it('--append-attempt keeps the record and appends to the same log', () => {
    const box = sandbox();
    run(box, ['--session-id', UUID, '--', 'echo', 'first-run']);
    const logPath = storeOf(box).get(UUID).logPath;
    const firstSize = fs.statSync(logPath).size;

    const appended = run(box, [
      '--session-id',
      UUID,
      '--append-attempt',
      '--',
      'sh',
      '-c',
      'echo second-run $START_ATTEMPT',
    ]);
    expect(appended.status).toBe(0);
    expect(appended.stdout).toContain('second-run 2');

    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('first-run');
    expect(log).toContain('second-run 2');
    expect(log.split('=== Start Command Log ===').length - 1).toBe(2);
    expect(log).toContain('"event":"attempt-appended"');

    const record = storeOf(box).get(UUID);
    expect(record.attempt.number).toBe(2);
    expect(record.attempt.mode).toBe('append-attempt');
    expect(record.attempt.logOffset).toBe(firstSize);
    expect(record.attemptHistory).toHaveLength(1);
    expect(record.attemptHistory[0]).toMatchObject({
      number: 1,
      logOffset: 0,
      command: 'echo first-run',
      exitCode: 0,
    });
    expect(record.logPath).toBe(logPath);
  });

  it('refuses an id that is the name of another execution', () => {
    const box = sandbox();
    const other = '22900000-0000-4000-8000-000000000001';
    run(box, ['--session-id', other, '--', 'echo', 'x']);
    expect(run(box, ['--alias', other, UUID]).status).toBe(0);
    const launch = run(box, ['--session-id', UUID, '--', 'echo', 'y']);
    expect(launch.status).toBe(1);
    expect(launch.stderr).toContain(
      `execution id ${UUID} is already used as a name of execution ${other}`
    );
  });

  it('recognises an untracked execution by its log file', () => {
    const box = sandbox();
    box.env.START_DISABLE_TRACKING = '1';
    const logPath = path.join(box.logs, 'direct', `${UUID}.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '=== Start Command Log ===\nold\n');
    const store = { get: () => null };
    expect(() =>
      preflightLaunch({
        store,
        sessionId: UUID,
        explicitSessionId: true,
        logPath,
        env: {},
      })
    ).toThrow(LaunchRefusedError);
    const launch = preflightLaunch({
      store,
      sessionId: UUID,
      explicitSessionId: true,
      appendAttempt: true,
      logPath,
      env: {},
    });
    expect(launch).toMatchObject({ append: true, attemptNumber: 2 });
  });

  it('refuses --append-attempt while the execution is still running', () => {
    const record = new ExecutionRecord({ uuid: UUID, command: 'sleep 9' });
    record.pid = process.pid;
    expect(() =>
      preflightLaunch({
        store: { get: () => record },
        sessionId: UUID,
        explicitSessionId: true,
        appendAttempt: true,
        logPath: '/nonexistent',
        env: {},
      })
    ).toThrow(/is still running/);
  });

  it('lets the next level of a stacked isolation reuse the id', () => {
    const record = new ExecutionRecord({ uuid: UUID, command: 'x' });
    const launch = preflightLaunch({
      store: { get: () => record },
      sessionId: UUID,
      explicitSessionId: true,
      logPath: '/nonexistent',
      env: { START_EXECUTION_ID: UUID, START_ATTEMPT: '3' },
    });
    expect(launch).toMatchObject({ nested: true, attemptNumber: 3 });
  });

  it('a generated id is never checked', () => {
    const launch = preflightLaunch({
      store: {
        get: () => {
          throw new Error('must not be read');
        },
      },
      sessionId: UUID,
      explicitSessionId: false,
      logPath: '/nonexistent',
    });
    expect(launch).toMatchObject({ append: false, checked: false });
  });

  it('claimLaunch refuses a launch that lost the race for the id', () => {
    const box = sandbox();
    const store = storeOf(box);
    const launch = preflightLaunch({
      store,
      sessionId: UUID,
      explicitSessionId: true,
      logPath: path.join(box.root, 'none.log'),
      env: {},
    });
    store.save(new ExecutionRecord({ uuid: UUID, command: 'winner' }));
    expect(() =>
      claimLaunch(
        store,
        new ExecutionRecord({ uuid: UUID, command: 'loser' }),
        launch
      )
    ).toThrow(LaunchRefusedError);
    expect(store.get(UUID).command).toBe('winner');
  });

  it('mergeAppendedAttempt keeps names, continuation and history', () => {
    const previous = new ExecutionRecord({
      uuid: UUID,
      command: 'old',
      logPath: '/nonexistent.log',
      options: { sessionName: 'old-s', aliases: ['a'], name: 'n' },
    });
    previous.continues = '22900000-0000-4000-8000-000000000002';
    previous.complete(3);
    const record = new ExecutionRecord({
      uuid: UUID,
      command: 'new',
      options: { sessionName: 'new-s' },
    });
    mergeAppendedAttempt(record, previous);
    expect(record.startTime).toBe(previous.startTime);
    expect(record.continues).toBe(previous.continues);
    expect(record.options).toMatchObject({
      sessionName: 'new-s',
      sessionNameHistory: ['old-s'],
      aliases: ['a'],
      name: 'n',
    });
    expect(record.attempt.number).toBe(2);
    expect(record.attemptHistory[0]).toMatchObject({
      number: 1,
      exitCode: 3,
      sessionName: 'old-s',
    });
  });

  it('parses --append-attempt and requires --session-id', () => {
    const parsed = parseArgs([
      '--session-id',
      UUID,
      '--append-attempt',
      '--',
      'echo',
    ]);
    expect(parsed.wrapperOptions.appendAttempt).toBe(true);
    expect(() => parseArgs(['--append-attempt', '--', 'echo'])).toThrow(
      '--append-attempt option requires --session-id <uuid>'
    );
    expect(() => parseArgs(['--status', UUID, '--append-attempt'])).toThrow(
      '--append-attempt option is only valid when launching a command'
    );
  });
});
