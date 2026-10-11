const { it, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { initialState, transitionLog } = require('../src/lib/cpu-penalty');
const cpu = require('../src/lib/cpu-penalty-monitor');

it('restarted monitors retain an observed base absent from launch flags', () => {
  const saved = { ...initialState(4, 0), phase: 'penalized', limitCpus: 2 };
  expect(initialState(null, 100, saved).baseCpus).toBe(4);
});

it('saved observing limits preserve the base after a daemon-clamped lift', () => {
  const saved = { ...initialState(4, 0), limitCpus: 1 };
  const { observeBase } = require('../src/lib/cpu-penalty');
  expect(observeBase(initialState(null, 100, saved), 1, 100).baseCpus).toBe(4);
});

for (const mode of [
  'nano',
  'quota',
  'restart',
  'zombie',
  'reused',
  'supervise',
  'publish-fault',
  'graceful',
  'override',
]) {
  it(`CPU monitor recovers external base and idle release: ${mode}`, () => {
    if (
      process.platform === 'win32' ||
      (['zombie', 'reused'].includes(mode) && process.platform !== 'linux')
    ) {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-monitor-207-'));
    try {
      const logPath = path.join(dir, 'task.log');
      fs.writeFileSync(logPath, '');
      const record = {
        logPath,
        options: {
          sessionName: 'cpu-task',
          isolated: 'docker',
          cpuPenaltyConfig: {
            cpus: 2,
            trigger: 95,
            release: 65,
            triggerWindowMs: 400,
            releaseWindowMs: 400,
          },
          baseResourceLimits: [],
        },
      };
      const command = [
        process.execPath,
        require.resolve('../src/lib/cpu-penalty-monitor'),
        '',
        'cpu-task',
        '1',
        JSON.stringify(record),
      ];
      if (mode === 'supervise') {
        const script = `${cpu.startSnippet(null, 'cpu-task', 1, { ...record.options, logPath })}; read done; ${cpu.stopSnippet()}`;
        command.splice(0, command.length, 'sh', '-c', script);
      }
      const result = spawnSync(
        'python3',
        [
          path.resolve(__dirname, '../../experiments/issue-207-monitor.py'),
          mode,
          logPath,
          ...command,
        ],
        { encoding: 'utf8' }
      );
      expect(result.status, result.stderr).toBe(0);
      const state = cpu.readState(record);
      const expected = mode === 'override' ? 3 : 4;
      expect(state.baseCpus).toBe(expected);
      expect(state.phase).toBe('observing');
      expect(state.limitCpus).toBe(expected);
      if (mode !== 'override') {
        expect(fs.readFileSync(logPath, 'utf8')).toContain(
          'CPU penalty lifted: 4'
        );
      }
      const { ExecutionRecord } = require('../src/lib/execution-store');
      const {
        enrichDetachedStatus,
        formatRecord,
      } = require('../src/lib/status-formatter');
      const statusRecord = new ExecutionRecord({
        ...record,
        options: { ...record.options, isolated: undefined },
      });
      const status = JSON.parse(
        formatRecord(enrichDetachedStatus(statusRecord), 'json')
      );
      expect(status.cpuPenalty.baseCpus).toBe(expected);
      expect(status.cpuPenalty.limitCpus).toBe(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
}

for (const failure of ['inspect', 'stats', 'update', 'publish']) {
  it(`an exception in ${failure} resets coverage and monitoring continues`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-tick-207-'));
    const logPath = path.join(dir, 'task.log');
    const record = {
      logPath,
      options: {
        sessionName: 'cpu-task',
        cpuPenaltyConfig: {
          cpus: 2,
          trigger: 95,
          release: 65,
          triggerWindowMs: 100,
          releaseWindowMs: 100,
        },
      },
    };
    let ticks = 0;
    let injected = false,
      limit = 4,
      lifted = false;
    const filesystem = Object.create(fs);
    filesystem.renameSync = (from, to) => {
      if (
        failure === 'publish' &&
        !injected &&
        JSON.parse(fs.readFileSync(from)).phase === 'penalized'
      ) {
        injected = true;
        throw new Error('injected ENOSPC');
      }
      fs.renameSync(from, to);
    };
    try {
      await cpu.monitor('', 'cpu-task', 1, JSON.stringify(record), {
        fs: filesystem,
        run: (_command, args) => {
          if (args[0] === failure && !injected) {
            injected = true;
            throw new Error(`injected ${failure}`);
          }
          const result = (stdout) => ({ success: true, stdout });
          if (args[0] === 'inspect') {
            if (!args[2].includes('HostConfig') && ++ticks > 60) {
              lifted = false;
              return result('false');
            }
            return result(
              args[2].includes('HostConfig')
                ? JSON.stringify({ NanoCpus: limit * 1e9 })
                : String(!lifted)
            );
          }
          if (args[0] === 'info') {
            return result('{"NCPU":6}');
          }
          if (args[0] === 'stats') {
            return result(
              JSON.stringify({
                Name: 'cpu-task',
                CPUPerc: limit === 2 ? '20%' : '400%',
              })
            );
          }
          if (args[0] === 'update') {
            limit = Number(args[2]);
            lifted = limit === 4;
            return result('');
          }
          throw new Error('unexpected command');
        },
      });
      expect(injected).toBe(true);
      expect(lifted).toBe(true);
      expect(cpu.readState(record).baseCpus).toBe(4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 5000);
}

it('stopped resume uses the observed base rather than the temporary quota', () => {
  const { restoreBaseCpu } = require('../src/lib/resume-resources');
  expect(
    restoreBaseCpu(
      ['--memory=512m', '--cpus=2'],
      { cpuPenaltyConfig: {}, baseResourceLimits: [] },
      { baseCpus: 4 }
    )
  ).toEqual(['--memory=512m', '--cpus=4']);
});

it('stopped resume preserves a later supervisor override instead of the stale cap', () => {
  const { restoreBaseCpu } = require('../src/lib/resume-resources');
  const options = { cpuPenaltyConfig: {}, baseResourceLimits: [] };
  const saved = { phase: 'penalized', baseCpus: 4, limitCpus: 2 };
  expect(restoreBaseCpu(['--cpus=2'], options, saved, true)).toEqual([
    '--cpus=4',
  ]);
  expect(restoreBaseCpu(['--cpus=3'], options, saved, true)).toEqual([
    '--cpus=3',
  ]);
});

it('transition logs explain the window and phase denominator', () => {
  const config = { cpus: 2, triggerWindowMs: 900000, releaseWindowMs: 400 };
  expect(
    transitionLog({ kind: 'apply', cpus: 2, capacity: 4, average: 100 }, config)
  ).toContain('of 4 CPUs for 15m');
  expect(
    transitionLog({ kind: 'lift', cpus: 4, capacity: 4, average: 10 }, config)
  ).toContain('of 2 CPUs for 400ms');
});

it('process birth identity reclaims reused PIDs without evicting a live lock', () => {
  if (process.platform !== 'linux') {
    return;
  }
  const { LockManager } = require('../src/lib/store-lock');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-lock-207-'));
  const file = path.join(dir, 'lock');
  const first = new LockManager(file);
  const replacement = new LockManager(file);
  try {
    expect(first.acquire(100)).toBe(true);
    const data = JSON.parse(fs.readFileSync(file));
    expect(data.processStart).toBeTruthy();
    expect(replacement.acquire(100)).toBe(false);
    fs.writeFileSync(
      file,
      JSON.stringify({ ...data, processStart: 'different-birth' })
    );
    expect(replacement.acquire(100)).toBe(true);
    first.release();
    expect(fs.existsSync(file)).toBe(true);
  } finally {
    replacement.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
