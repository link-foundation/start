const { it, expect } = require('bun:test');
const {
  resolveExitReason,
  resolveMemoryExhaustion,
} = require('../src/lib/exit-reason');
it('historical child OOM kills cannot explain a subsequent SIGKILL', () => {
  const facts = {
    exitCode: 137,
    oomKilled: true,
    cgroupMemory: { oomKills: 3 },
  };
  expect(resolveExitReason(facts)).toBe('signal (SIGKILL; cause unknown)');
  expect(resolveMemoryExhaustion(facts)).toBeNull();
});

const evidence = require('../src/lib/exit-evidence');
it('requires a recent sampled delta and rejects historical or malformed evidence', () => {
  const finished = '1970-01-01T00:01:40Z';
  expect(evidence.recentOomDelta('64 63 3 2 100 100', finished)).toBe(true);
  for (const sample of [
    '64 63 3 2',
    '64 63 3 2 0 100',
    '64 63 3 2 95 100',
    '64 63 3 2 101 100',
    '64 63 3 2 nope 100',
  ]) {
    expect(evidence.recentOomDelta(sample, finished)).toBe(false);
  }
  const line = evidence.collectExitEvidence(
    {
      containerName: 'task',
      sample: '64 63 3 2 100 100',
      finishedAt: finished,
      exitCode: 137,
      oomKilled: true,
    },
    () => ({ success: false, stdout: '' })
  );
  expect(line).toBe(evidence.MAIN_OOM);
  expect(
    resolveExitReason({ exitCode: 137, oomKilled: true, logTail: line })
  ).toBe('memory-exhaustion (cgroup-oom-killer)');
});
it('requires Docker service and matching-container force-kill evidence for a daemon restart', () => {
  const id = 'a'.repeat(64);
  const journal = `docker.service: Main process exited\nContainer failed to exit within 10s of signal 15 - using the force container=${id}`;
  expect(evidence.daemonRestartEvidence(journal, id)).toBe(true);
  expect(
    evidence.daemonRestartEvidence(
      'many containers exited at the same second',
      id
    )
  ).toBe(false);
  expect(evidence.daemonRestartEvidence(journal, 'b'.repeat(64))).toBe(false);
  for (const oomKilled of [true, false]) {
    const line = evidence.collectExitEvidence(
      {
        containerName: 'task',
        sample: '64 63 3 2 100 100',
        finishedAt: '1970-01-01T00:01:40Z',
        exitCode: 137,
        oomKilled,
      },
      (command) => ({
        success: true,
        stdout: command === 'journalctl' ? journal : id,
      })
    );
    expect(line).toBe(evidence.DAEMON_RESTART);
    expect(resolveExitReason({ exitCode: 137, oomKilled, logTail: line })).toBe(
      'killed (docker daemon restart)'
    );
    expect(
      resolveMemoryExhaustion({ exitCode: 137, oomKilled, logTail: line })
    ).toBeNull();
  }
});
it('persists terminal evidence without requiring a surviving log file', () => {
  const fs = require('fs'),
    path = require('path'),
    os = require('os');
  const {
    ExecutionStore,
    ExecutionRecord,
  } = require('../src/lib/execution-store');
  const { finalizeDetachedExecution } = require('../src/lib/detached-finalize');
  const { enrichDetachedStatus } = require('../src/lib/status-formatter');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-194-'));
  try {
    const store = new ExecutionStore({ appFolder: dir, useLinks: false });
    const record = new ExecutionRecord({
      command: 'work',
      options: { isolated: 'docker', isolationMode: 'detached' },
    });
    store.save(record);
    finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      exitCode: 137,
      oomKilled: true,
      finishedAt: '1970-01-01T00:01:40Z',
      running: false,
      cgroupMemory: '64 63 3 2 100 100',
    });
    const current = store.get(record.uuid);
    expect(current.options.exitEvidence.mainOom).toBe(true);
    expect(enrichDetachedStatus(current).exitReason).toBe(
      'memory-exhaustion (cgroup-oom-killer)'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps logged main-process evidence when no cgroup sample reaches the finalizer', () => {
  const fs = require('fs'),
    path = require('path'),
    os = require('os');
  const {
    ExecutionStore,
    ExecutionRecord,
  } = require('../src/lib/execution-store');
  const { finalizeDetachedExecution } = require('../src/lib/detached-finalize');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logged-evidence-194-'));
  try {
    const store = new ExecutionStore({ appFolder: dir, useLinks: false });
    const record = new ExecutionRecord({
      command: 'work',
      options: { isolated: 'docker', isolationMode: 'detached' },
    });
    record.logPath = path.join(dir, 'task.log');
    fs.writeFileSync(record.logPath, `${evidence.MAIN_OOM}\n`);
    store.save(record);
    finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      exitCode: 137,
      oomKilled: true,
      finishedAt: '1970-01-01T00:01:40Z',
      running: false,
    });
    expect(store.get(record.uuid).options.exitEvidence.mainOom).toBe(true);
    fs.unlinkSync(record.logPath);
    expect(
      require('../src/lib/status-formatter').enrichDetachedStatus(
        store.get(record.uuid)
      ).exitReason
    ).toBe('memory-exhaustion (cgroup-oom-killer)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('attached reporting uses attributed evidence and keeps ordinary exits final', () => {
  const fs = require('fs'),
    path = require('path'),
    os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attached-evidence-194-'));
  try {
    const logPath = path.join(dir, 'task.log');
    fs.writeFileSync(logPath, `${evidence.MAIN_OOM}\n`);
    const message =
      require('../src/lib/docker-cleanup').buildAttachedDockerKeptMessage({
        containerName: 'task',
        exitCode: 137,
        oomKilled: true,
        logPath,
      });
    expect(message).toContain('reports it was OOM-killed');
    for (const exitCode of [0, 1]) {
      expect(
        resolveMemoryExhaustion({
          exitCode,
          oomKilled: true,
          logTail: evidence.MAIN_OOM,
        })
      ).toBeNull();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
