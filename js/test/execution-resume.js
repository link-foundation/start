/**
 * Tests for --resume and --resume-all (issue #162)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  ResumeMode,
  buildResumePlan,
  buildSnapshotImageName,
  buildResumedSessionName,
  resumeExecution,
  resumeAllExecutions,
  formatResumeResultAsLinksNotation,
} = require('../src/lib/execution-resume');
const { SessionState } = require('../src/lib/session-probe');

function makeRecord(options = {}, extra = {}) {
  return {
    uuid: '11111111-2222-3333-4444-555555555555',
    status: 'executing',
    command: 'npm test',
    logPath: '/tmp/session.log',
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: 'box',
      image: 'ubuntu:24.04',
      ...options,
    },
    ...extra,
  };
}

function probeWith(state, containerStatus = null) {
  return {
    backend: 'docker',
    sessionName: 'box',
    state,
    alive: state === SessionState.RUNNING,
    containerStatus,
  };
}

describe('buildSnapshotImageName', () => {
  test('produces a lowercase docker-safe tag', () => {
    assert.strictEqual(
      buildSnapshotImageName('My_Session Name', 2),
      'start-command-resume/my_session-name:2'
    );
  });
});

describe('buildResumedSessionName', () => {
  test('appends the resume counter', () => {
    assert.strictEqual(buildResumedSessionName('box', 3), 'box-resume-3');
  });
});

describe('buildResumePlan', () => {
  test('refuses to resume a live session and points at --attach', () => {
    const plan = buildResumePlan(
      makeRecord(),
      null,
      probeWith(SessionState.RUNNING, 'running')
    );
    assert.match(plan.error, /still running/);
    assert.match(plan.error, /--attach/);
  });

  test('restarts a stopped container with the stored command', () => {
    const plan = buildResumePlan(
      makeRecord(),
      null,
      probeWith(SessionState.STOPPED, 'exited')
    );
    assert.strictEqual(plan.mode, ResumeMode.DOCKER_START);
    assert.strictEqual(plan.sessionName, 'box');
    assert.deepStrictEqual(plan.steps[0].args, ['start', 'box']);
    assert.strictEqual(plan.command, 'npm test');
  });

  test('snapshots a stopped container to run a new command', () => {
    const plan = buildResumePlan(
      makeRecord(),
      'npm run build',
      probeWith(SessionState.STOPPED, 'exited')
    );
    assert.strictEqual(plan.mode, ResumeMode.DOCKER_SNAPSHOT);
    assert.strictEqual(plan.snapshotImage, 'start-command-resume/box:1');
    assert.strictEqual(plan.newSessionName, 'box-resume-1');
    assert.deepStrictEqual(plan.steps[0].args, [
      'commit',
      'box',
      'start-command-resume/box:1',
    ]);
    const runArgs = plan.steps[1].args;
    assert.deepStrictEqual(runArgs.slice(0, 4), [
      'run',
      '-d',
      '--name',
      'box-resume-1',
    ]);
    assert.deepStrictEqual(runArgs.slice(-4), [
      'start-command-resume/box:1',
      'sh',
      '-c',
      'npm run build',
    ]);
  });

  test('carries stored docker runtime options into the snapshot run', () => {
    const record = makeRecord({
      privileged: true,
      env: ['A=1'],
      volumes: ['/host:/container'],
      networks: ['testnet'],
    });
    const plan = buildResumePlan(
      record,
      'echo hi',
      probeWith(SessionState.STOPPED, 'exited')
    );
    const runArgs = plan.steps[1].args;
    assert.ok(runArgs.includes('--privileged'));
    assert.ok(runArgs.includes('/host:/container'));
    assert.ok(runArgs.includes('A=1'));
    assert.ok(runArgs.includes('testnet'));
  });

  test('rebuilds a multi-network snapshot with create/connect/start', () => {
    // `docker run` joins one network only, so extra networks must be connected
    // between create and start, exactly as the original launch does.
    const record = makeRecord({
      networks: ['frontend', 'backend', 'metrics'],
    });
    const plan = buildResumePlan(
      record,
      'echo hi',
      probeWith(SessionState.STOPPED, 'exited')
    );
    const steps = plan.steps.map((step) => step.args);
    assert.strictEqual(steps.length, 5);
    assert.strictEqual(steps[0][0], 'commit');
    assert.deepStrictEqual(steps[1].slice(0, 3), [
      'create',
      '--name',
      'box-resume-1',
    ]);
    assert.ok(
      steps[1].includes('frontend'),
      'the first network still goes to --network'
    );
    assert.deepStrictEqual(steps[2], [
      'network',
      'connect',
      'backend',
      'box-resume-1',
    ]);
    assert.deepStrictEqual(steps[3], [
      'network',
      'connect',
      'metrics',
      'box-resume-1',
    ]);
    assert.deepStrictEqual(steps[4], ['start', 'box-resume-1']);
  });

  test('increments the counter across repeated resumes', () => {
    const record = makeRecord({ resumeCount: 2 });
    const plan = buildResumePlan(
      record,
      'echo hi',
      probeWith(SessionState.STOPPED, 'exited')
    );
    assert.strictEqual(plan.snapshotImage, 'start-command-resume/box:3');
    assert.strictEqual(plan.newSessionName, 'box-resume-3');
  });

  test('relaunches when the container is gone', () => {
    const plan = buildResumePlan(
      makeRecord(),
      null,
      probeWith(SessionState.MISSING)
    );
    assert.strictEqual(plan.mode, ResumeMode.RELAUNCH);
    assert.strictEqual(plan.sessionName, 'box');
    assert.strictEqual(plan.command, 'npm test');
    assert.strictEqual(plan.launchOptions.image, 'ubuntu:24.04');
    assert.strictEqual(plan.launchOptions.detached, true);
    assert.strictEqual(plan.launchOptions.logPath, '/tmp/session.log');
  });

  test('relaunches a dead screen session', () => {
    const record = makeRecord({ isolated: 'screen', sessionName: 'work' });
    const plan = buildResumePlan(record, null, {
      backend: 'screen',
      sessionName: 'work',
      state: SessionState.MISSING,
      alive: false,
    });
    assert.strictEqual(plan.mode, ResumeMode.RELAUNCH);
    assert.strictEqual(plan.backend, 'screen');
  });

  test('relaunches a dead screen session with a new command', () => {
    const record = makeRecord({ isolated: 'screen', sessionName: 'work' });
    const plan = buildResumePlan(record, 'echo hi', {
      backend: 'screen',
      sessionName: 'work',
      state: SessionState.MISSING,
      alive: false,
    });
    assert.strictEqual(plan.command, 'echo hi');
  });

  test('rejects records without a session name', () => {
    const record = makeRecord({ sessionName: null });
    const plan = buildResumePlan(record, null, probeWith(SessionState.MISSING));
    assert.match(plan.error, /does not contain an isolation session name/);
  });

  test('rejects non-detached executions', () => {
    const record = makeRecord({ isolationMode: 'attached' });
    const plan = buildResumePlan(record, null, probeWith(SessionState.STOPPED));
    assert.match(plan.error, /Only detached isolated executions/);
  });

  test('rejects records with no command to resume', () => {
    const record = makeRecord({}, { command: '' });
    const plan = buildResumePlan(record, null, probeWith(SessionState.MISSING));
    assert.match(plan.error, /no stored command/);
  });
});

describe('resumeExecution', () => {
  function makeStore(record) {
    const saved = [];
    return {
      saved,
      get: () => record,
      save: (r) => saved.push(r),
    };
  }

  test('reports disabled tracking', async () => {
    const result = await resumeExecution(null, 'box', {});
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Execution tracking is disabled/);
  });

  test('reports an unknown identifier', async () => {
    const result = await resumeExecution({ get: () => null }, 'nope', {});
    assert.strictEqual(result.success, false);
    assert.match(result.error, /No execution found/);
  });

  test('starts a stopped container and re-attaches the watcher', async () => {
    const record = makeRecord();
    const store = makeStore(record);
    const calls = [];
    const watchers = [];
    const result = await resumeExecution(store, 'box', {
      probe: () => probeWith(SessionState.STOPPED, 'exited'),
      runner: (command, args) => {
        calls.push([command, ...args]);
        return { success: true, stdout: 'abc123\n', stderr: '', status: 0 };
      },
      startWatcher: (name, policy, logPath) =>
        watchers.push([name, policy, logPath]),
    });
    assert.strictEqual(result.success, true, result.error);
    assert.deepStrictEqual(calls, [['docker', 'start', 'box']]);
    assert.strictEqual(watchers.length, 1);
    assert.strictEqual(watchers[0][0], 'box');
    assert.strictEqual(watchers[0][2], '/tmp/session.log');
    assert.strictEqual(store.saved.length, 1);
    assert.strictEqual(store.saved[0].uuid, record.uuid);
    assert.strictEqual(store.saved[0].status, 'executing');
    assert.strictEqual(store.saved[0].options.resumeCount, 1);
  });

  test('keeps the same UUID and remembers the previous session name', async () => {
    const record = makeRecord();
    const store = makeStore(record);
    const result = await resumeExecution(store, 'box', {
      command: 'npm run build',
      probe: () => probeWith(SessionState.STOPPED, 'exited'),
      runner: () => ({
        success: true,
        stdout: 'deadbeef\n',
        stderr: '',
        status: 0,
      }),
      startWatcher: () => {},
    });
    assert.strictEqual(result.success, true, result.error);
    const saved = store.saved[0];
    assert.strictEqual(saved.uuid, record.uuid);
    assert.strictEqual(saved.command, 'npm run build');
    assert.strictEqual(saved.options.sessionName, 'box-resume-1');
    assert.deepStrictEqual(saved.options.sessionNameHistory, ['box']);
    assert.strictEqual(saved.options.containerId, 'deadbeef');
    assert.strictEqual(saved.exitCode, null);
    assert.strictEqual(saved.endTime, null);
  });

  test('fails when a docker step fails', async () => {
    const record = makeRecord();
    const store = makeStore(record);
    const result = await resumeExecution(store, 'box', {
      probe: () => probeWith(SessionState.STOPPED, 'exited'),
      runner: () => ({
        success: false,
        stdout: '',
        stderr: 'no such container',
        status: 1,
      }),
      startWatcher: () => {},
    });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /no such container/);
    assert.strictEqual(store.saved.length, 0);
  });

  test('relaunches through the isolation backend when the container is gone', async () => {
    const record = makeRecord();
    const store = makeStore(record);
    const launches = [];
    const result = await resumeExecution(store, 'box', {
      probe: () => probeWith(SessionState.MISSING),
      runIsolated: (backend, command, options) => {
        launches.push({ backend, command, options });
        return Promise.resolve({ success: true, containerId: 'newid' });
      },
    });
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(launches.length, 1);
    assert.strictEqual(launches[0].backend, 'docker');
    assert.strictEqual(launches[0].command, 'npm test');
    assert.strictEqual(launches[0].options.session, 'box');
    assert.strictEqual(store.saved[0].uuid, record.uuid);
  });

  test('surfaces relaunch failures', async () => {
    const record = makeRecord();
    const store = makeStore(record);
    const result = await resumeExecution(store, 'box', {
      probe: () => probeWith(SessionState.MISSING),
      runIsolated: () =>
        Promise.resolve({ success: false, message: 'docker is not running' }),
    });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /docker is not running/);
  });
});

describe('resumeAllExecutions', () => {
  test('reports disabled tracking', async () => {
    const result = await resumeAllExecutions(null, {});
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Execution tracking is disabled/);
  });

  test('reports an empty set', async () => {
    const result = await resumeAllExecutions({ getExecuting: () => [] }, {});
    assert.strictEqual(result.success, true);
    assert.match(result.output, /count 0/);
  });

  test('re-attaches watchers for live docker sessions', async () => {
    const record = makeRecord();
    const watchers = [];
    const result = await resumeAllExecutions(
      { getExecuting: () => [record], save: () => {} },
      {
        probe: () => probeWith(SessionState.RUNNING, 'running'),
        startWatcher: (name) => watchers.push(name),
      }
    );
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(watchers, ['box']);
    assert.match(result.output, /reattached/);
  });

  test('reconciles executions whose session is gone', async () => {
    const record = makeRecord();
    const saved = [];
    const result = await resumeAllExecutions(
      { getExecuting: () => [record], save: (r) => saved.push(r) },
      {
        probe: () => probeWith(SessionState.MISSING),
        reconcile: (r) => ({ ...r, status: 'executed', exitCode: 139 }),
      }
    );
    assert.strictEqual(result.success, true);
    assert.match(result.output, /reconciled/);
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].status, 'executed');
  });

  test('leaves live screen sessions untouched', async () => {
    const record = makeRecord({ isolated: 'screen', sessionName: 'work' });
    const result = await resumeAllExecutions(
      { getExecuting: () => [record], save: () => {} },
      {
        probe: () => ({
          backend: 'screen',
          sessionName: 'work',
          state: SessionState.RUNNING,
          alive: true,
        }),
      }
    );
    assert.match(result.output, /running/);
  });
});

describe('formatResumeResultAsLinksNotation', () => {
  test('emits a nested links-notation block', () => {
    const output = formatResumeResultAsLinksNotation({
      identifier: 'box',
      uuid: 'u-1',
      backend: 'docker',
      mode: ResumeMode.DOCKER_START,
      sessionName: 'box',
      command: 'npm test',
      message: 'Resumed detached docker container: box',
    });
    assert.match(output, /^executionResume\n/);
    assert.match(output, /\n {2}mode docker-start\n/);
  });
});
