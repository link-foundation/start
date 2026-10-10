const { it, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ExecutionStore,
  ExecutionRecord,
} = require('../src/lib/execution-store');
const { resumeExecution } = require('../src/lib/execution-resume');
const { recoverKilledExecution } = require('../src/lib/execution-recovery');
const { SessionState } = require('../src/lib/session-probe');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-191-'));
  const store = new ExecutionStore({ appFolder: dir, useLinks: false });
  const record = new ExecutionRecord({
    command: 'work',
    status: 'executed',
    logPath: path.join(dir, 'run.log'),
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: 'task',
      image: 'alpine',
      onKillResume: 3,
      onKillResumeMemory: '70%-80%',
    },
  });
  store.save(record);
  const calls = [];
  const runner = (_, args) => {
    calls.push(args);
    if (args[0] === 'info') {
      return {
        success: true,
        stdout: JSON.stringify({
          MemTotal: 1073741824,
          NCPU: 4,
          DockerRootDir: os.tmpdir(),
        }),
      };
    }
    if (args.includes('--size')) {
      return { success: true, stdout: '1024' };
    }
    if (args[0] === 'inspect') {
      return {
        success: true,
        stdout: JSON.stringify({
          Memory: 67108864,
          MemorySwap: 67108864,
          NanoCpus: 3000000000,
        }),
      };
    }
    return { success: true, stdout: 'id' };
  };
  return { dir, store, record, runner, calls };
}
it('manual in-place memory override updates before start and records the resolution', async () => {
  const f = fixture();
  try {
    const result = await resumeExecution(f.store, f.record.uuid, {
      resourceOptions: { memory: '128m' },
      runner: f.runner,
      probe: () => ({ alive: false, state: SessionState.STOPPED }),
      startWatcher: () => true,
    });
    expect(result.success).toBe(true);
    const update = f.calls.find((a) => a[0] === 'update');
    expect(update).toContain('--memory=134217728');
    expect(update).toContain('--memory-swap=134217728');
    expect(f.calls.indexOf(update)).toBeLessThan(
      f.calls.findIndex((a) => a[0] === 'start')
    );
    expect(f.store.get(f.record.uuid).options.resolvedLimits.memory).toBe(
      134217728
    );
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
it('manual snapshot override applies limits to the new container at creation', async () => {
  const f = fixture();
  try {
    const result = await resumeExecution(f.store, f.record.uuid, {
      command: 'new',
      snapshotOptions: { freeBytes: () => 100 * 1024 ** 3 },
      resourceOptions: { memory: '128m' },
      runner: f.runner,
      probe: () => ({ alive: false, state: SessionState.STOPPED }),
      startWatcher: () => true,
    });
    expect(result.success).toBe(true);
    expect(f.calls.find((a) => a[0] === 'run')).toContain('--memory=134217728');
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
for (const [exitCode, oomKilled, sample, change] of [
  [137, true, '67108864 66000000 1 1 100 100', true],
  [137, true, '67108864 66000000 1 1 0 100', false],
  [137, false, '67108864 66000000 0 0 0 100', false],
  [1, true, '67108864 66000000 1 1 100 100', false],
]) {
  it(`automatic memory change requires a qualifying OOM (exit=${exitCode}, fresh=${change})`, () => {
    const f = fixture();
    try {
      const result = recoverKilledExecution({
        store: f.store,
        executionId: f.record.uuid,
        exitCode,
        oomKilled,
        cgroupMemory: sample,
        finishedAt: '1970-01-01T00:01:40Z',
        runner: f.runner,
        random: () => 0.5,
        startWatcher: () => true,
      });
      const update = f.calls.find((a) => a[0] === 'update');
      expect(Boolean(update)).toBe(change);
      if (change) {
        expect(result.recovered).toBe(true);
        expect(update).toContain('--memory=805306368');
        expect(f.calls.indexOf(update)).toBeLessThan(
          f.calls.findIndex((a) => a[0] === 'start')
        );
        expect(f.store.get(f.record.uuid).options.resolvedLimits.memory).toBe(
          805306368
        );
      }
      if (exitCode === 1) {
        expect(result.recovered).toBe(false);
      }
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });
}

it('a failed memory update prevents starting the old-limit command', async () => {
  const f = fixture();
  try {
    const result = await resumeExecution(f.store, f.record.uuid, {
      resourceOptions: { memory: '128m' },
      runner: (cmd, args) =>
        args[0] === 'update'
          ? (f.calls.push(args),
            { success: false, stderr: 'daemon rejected update' })
          : f.runner(cmd, args),
      probe: () => ({ alive: false, state: SessionState.STOPPED }),
      startWatcher: () => true,
    });
    expect(result.success).toBe(false);
    expect(f.calls.some((args) => args[0] === 'start')).toBe(false);
    expect(f.store.get(f.record.uuid).status).toBe('executed');
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
