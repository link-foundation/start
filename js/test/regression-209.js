const { it, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const evidence = require('../src/lib/exit-evidence');
const {
  resolveExitReason,
  resolveMemoryExhaustion,
} = require('../src/lib/exit-reason');
const { enrichDetachedStatus } = require('../src/lib/status-formatter');
const { archiveAttempt } = require('../src/lib/execution-attempt');
const { ExecutionRecord } = require('../src/lib/execution-store');

const finishedAt = '1970-01-01T00:01:40.592Z';
const id = 'a'.repeat(64);
const facts = {
  containerName: 'task',
  sample: '3135369216 3135373312 1 1 62 62',
  finishedAt,
  exitCode: 137,
  oomKilled: true,
};
function collect(events, overrides = {}, journal = '') {
  const calls = [];
  const line = evidence.collectExitEvidence(
    { ...facts, ...overrides },
    (cmd, args) => {
      calls.push([cmd, args]);
      if (args[0] === 'inspect') {
        return { success: true, stdout: id };
      }
      if (args[0] === 'events') {
        return { success: true, stdout: events };
      }
      return { success: Boolean(journal), stdout: journal };
    }
  );
  return { line, calls };
}

it('attributes the final Docker OOM event despite a 38-second-old child sample', () => {
  const { line, calls } = collect('62\n99\n');
  expect(line).toBe('Exit evidence: main-oom (recent Docker oom event)');
  const args = calls.find(([, args]) => args[0] === 'events')[1];
  expect(args).toContain(`container=${id}`);
  expect(args).toContain('event=oom');
  expect(args).toContain('1970-01-01T00:00:40.592Z');
  expect(args).toContain('1970-01-01T00:01:41.592Z');
  const input = { exitCode: 137, oomKilled: true, logTail: line };
  expect(resolveExitReason(input)).toBe(
    'memory-exhaustion (cgroup-oom-killer)'
  );
  expect(resolveMemoryExhaustion(input).memoryExhausted).toBe(true);
  expect(
    resolveMemoryExhaustion({ ...input, oomKilled: false }).memoryExhausted
  ).toBe(true);
});

it('uses daemon events over remote Docker connections without a host journal', () => {
  const previous = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = 'tcp://remote:2376';
  try {
    const { line, calls } = collect('100');
    expect(evidence.fromLog(line).mainOom).toBe(true);
    expect(calls.some(([cmd]) => cmd === 'journalctl')).toBe(false);
  } finally {
    if (previous === undefined) {
      delete process.env.DOCKER_HOST;
    } else {
      process.env.DOCKER_HOST = previous;
    }
  }
});

it('rejects old, future and malformed events and ordinary exits', () => {
  for (const events of ['62', '96', '102', 'nope', '', '0', 'Infinity']) {
    expect(evidence.fromLog(collect(events).line).mainOom).toBe(false);
  }
  for (const exitCode of [0, 1, 139, -1]) {
    const { line, calls } = collect('99', { exitCode });
    expect(evidence.fromLog(line).mainOom).toBe(false);
    expect(calls.some(([, args]) => args[0] === 'events')).toBe(false);
  }
});

it('keeps daemon restart evidence ahead of even a recent OOM event', () => {
  const journal = `Main process exited\nContainer failed to exit - using the force container=${id}`;
  const { line } = collect('99', {}, journal);
  expect(line).toBe(evidence.DAEMON_RESTART);
  expect(
    resolveMemoryExhaustion({ exitCode: 137, oomKilled: true, logTail: line })
  ).toBeNull();
});

it('archives attributed evidence before a resume clears current options', () => {
  const record = new ExecutionRecord({
    command: 'work',
    status: 'executed',
    options: {
      exitEvidence: { mainOom: true, daemonRestart: false },
    },
  });
  archiveAttempt(record);
  expect(record.attemptHistory[0].exitEvidence).toEqual(
    record.options.exitEvidence
  );
});

it('recomputes history independently while the current attempt is executing', () => {
  const record = new ExecutionRecord({
    command: 'work',
    status: 'executing',
    options: {},
  });
  record.attemptHistory = [
    {
      status: 'executed',
      exitCode: 137,
      oomKilled: true,
      exitReason: 'signal (SIGKILL; cause unknown)',
      exitEvidence: { mainOom: true, daemonRestart: false },
    },
    {
      status: 'executed',
      exitCode: 1,
      oomKilled: true,
      exitReason: 'memory-exhaustion (cgroup-oom-killer)',
      memoryExhausted: true,
      memoryExhaustedReason: 'Docker reported State.OOMKilled=true',
    },
  ];
  const result = enrichDetachedStatus(record);
  expect(result.attemptHistory[0].exitReason).toBe(
    'memory-exhaustion (cgroup-oom-killer)'
  );
  expect(result.attemptHistory[0].memoryExhausted).toBe(true);
  expect(result.attemptHistory[1].exitReason).toBeUndefined();
  expect(result.attemptHistory[1].memoryExhausted).toBeUndefined();
  expect(record.attemptHistory[0].exitReason).toBe(
    'signal (SIGKILL; cause unknown)'
  );
});

it('reads only each archived attempt log range and never leaks current fatal output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-209-'));
  try {
    const first = 'Exit evidence: main-oom (recent Docker oom event)\n';
    const second = 'ordinary exit\n';
    const logPath = path.join(dir, 'run.log');
    fs.writeFileSync(
      logPath,
      `${first + second}FATAL ERROR: JavaScript heap out of memory\n`
    );
    const record = new ExecutionRecord({
      command: 'work',
      status: 'executed',
      logPath,
      options: {},
    });
    record.exitCode = 1;
    record.attempt = {
      number: 3,
      logOffset: Buffer.byteLength(first + second),
    };
    record.attemptHistory = [
      {
        status: 'executed',
        number: 1,
        logOffset: 0,
        exitCode: 137,
        oomKilled: true,
      },
      {
        status: 'executed',
        number: 2,
        logOffset: Buffer.byteLength(first),
        exitCode: 1,
        oomKilled: true,
      },
    ];
    const result = enrichDetachedStatus(record);
    expect(result.attemptHistory[0].exitReason).toBe(
      'memory-exhaustion (cgroup-oom-killer)'
    );
    expect(result.attemptHistory[1].memoryExhausted).toBeUndefined();
    expect(result.exitReason).toBe('memory-exhaustion (v8-heap-limit)');
    record.attemptHistory[1].logOffset = null;
    expect(enrichDetachedStatus(record).attemptHistory[0].exitReason).toBe(
      'signal (SIGKILL; cause unknown)'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('finalizes and preserves Docker event attribution after the log is removed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-209-finalize-'));
  try {
    const { ExecutionStore } = require('../src/lib/execution-store');
    const {
      finalizeDetachedExecution,
    } = require('../src/lib/detached-finalize');
    const store = new ExecutionStore({ appFolder: dir, useLinks: false });
    const logPath = path.join(dir, 'run.log');
    fs.writeFileSync(logPath, `${evidence.DOCKER_OOM}\n`);
    const record = new ExecutionRecord({
      command: 'work',
      logPath,
      options: {},
    });
    store.save(record);
    finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      ...facts,
      running: false,
    });
    const current = store.get(record.uuid);
    expect(current.options.exitEvidence.mainOom).toBe(true);
    expect(current.exitReason).toBe('memory-exhaustion (cgroup-oom-killer)');
    const message =
      require('../src/lib/docker-cleanup').buildAttachedDockerKeptMessage({
        containerName: 'task',
        exitCode: 137,
        oomKilled: true,
        logPath,
      });
    expect(message).toContain('reports it was OOM-killed');
    fs.unlinkSync(logPath);
    expect(enrichDetachedStatus(current).memoryExhausted).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
