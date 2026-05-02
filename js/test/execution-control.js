#!/usr/bin/env bun
/**
 * Unit tests for detached execution control helpers.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ControlAction,
  collectProcessIds,
  controlExecution,
  getControlCommand,
  parseScreenPid,
} = require('../src/lib/execution-control');
const {
  ExecutionRecord,
  ExecutionStatus,
  ExecutionStore,
} = require('../src/lib/execution-store');

const TEST_APP_FOLDER = path.join(
  os.tmpdir(),
  `execution-control-test-${Date.now()}`
);

function cleanupTestDir() {
  if (fs.existsSync(TEST_APP_FOLDER)) {
    fs.rmSync(TEST_APP_FOLDER, { recursive: true, force: true });
  }
}

function createStore() {
  return new ExecutionStore({
    appFolder: TEST_APP_FOLDER,
    useLinks: false,
  });
}

function createDetachedRecord(overrides = {}) {
  return new ExecutionRecord({
    uuid: 'control-test-uuid',
    command: 'sleep 100',
    pid: 12345,
    logPath: '/tmp/control-test.log',
    status: ExecutionStatus.EXECUTING,
    options: {
      isolated: 'screen',
      isolationMode: 'detached',
      sessionName: 'screen-session',
    },
    ...overrides,
  });
}

function createRunner(responses = {}) {
  const calls = [];
  const runner = (command, args) => {
    calls.push({ command, args });
    const key = `${command} ${args.join(' ')}`;
    const response = responses[key] || responses[command];
    if (typeof response === 'function') {
      return response(command, args);
    }
    return (
      response || {
        success: true,
        stdout: '',
        stderr: '',
        status: 0,
        error: null,
      }
    );
  };
  runner.calls = calls;
  return runner;
}

describe('execution control', () => {
  beforeEach(cleanupTestDir);
  afterEach(cleanupTestDir);

  it('should map screen stop to CTRL+C injection', () => {
    const record = createDetachedRecord();
    const command = getControlCommand(record, ControlAction.STOP);

    assert.strictEqual(command.command, 'screen');
    assert.deepStrictEqual(command.args, [
      '-S',
      'screen-session',
      '-X',
      'stuff',
      '\x03',
    ]);
    assert.strictEqual(command.method, 'CTRL_C');
  });

  it('should send stop command to a detached screen session', () => {
    const store = createStore();
    store.save(createDetachedRecord());
    const runner = createRunner({
      'screen -ls': {
        success: true,
        stdout: '\t111.screen-session\t(Detached)\n',
        stderr: '',
        status: 0,
        error: null,
      },
      'pgrep -P 111': {
        success: true,
        stdout: '222\n',
        stderr: '',
        status: 0,
        error: null,
      },
    });

    const result = controlExecution(
      store,
      'screen-session',
      ControlAction.STOP,
      runner
    );

    assert.strictEqual(result.success, true);
    assert.match(result.output, /executionControl/);
    assert.match(result.output, /action stop/);
    assert.match(result.output, /method CTRL_C/);
    assert.match(result.output, /screenPid 111/);
    assert.deepStrictEqual(runner.calls[0], {
      command: 'screen',
      args: ['-S', 'screen-session', '-X', 'stuff', '\x03'],
    });
  });

  it('should send docker terminate through docker kill', () => {
    const store = createStore();
    store.save(
      createDetachedRecord({
        uuid: 'docker-control-uuid',
        options: {
          isolated: 'docker',
          isolationMode: 'detached',
          sessionName: 'docker-session',
          containerId: 'abc123',
        },
      })
    );
    const runner = createRunner({
      'docker inspect -f {{.Id}} {{.State.Pid}} docker-session': {
        success: true,
        stdout: 'abcdef 444\n',
        stderr: '',
        status: 0,
        error: null,
      },
    });

    const result = controlExecution(
      store,
      'docker-control-uuid',
      ControlAction.TERMINATE,
      runner
    );

    assert.strictEqual(result.success, true);
    assert.match(result.output, /action terminate/);
    assert.match(result.output, /method SIGKILL/);
    assert.match(result.output, /containerPid 444/);
    assert.deepStrictEqual(runner.calls[0], {
      command: 'docker',
      args: ['kill', 'docker-session'],
    });
  });

  it('should reject non-detached records', () => {
    const store = createStore();
    store.save(
      createDetachedRecord({
        options: {
          isolated: 'screen',
          isolationMode: 'attached',
          sessionName: 'screen-session',
        },
      })
    );

    const result = controlExecution(
      store,
      'screen-session',
      ControlAction.STOP,
      createRunner()
    );

    assert.strictEqual(result.success, false);
    assert.match(result.error, /Only detached isolated executions/);
  });
});

describe('process id collection', () => {
  it('should parse a GNU Screen process id from screen -ls output', () => {
    const pid = parseScreenPid(
      'There is a screen on:\n\t1234.my-session\t(Detached)\n',
      'my-session'
    );

    assert.strictEqual(pid, 1234);
  });

  it('should collect wrapper, screen, and descendant process IDs', () => {
    const runner = createRunner({
      'screen -ls': {
        success: true,
        stdout: '\t111.screen-session\t(Detached)\n',
        stderr: '',
        status: 0,
        error: null,
      },
      'pgrep -P 111': {
        success: true,
        stdout: '222\n333\n',
        stderr: '',
        status: 0,
        error: null,
      },
      'pgrep -P 222': {
        success: true,
        stdout: '',
        stderr: '',
        status: 1,
        error: null,
      },
      'pgrep -P 333': {
        success: true,
        stdout: '',
        stderr: '',
        status: 1,
        error: null,
      },
    });

    const processIds = collectProcessIds(createDetachedRecord(), runner);

    assert.deepStrictEqual(processIds, {
      wrapperPid: 12345,
      screenPid: 111,
      commandPids: [222, 333],
    });
  });
});
