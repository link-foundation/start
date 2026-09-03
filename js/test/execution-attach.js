/**
 * Tests for --attach (issue #162)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  buildAttachPlan,
  attachExecution,
  formatAttachResultAsLinksNotation,
} = require('../src/lib/execution-attach');
const { SessionState } = require('../src/lib/session-probe');

function makeRecord(options = {}, extra = {}) {
  return {
    uuid: '11111111-2222-3333-4444-555555555555',
    status: 'executing',
    logPath: '/tmp/session.log',
    options: { isolationMode: 'detached', ...options },
    ...extra,
  };
}

const runningProbe = (backend, sessionName) => ({
  backend,
  sessionName,
  state: SessionState.RUNNING,
  alive: true,
  containerStatus: backend === 'docker' ? 'running' : null,
});

describe('buildAttachPlan', () => {
  test('attaches to a running docker container', () => {
    const record = makeRecord({ isolated: 'docker', sessionName: 'box' });
    const plan = buildAttachPlan(record, {
      probe: runningProbe('docker', 'box'),
    });
    assert.strictEqual(plan.error, undefined);
    assert.strictEqual(plan.command, 'docker');
    assert.deepStrictEqual(plan.args, ['attach', 'box']);
    assert.strictEqual(plan.interactive, true);
    assert.strictEqual(plan.method, 'DOCKER_ATTACH');
  });

  test('follows docker logs in read-only mode', () => {
    const record = makeRecord({ isolated: 'docker', sessionName: 'box' });
    const plan = buildAttachPlan(record, {
      readOnly: true,
      probe: runningProbe('docker', 'box'),
    });
    assert.deepStrictEqual(plan.args, ['logs', '-f', 'box']);
    assert.strictEqual(plan.interactive, false);
    assert.strictEqual(plan.method, 'DOCKER_LOG_FOLLOW');
  });

  test('attaches to a running screen session', () => {
    const record = makeRecord({ isolated: 'screen', sessionName: 'work' });
    const plan = buildAttachPlan(record, {
      probe: runningProbe('screen', 'work'),
    });
    assert.strictEqual(plan.command, 'screen');
    assert.deepStrictEqual(plan.args, ['-r', 'work']);
    assert.strictEqual(plan.interactive, true);
  });

  test('follows the stored log for a read-only screen attach', () => {
    const record = makeRecord({ isolated: 'screen', sessionName: 'work' });
    const plan = buildAttachPlan(record, {
      readOnly: true,
      probe: runningProbe('screen', 'work'),
    });
    assert.strictEqual(plan.command, 'tail');
    assert.deepStrictEqual(plan.args, ['-f', '/tmp/session.log']);
    assert.strictEqual(plan.method, 'LOG_FOLLOW');
  });

  test('uses tmux read-only attach for --read-only', () => {
    const record = makeRecord({ isolated: 'tmux', sessionName: 'work' });
    const plan = buildAttachPlan(record, {
      probe: runningProbe('tmux', 'work'),
    });
    assert.deepStrictEqual(plan.args, ['attach-session', '-t', 'work']);
    const readOnlyPlan = buildAttachPlan(record, {
      readOnly: true,
      probe: runningProbe('tmux', 'work'),
    });
    assert.deepStrictEqual(readOnlyPlan.args, [
      'attach-session',
      '-r',
      '-t',
      'work',
    ]);
    assert.strictEqual(readOnlyPlan.interactive, true);
  });

  test('follows the log for ssh sessions', () => {
    const record = makeRecord({ isolated: 'ssh', sessionName: 'remote' });
    const plan = buildAttachPlan(record, {
      probe: {
        backend: 'ssh',
        sessionName: 'remote',
        state: SessionState.UNKNOWN,
        alive: false,
      },
    });
    assert.strictEqual(plan.command, 'tail');
    assert.strictEqual(plan.method, 'LOG_FOLLOW');
  });

  test('points at --resume when the session is not running', () => {
    const record = makeRecord({ isolated: 'docker', sessionName: 'box' });
    const plan = buildAttachPlan(record, {
      probe: {
        backend: 'docker',
        sessionName: 'box',
        state: SessionState.STOPPED,
        alive: false,
        containerStatus: 'exited',
      },
    });
    assert.match(plan.error, /is not running/);
    assert.match(plan.error, /--resume/);
  });

  test('reports a removed container distinctly', () => {
    const record = makeRecord({ isolated: 'docker', sessionName: 'box' });
    const plan = buildAttachPlan(record, {
      probe: {
        backend: 'docker',
        sessionName: 'box',
        state: SessionState.MISSING,
        alive: false,
      },
    });
    assert.match(plan.error, /no longer exists/);
  });

  test('rejects records without a session name', () => {
    const plan = buildAttachPlan(makeRecord({ isolated: 'docker' }), {
      probe: { state: SessionState.UNKNOWN, alive: false },
    });
    assert.match(plan.error, /does not contain an isolation session name/);
  });

  test('rejects attached (non-detached) executions', () => {
    const record = makeRecord({
      isolated: 'docker',
      sessionName: 'box',
      isolationMode: 'attached',
    });
    const plan = buildAttachPlan(record, {
      probe: runningProbe('docker', 'box'),
    });
    assert.match(plan.error, /Only detached isolated executions/);
  });
});

describe('attachExecution', () => {
  function makeStore(record) {
    return { get: () => record };
  }

  test('reports a missing execution', () => {
    const result = attachExecution({ get: () => null }, 'nope', {});
    assert.strictEqual(result.success, false);
    assert.match(result.error, /No execution found/);
  });

  test('reports disabled tracking', () => {
    const result = attachExecution(null, 'nope', {});
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Execution tracking is disabled/);
  });

  test('runs the interactive attach command', () => {
    const record = makeRecord({ isolated: 'docker', sessionName: 'box' });
    const calls = [];
    const result = attachExecution(makeStore(record), 'box', {
      probe: () => runningProbe('docker', 'box'),
      interactiveRunner: (command, args) => {
        calls.push([command, ...args]);
        return { success: true, status: 0 };
      },
    });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls, [['docker', 'attach', 'box']]);
    assert.match(result.output, /attach/);
  });

  test('surfaces plan errors', () => {
    const record = makeRecord({ isolated: 'docker', sessionName: 'box' });
    const result = attachExecution(makeStore(record), 'box', {
      probe: () => ({
        backend: 'docker',
        sessionName: 'box',
        state: SessionState.STOPPED,
        alive: false,
      }),
    });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /--resume/);
  });
});

describe('formatAttachResultAsLinksNotation', () => {
  test('emits a nested links-notation block', () => {
    const output = formatAttachResultAsLinksNotation({
      identifier: 'box',
      uuid: 'u-1',
      backend: 'docker',
      sessionName: 'box',
      method: 'DOCKER_ATTACH',
      readOnly: false,
      command: 'docker attach box',
      message: 'Attaching to detached docker container: box',
    });
    assert.match(output, /^executionAttach\n/);
    assert.match(output, /\n {2}method DOCKER_ATTACH\n/);
    assert.match(output, /\n {2}readOnly false\n/);
  });
});
