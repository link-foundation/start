const { it, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  initialState,
  accrue,
  observeBase,
  evaluate,
} = require('../src/lib/cpu-penalty');
const cpu = require('../src/lib/cpu-penalty-monitor');

const penalized = (lastAt) => ({
  ...initialState(4, 0),
  phase: 'penalized',
  limitCpus: 2,
  penaltyCount: 1,
  penalizedMs: 1000,
  lastAt,
});

it('accrue settles penalized time since the last tick', () => {
  expect(accrue(penalized(1000), 4000)).toMatchObject({
    penalizedMs: 4000,
    lastAt: 4000,
  });
  expect(accrue(penalized(5000), 4000).penalizedMs).toBe(1000);
  const observing = { ...penalized(1000), phase: 'observing' };
  expect(accrue(observing, 4000).penalizedMs).toBe(1000);
});

it('a supervisor override keeps the penalized time before it', () => {
  const state = observeBase(penalized(1000), 3, 4000);
  expect(state.phase).toBe('observing');
  expect(state.penalizedMs).toBe(4000);
  const next = evaluate(state, {
    now: 5000,
    cores: 0,
    daemonCpus: 6,
    maxGapMs: 5000,
  }).state;
  expect(next.penalizedMs).toBe(4000);
});

for (const mode of ['graceful', 'supervise']) {
  it(`graceful stop lifts at once and keeps penalizedMs: ${mode}`, () => {
    if (process.platform === 'win32') {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-monitor-218-'));
    try {
      const logPath = path.join(dir, 'task.log');
      fs.writeFileSync(logPath, '');
      const record = {
        logPath,
        options: {
          sessionName: 'cpu-task',
          isolated: 'docker',
          // Default 15-minute windows: the monitor ticks every 30 s.
          cpuPenaltyConfig: {
            cpus: 2,
            trigger: 95,
            release: 65,
            triggerWindowMs: 900000,
            releaseWindowMs: 900000,
          },
          baseResourceLimits: [],
        },
      };
      let command = [
        process.execPath,
        require.resolve('../src/lib/cpu-penalty-monitor'),
        '',
        'cpu-task',
        '1',
        JSON.stringify(record),
      ];
      if (mode === 'supervise') {
        const script = `${cpu.startSnippet(null, 'cpu-task', 1, { ...record.options, logPath })}; read done; ${cpu.stopSnippet()}`;
        command = ['sh', '-c', script];
      }
      const result = spawnSync(
        'python3',
        [
          path.resolve(__dirname, '../../experiments/issue-218-monitor.py'),
          mode,
          logPath,
          ...command,
        ],
        { encoding: 'utf8' }
      );
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(logPath, 'utf8')).toContain(
        'CPU penalty lifted: 4 CPUs (monitor stopped)'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
}
