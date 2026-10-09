const { describe, it, expect } = require('bun:test');
const { parseArgs } = require('../src/lib/args-parser');

describe('issue #190: launch resource options', () => {
  it('recognizes resource flags and rejects invalid input before launch', () => {
    const parsed = parseArgs([
      '--isolated',
      'docker',
      '--image',
      'alpine',
      '--memory',
      '90%-100%',
      '--cpus=50%',
      '--',
      'true',
    ]);
    expect(parsed.wrapperOptions.memory).toBe('90%-100%');
    expect(parsed.wrapperOptions.cpus).toBe('50%');
    for (const value of ['100%-90%', '101%', '0%', '0g', '3watts']) {
      expect(() =>
        parseArgs([
          '--isolated',
          'docker',
          '--image',
          'alpine',
          '--memory',
          value,
          '--',
          'true',
        ])
      ).toThrow();
    }
  });
});

const {
  resolveResourceOptions,
} = require('../src/lib/docker-resource-options');
it('uses daemon capacity, draws each range once and disables extra swap by default', () => {
  let draws = 0;
  const calls = [];
  const result = resolveResourceOptions(
    { memory: '70%-80%', cpus: '50%' },
    (_cmd, args) => {
      calls.push(args);
      return {
        success: true,
        stdout: JSON.stringify({ MemTotal: 1024 ** 3 * 10, NCPU: 8 }),
      };
    },
    () => {
      draws++;
      return 0.5;
    }
  );
  expect(result.resourceLimits).toEqual([
    '--memory=8053063680',
    '--cpus=4',
    '--memory-swap=8053063680',
  ]);
  expect(result.resolvedLimits.memorySwap).toBe(result.resolvedLimits.memory);
  expect(calls).toHaveLength(1);
  expect(draws).toBe(2);
});
it('preserves stored resolutions without another random draw or daemon query', () => {
  const limits = [
    '--memory=8053063680',
    '--memory-swap=8053063680',
    '--cpus=4',
  ];
  const result = resolveResourceOptions(
    { resourceLimits: limits },
    () => {
      throw Error('unexpected query');
    },
    () => {
      throw Error('unexpected draw');
    }
  );
  expect(result.resourceLimits).toEqual(limits);
});
it('rejects swap below memory and daemon capacity failures', () => {
  expect(() =>
    resolveResourceOptions({ memory: '64m', memorySwap: '32m' })
  ).toThrow();
  expect(() =>
    resolveResourceOptions({ memory: '80%' }, () => ({ success: false }))
  ).toThrow();
});

it('forwards raw resource and penalty options through every remaining Docker level', () => {
  const { buildNextLevelCommand } = require('../src/lib/command-builder');
  const options = parseArgs([
    '--isolated',
    'screen docker',
    '--memory',
    '70%-80%',
    '--cpus',
    '50%',
    '--cpu-penalty',
    '--cpu-penalty-trigger-window',
    '2s',
    '--',
    'work',
  ]).wrapperOptions;
  const command = buildNextLevelCommand(options, 'work');
  expect(command).toContain('--memory 70%-80%');
  expect(command).toContain('--cpus 50%');
  expect(command).toContain('--cpu-penalty-trigger-window 2000ms');
});
