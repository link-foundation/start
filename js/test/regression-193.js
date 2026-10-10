const { describe, it, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LockManager, ExecutionRecord } = require('../src/lib/execution-store');
const { resumeExecution } = require('../src/lib/execution-resume');
const { SessionState } = require('../src/lib/session-probe');

describe('issue #193: durable store locks and resume', () => {
  for (const content of [
    '',
    '{"pid":',
    JSON.stringify({
      pid: String(process.pid),
      timestamp: Date.now(),
      hostname: os.hostname(),
    }),
  ]) {
    it(`reclaims an old malformed lock (${JSON.stringify(content)})`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-193-'));
      const file = path.join(dir, 'executions.lock');
      try {
        fs.writeFileSync(file, content);
        const old = new Date(Date.now() - 10000);
        fs.utimesSync(file, old, old);
        const lock = new LockManager(file);
        expect(lock.acquire(300)).toBe(true);
        lock.release();
        expect(fs.existsSync(file)).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('does not replace a fresh incomplete lock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-193-'));
    const file = path.join(dir, 'executions.lock');
    try {
      fs.writeFileSync(file, '');
      expect(new LockManager(file).acquire(100)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reserves the replacement session before Docker side effects', async () => {
    const record = new ExecutionRecord({
      command: 'old',
      status: 'executed',
      exitCode: 137,
      options: {
        isolated: 'docker',
        isolationMode: 'detached',
        sessionName: 'task',
      },
    });
    let saved;
    const store = {
      get: () => saved || record,
      save: (r) => {
        saved = globalThis.structuredClone(r);
      },
    };
    const result = await resumeExecution(store, record.uuid, {
      command: 'new',
      snapshotOptions: { freeBytes: () => 100 * 1024 ** 3 },
      probe: () => ({ alive: false, state: SessionState.STOPPED }),
      runner: (_cmd, args) => {
        if (args[0] !== 'inspect') {
          expect(saved?.options.sessionName).toBe('task-resume-1');
          expect(saved?.attempt.launchAcceptedAt).toBeNull();
        }
        return {
          success: true,
          stdout: args.includes('--size')
            ? '1024'
            : args[0] === 'info'
              ? JSON.stringify({ DockerRootDir: '/docker' })
              : args[0] === 'inspect'
                ? '{}'
                : 'id',
        };
      },
      startWatcher: () => true,
    });
    expect(result.success).toBe(true);
  });

  it('never launches when the durable reservation fails', async () => {
    const record = new ExecutionRecord({
      command: 'old',
      status: 'executed',
      options: {
        isolated: 'docker',
        isolationMode: 'detached',
        sessionName: 'task',
      },
    });
    const calls = [];
    const result = await resumeExecution(
      {
        get: () => record,
        save: () => {
          throw new Error('ENOSPC');
        },
      },
      record.uuid,
      {
        probe: () => ({ alive: false, state: SessionState.STOPPED }),
        runner: (_cmd, args) => {
          calls.push(args);
          return { success: true, stdout: 'id' };
        },
      }
    );
    expect(result.success).toBe(false);
    expect(calls.some((args) => args[0] === 'start')).toBe(false);
  });
});

it('an ENOSPC while writing lock data never publishes an empty shared lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enospc-193-'));
  const file = path.join(dir, 'executions.lock');
  try {
    const failedFs = {
      ...fs,
      writeFileSync: (name) => {
        fs.writeFileSync(name, '');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    };
    expect(() => new LockManager(file, failedFs).acquire(100)).toThrow(
      'disk full'
    );
    expect(fs.readdirSync(dir)).toEqual([]);
    const healthy = new LockManager(file);
    expect(healthy.acquire(100)).toBe(true);
    healthy.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const canStop of [true, false]) {
  it(`attaches the watcher and identifies a postlaunch save failure (stop=${canStop})`, async () => {
    const record = new ExecutionRecord({
      command: 'work',
      status: 'executed',
      options: {
        isolated: 'docker',
        isolationMode: 'detached',
        sessionName: 'task',
      },
    });
    let saves = 0,
      saved,
      watched = false;
    const calls = [];
    const store = {
      get: () => saved || record,
      save: (r) => {
        if (++saves > 1) {
          throw Error('ENOSPC');
        }
        saved = globalThis.structuredClone(r);
      },
    };
    const result = await resumeExecution(store, record.uuid, {
      probe: () => ({ alive: false, state: SessionState.STOPPED }),
      runner: (_, args) => {
        calls.push(args);
        return {
          success: args[0] !== 'stop' || canStop,
          stdout: args[0] === 'inspect' ? '{}' : 'id',
        };
      },
      startWatcher: () => {
        watched = true;
        return true;
      },
    });
    expect(result.success).toBe(false);
    expect(watched).toBe(true);
    expect(calls.some((args) => args[0] === 'stop')).toBe(true);
    const error = JSON.parse(result.error);
    expect(error.code).toBe('LAUNCH_PERSISTENCE_FAILED');
    expect(error.containerName).toBe('task');
    expect(error.running).toBe(!canStop);
    expect(saved.options.launchPending).toBe(true);
  });
}

it('a partial ENOSPC database write preserves the durable reservation', () => {
  const { ExecutionStore } = require('../src/lib/execution-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'database-193-'));
  const store = new ExecutionStore({ appFolder: dir, useLinks: false });
  const record = new ExecutionRecord({
    command: 'reserved',
    options: { launchPending: true, sessionName: 'task-resume-1' },
  });
  store.save(record);
  const original = fs.writeFileSync;
  try {
    fs.writeFileSync = (name, content, ...args) => {
      if (typeof name === 'string' && name.startsWith(store.linoDbPath)) {
        original(name, String(content).slice(0, 8), ...args);
        throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
      }
      return original(name, content, ...args);
    };
    expect(() => store.save(new ExecutionRecord({ command: 'new' }))).toThrow(
      'disk full'
    );
    expect(store.get(record.uuid)?.options.sessionName).toBe('task-resume-1');
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual(
      []
    );
  } finally {
    fs.writeFileSync = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('a dead launcher does not permanently block a later resume', async () => {
  const { ExecutionStore } = require('../src/lib/execution-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-193-'));
  try {
    const store = new ExecutionStore({ appFolder: dir, useLinks: false });
    const record = new ExecutionRecord({
      command: 'work',
      options: {
        isolated: 'docker',
        isolationMode: 'detached',
        sessionName: 'task',
        launchPending: true,
        launchOwner: { pid: 2147483647, hostname: os.hostname() },
      },
    });
    store.save(record);
    const result = await resumeExecution(store, record.uuid, {
      probe: () => ({ alive: false, state: SessionState.STOPPED }),
      runner: () => ({ success: true, stdout: '{}' }),
      startWatcher: () => true,
    });
    expect(result.success).toBe(true);
    expect(store.get(record.uuid).options.launchPending).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
