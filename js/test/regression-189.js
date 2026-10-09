const { it, expect } = require('bun:test');
const { parseArgs } = require('../src/lib/args-parser');
it('CPU penalty is opt-in and accepts durations and percentage settings', () => {
  const options = parseArgs([
    '--isolated',
    'docker',
    '--cpu-penalty',
    '--cpu-penalty-trigger-window',
    '1s',
    '--',
    'true',
  ]).wrapperOptions;
  expect(options.cpuPenaltyConfig.triggerWindowMs).toBe(1000);
  expect(options.cpuPenaltyConfig.release).toBe(65);
});
const { initialState, evaluate, average } = require('../src/lib/cpu-penalty');
const config = {
  cpus: 2,
  trigger: 95,
  triggerWindowMs: 100,
  release: 65,
  releaseWindowMs: 100,
};
it('requires complete time-weighted windows, then lifts and observes afresh', () => {
  let state = initialState(null, 0);
  const tick = (now, cores) => {
    const result = evaluate(
      state,
      { now, cores, daemonCpus: 6, maxGapMs: 50 },
      config
    );
    state = result.state;
    return result.action;
  };
  expect(tick(0, 6)).toBeNull();
  expect(tick(40, 6)).toBeNull();
  expect(tick(80, 6)).toBeNull();
  expect(tick(100, 0.4).kind).toBe('apply');
  expect(state.penaltyCount).toBe(1);
  expect(tick(120, 0.4)).toBeNull();
  expect(tick(160, 0.4)).toBeNull();
  expect(tick(200, 0.4)).toBeNull();
  expect(tick(220, 6).kind).toBe('lift');
  expect(state.penalizedMs).toBe(120);
  expect(tick(240, 6)).toBeNull();
  expect(tick(280, 6)).toBeNull();
  expect(tick(320, 6)).toBeNull();
  expect(tick(340, 6).kind).toBe('apply');
  expect(state.penaltyCount).toBe(2);
});
it('resets coverage on outage, gaps, resize and restart, and skips ineffective caps', () => {
  let state = initialState(4, 0);
  for (const [now, cores, daemonCpus] of [
    [0, 4, 6],
    [40, 4, 6],
    [80, NaN, 6],
    [120, 4, 6],
    [160, 4, 6],
    [200, 4, 8],
  ]) {
    const result = evaluate(
      state,
      { now, cores, daemonCpus, maxGapMs: 50 },
      config
    );
    state = result.state;
    expect(result.action).toBeNull();
  }
  const restarted = initialState(4, 240, state);
  expect(
    evaluate(
      restarted,
      { now: 240, cores: 4, daemonCpus: 8, maxGapMs: 50 },
      config
    ).action
  ).toBeNull();
  expect(
    evaluate(state, { now: 400, cores: 4, daemonCpus: 8, maxGapMs: 50 }, config)
      .action
  ).toBeNull();
  state = initialState(1, 0);
  for (const now of [0, 40, 80, 120]) {
    const r = evaluate(
      state,
      { now, cores: 1, daemonCpus: 6, maxGapMs: 50 },
      config
    );
    state = r.state;
    expect(r.action).toBeNull();
  }
});
it('weights timestamps rather than giving short intervals equal weight', () => {
  expect(
    average(
      [
        { at: 0, cores: 6 },
        { at: 90, cores: 0 },
        { at: 100, cores: 0 },
      ],
      100,
      100
    )
  ).toBe(5.4);
});
it('resume restores the original base within resized daemon capacity', () => {
  const { prepareResumeResources } = require('../src/lib/resume-resources');
  const record = {
    options: {
      isolated: 'docker',
      sessionName: 'task',
      cpuPenaltyConfig: config,
      baseResourceLimits: ['--cpus=3'],
      resourceLimits: ['--cpus=0.5'],
      resolvedLimits: { cpus: 3 },
    },
  };
  const result = prepareResumeResources(
    record,
    { state: 'stopped' },
    {},
    (_cmd, args) => ({
      success: true,
      stdout: JSON.stringify(
        args[0] === 'info'
          ? { MemTotal: 1073741824, NCPU: 2 }
          : { NanoCpus: 500000000 }
      ),
    })
  );
  expect(result.resourceLimits).toContain('--cpus=2');
  expect(result.resolvedLimits.cpus).toBe(2);
  expect(record.options.baseResourceLimits).toEqual(['--cpus=3']);
});

it('monitor applies, lifts and reapplies with tracking disabled', () => {
  if (process.platform === 'win32') {
    return;
  }
  const fs = require('fs'),
    path = require('path'),
    os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-monitor-189-'));
  try {
    const logPath = path.join(dir, 'task.log');
    fs.writeFileSync(logPath, '');
    const record = {
      logPath,
      options: {
        sessionName: 'cpu-task',
        cpuPenaltyConfig: {
          ...config,
          triggerWindowMs: 200,
          releaseWindowMs: 200,
        },
        baseResourceLimits: [],
      },
    };
    const result = require('child_process').spawnSync(
      '/bin/sh',
      [
        path.resolve(__dirname, '../../experiments/issue-195-cpu-monitor.sh'),
        process.execPath,
        require.resolve('../src/lib/cpu-penalty-monitor'),
        '',
        'cpu-task',
        '1',
        JSON.stringify(record),
      ],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(0);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('CPU penalty applied: 2');
    expect(lines[1]).toContain('CPU penalty lifted: 6');
    expect(lines[2]).toContain('CPU penalty applied: 2');
    const state = JSON.parse(
      fs.readFileSync(`${logPath}.cpu-penalty.json`, 'utf8')
    );
    expect(state.penaltyCount).toBe(2);
    expect(state.phase).toBe('penalized');
    expect(state.penalizedMs).toBeGreaterThan(200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

it('preserves legacy CPU quota format and the lower original base', () => {
  const limits = require('../src/lib/docker-resource-limits');
  const base = ['--cpu-period=200000', '--cpu-quota=100000'];
  expect(limits.cpuCount(base)).toBe(0.5);
  expect(limits.withCpuLimit(base, 0.25)).toEqual([
    '--cpu-period=100000',
    '--cpu-quota=25000',
  ]);
  expect(limits.cpuUpdateArgs(base, 0.25)).toEqual([
    '--cpu-period=100000',
    '--cpu-quota=25000',
  ]);
  const { clampCpuToDaemon } = require('../src/lib/resume-resources');
  expect(
    clampCpuToDaemon(base, () => ({
      success: true,
      stdout: '{"NCPU":4,"MemTotal":1073741824}',
    }))
  ).toEqual(['--cpu-period=100000', '--cpu-quota=50000']);
  const { prepareResumeResources } = require('../src/lib/resume-resources');
  const overridden = prepareResumeResources(
    {
      options: {
        isolated: 'docker',
        sessionName: 'task',
        resourceLimits: base,
      },
    },
    { state: 'stopped' },
    { cpus: '0.25' },
    () => ({ success: true, stdout: '{"CpuPeriod":200000,"CpuQuota":100000}' })
  );
  expect(overridden.resourceLimits).toEqual([
    '--cpu-period=100000',
    '--cpu-quota=25000',
  ]);
});
