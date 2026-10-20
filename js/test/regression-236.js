// Own the snapshot lock when run without the default preloads.
require('./setup/private-snapshot-lock');
const { it, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('../src/lib/args-parser');
const {
  resolveResourceOptions,
} = require('../src/lib/docker-resource-options');
const {
  buildDockerRuntimeArgs,
  buildDockerRuntimeMetadata,
} = require('../src/lib/docker-runtime-args');
const {
  ExecutionRecord,
  ExecutionStore,
} = require('../src/lib/execution-store');
const { formatRecord } = require('../src/lib/status-formatter');
const { resumeExecution } = require('../src/lib/execution-resume');

it('parses the reported command and forwards both limits to Docker', () => {
  for (const flag of [
    ['--memory-reservation', '64m'],
    ['--memory-reservation=64m'],
  ]) {
    const options = parseArgs([
      '--isolated',
      'docker',
      '--image',
      'alpine:3.20',
      '--memory',
      '256m',
      ...flag,
      '--',
      'echo',
      'hi',
    ]).wrapperOptions;
    expect(options.memoryReservation).toBe('64m');
    const resolved = resolveResourceOptions(options);
    const argv = buildDockerRuntimeArgs(resolved);
    expect(argv).toContain('--memory=268435456');
    expect(argv).toContain('--memory-reservation=67108864');
    const metadata = buildDockerRuntimeMetadata({ ...options, ...resolved });
    const record = ExecutionRecord.fromObject(
      new ExecutionRecord({ command: 'echo hi', options: metadata }).toObject()
    );
    expect(record.options.resourceLimitSpecs.memoryReservation).toBe('64m');
    expect(record.options.resolvedLimits.memoryReservation).toBe(67108864);
    for (const format of ['json', 'text', 'links-notation']) {
      expect(formatRecord(record, format)).toContain('memoryReservation');
      expect(formatRecord(record, format)).toContain('67108864');
    }
  }
});

it('resolves reservation percentages from daemon RAM once, including ranges', () => {
  let calls = 0;
  const resolved = resolveResourceOptions(
    { memory: '50%', memoryReservation: '10%-20%' },
    (_, argv) => {
      calls++;
      expect(argv[0]).toBe('info');
      return {
        success: true,
        stdout: JSON.stringify({ MemTotal: 10 * 1024 ** 3, NCPU: 8 }),
      };
    },
    () => 0.5
  );
  expect(calls).toBe(1);
  expect(resolved.resolvedLimits.memoryReservation).toBe(1610612736);
  expect(resolved.resourceLimitSpecs.memoryReservation).toBe('10%-20%');
  expect(
    resolveResourceOptions({ resourceLimits: resolved.resourceLimits }, () => {
      throw Error('must preserve resolved limits');
    }).resourceLimits
  ).toEqual(resolved.resourceLimits);
});

it('rejects equal or larger reservations against new and inherited hard caps', () => {
  for (const options of [
    { memory: '256m', memoryReservation: '512m' },
    { memory: '256m', memoryReservation: '256m' },
    { memoryReservation: '512m', resourceLimits: ['--memory=256m'] },
    {
      memory: '32m',
      resourceLimits: ['--memory=256m', '--memory-reservation=64m'],
    },
  ]) {
    expect(() => resolveResourceOptions(options)).toThrow(
      'memory-reservation must be less than memory'
    );
  }
  expect(
    resolveResourceOptions({ memoryReservation: '64m' }).resourceLimits
  ).toEqual(['--memory-reservation=67108864']);
});

it('validates reservation syntax, missing values and Docker isolation', () => {
  for (const value of ['0m', '0%', '101%', '10watts', '20%-10%', '']) {
    expect(() =>
      parseArgs([
        '--isolated',
        'docker',
        `--memory-reservation=${value}`,
        '--',
        'true',
      ])
    ).toThrow();
  }
  expect(() =>
    parseArgs(['--isolated', 'docker', '--memory-reservation'])
  ).toThrow();
  expect(() => parseArgs(['--memory-reservation=64m', '--', 'true'])).toThrow(
    'Resource options require Docker'
  );
});

it('forwards reservations through a nested Docker isolation level', () => {
  const options = parseArgs([
    '--isolated',
    'screen docker',
    '--memory',
    '256m',
    '--memory-reservation',
    '64m',
    '--',
    'work',
  ]).wrapperOptions;
  expect(
    require('../src/lib/command-builder').buildNextLevelCommand(options, 'work')
  ).toContain('--memory-reservation 64m');
});

for (const mode of ['start', 'snapshot', 'missing', 'override', 'invalid']) {
  it(`preserves or overrides the reservation on ${mode} resume`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-236-'));
    try {
      const store = new ExecutionStore({ appFolder: dir, useLinks: false });
      const resolved = resolveResourceOptions({
        memory: '256m',
        memoryReservation: '64m',
      });
      const record = new ExecutionRecord({
        command: 'work',
        status: 'executed',
        logPath: path.join(dir, 'run.log'),
        options: {
          isolated: 'docker',
          isolationMode: 'detached',
          sessionName: 'task',
          image: 'alpine',
          ...resolved,
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
              MemTotal: 1024 ** 3,
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
              Memory: 268435456,
              MemorySwap: 268435456,
              MemoryReservation: 67108864,
            }),
          };
        }
        return { success: true, stdout: 'id' };
      };
      const result = await resumeExecution(store, record.uuid, {
        command: mode === 'snapshot' ? 'new' : null,
        resourceOptions:
          mode === 'override'
            ? { memoryReservation: '32m' }
            : mode === 'invalid'
              ? { memory: '32m' }
              : {},
        runIsolated: async (_backend, _command, options) => {
          calls.push(['run', ...options.resourceLimits]);
          return { success: true };
        },
        snapshotOptions: { freeBytes: () => 100 * 1024 ** 3 },
        runner,
        probe: () => ({
          alive: false,
          state: mode === 'missing' ? 'missing' : 'stopped',
        }),
        startWatcher: () => true,
      });
      expect(result.success).toBe(mode !== 'invalid');
      if (mode === 'invalid') {
        expect(result.error).toContain(
          'memory-reservation must be less than memory'
        );
        expect(
          calls.some((a) => ['start', 'run', 'update', 'commit'].includes(a[0]))
        ).toBe(false);
      } else {
        const current = store.get(record.uuid);
        const bytes = mode === 'override' ? 33554432 : 67108864;
        expect(current.options.resolvedLimits.memoryReservation).toBe(bytes);
        expect(current.options.resourceLimitSpecs.memoryReservation).toBe(
          mode === 'override' ? '32m' : '64m'
        );
        if (mode === 'override') {
          expect(calls.find((a) => a[0] === 'update')).toContain(
            `--memory-reservation=${bytes}`
          );
          expect(calls.findIndex((a) => a[0] === 'update')).toBeLessThan(
            calls.findIndex((a) => a[0] === 'start')
          );
        }
        if (mode === 'snapshot' || mode === 'missing') {
          const limits = calls.find((a) => a[0] === 'run');
          expect(
            limits.some((s) => /^--memory-reservation=(64m|67108864)$/.test(s))
          ).toBe(true);
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

it('refuses reservation overrides when resuming a non-Docker execution', () => {
  expect(() =>
    require('../src/lib/resume-resources').prepareResumeResources(
      { options: { isolated: 'screen' } },
      { state: 'stopped' },
      { memoryReservation: '64m' }
    )
  ).toThrow('Resource overrides require a Docker execution');
});
