/**
 * Tests for session liveness probing (issue #162)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  SessionState,
  mapDockerStatusToState,
  parseScreenSessionState,
  probeSession,
} = require('../src/lib/session-probe');

function makeRecord(options) {
  return { uuid: 'u-1', options: { isolationMode: 'detached', ...options } };
}

function makeRunner(responses) {
  return (command, args) => {
    const key = [command, ...args].join(' ');
    const response = responses[key];
    if (!response) {
      return { success: false, stdout: '', stderr: '', status: 1, error: null };
    }
    return {
      success: true,
      stdout: '',
      stderr: '',
      status: 0,
      error: null,
      ...response,
    };
  };
}

describe('parseScreenSessionState', () => {
  const listing = [
    'There are screens on:',
    '\t12345.other-session\t(Detached)',
    '\t67890.my-session\t(Detached)',
  ].join('\n');

  test('finds a detached session', () => {
    assert.strictEqual(
      parseScreenSessionState(listing, 'my-session'),
      SessionState.RUNNING
    );
  });

  test('reports missing sessions', () => {
    assert.strictEqual(
      parseScreenSessionState(listing, 'gone'),
      SessionState.MISSING
    );
  });

  test('does not match a partial session name', () => {
    assert.strictEqual(
      parseScreenSessionState(listing, 'session'),
      SessionState.MISSING
    );
  });
});

describe('mapDockerStatusToState', () => {
  test('maps running to RUNNING', () => {
    assert.strictEqual(mapDockerStatusToState('running'), SessionState.RUNNING);
  });

  test('maps exited and created to STOPPED', () => {
    assert.strictEqual(mapDockerStatusToState('exited'), SessionState.STOPPED);
    assert.strictEqual(mapDockerStatusToState('created'), SessionState.STOPPED);
    assert.strictEqual(mapDockerStatusToState('dead'), SessionState.STOPPED);
  });

  test('maps an unknown or empty status to UNKNOWN', () => {
    assert.strictEqual(mapDockerStatusToState(''), SessionState.UNKNOWN);
    assert.strictEqual(mapDockerStatusToState(null), SessionState.UNKNOWN);
  });
});

describe('probeSession', () => {
  test('detects a running docker container', () => {
    const record = makeRecord({ isolated: 'docker', sessionName: 'box' });
    const runner = makeRunner({
      'docker inspect -f {{.State.Status}} box': { stdout: 'running\n' },
    });
    const probe = probeSession(record, runner);
    assert.strictEqual(probe.state, SessionState.RUNNING);
    assert.strictEqual(probe.alive, true);
    assert.strictEqual(probe.containerStatus, 'running');
  });

  test('detects a stopped docker container', () => {
    const record = makeRecord({ isolated: 'docker', sessionName: 'box' });
    const runner = makeRunner({
      'docker inspect -f {{.State.Status}} box': { stdout: 'exited\n' },
    });
    const probe = probeSession(record, runner);
    assert.strictEqual(probe.state, SessionState.STOPPED);
    assert.strictEqual(probe.alive, false);
  });

  test('detects a removed docker container', () => {
    const record = makeRecord({ isolated: 'docker', sessionName: 'box' });
    const probe = probeSession(record, makeRunner({}));
    assert.strictEqual(probe.state, SessionState.MISSING);
    assert.strictEqual(probe.alive, false);
  });

  test('detects a live tmux session', () => {
    const record = makeRecord({ isolated: 'tmux', sessionName: 'work' });
    const runner = makeRunner({ 'tmux has-session -t work': {} });
    assert.strictEqual(
      probeSession(record, runner).state,
      SessionState.RUNNING
    );
  });

  test('detects a dead tmux session', () => {
    const record = makeRecord({ isolated: 'tmux', sessionName: 'work' });
    assert.strictEqual(
      probeSession(record, makeRunner({})).state,
      SessionState.MISSING
    );
  });

  test('detects a live screen session', () => {
    const record = makeRecord({ isolated: 'screen', sessionName: 'work' });
    const runner = makeRunner({
      'screen -ls': { stdout: '\t4242.work\t(Detached)\n', success: false },
    });
    assert.strictEqual(
      probeSession(record, runner).state,
      SessionState.RUNNING
    );
  });

  test('reports ssh sessions as unknown', () => {
    const record = makeRecord({ isolated: 'ssh', sessionName: 'remote' });
    const probe = probeSession(record, makeRunner({}));
    assert.strictEqual(probe.state, SessionState.UNKNOWN);
    assert.strictEqual(probe.alive, false);
  });

  test('reports records without a session name as unknown', () => {
    const probe = probeSession({ uuid: 'u', options: {} }, makeRunner({}));
    assert.strictEqual(probe.state, SessionState.UNKNOWN);
  });
});
