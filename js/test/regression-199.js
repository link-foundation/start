const { describe, it, expect } = require('bun:test');
const { parseArgs } = require('../src/lib/args-parser');
const {
  buildDockerRuntimeArgs,
  buildDockerRuntimeMetadata,
} = require('../src/lib/docker-runtime-args');
const { buildNextLevelCommand } = require('../src/lib/command-builder');

describe('Docker attribution labels (#199)', () => {
  it('attributes replacement containers to their stable root and execution', () => {
    const { dockerLabels } = require('../src/lib/docker-labels');
    expect(
      dockerLabels({
        session: 'demo-resume-1-resume-2',
        sessionId: 'uuid',
        resumeCount: 2,
      })
    ).toEqual([
      'start-command.session=demo-resume-1-resume-2',
      'start-command.root-session=demo',
      'start-command.resume-count=2',
      'start-command.uuid=uuid',
    ]);
  });
  it('parses repeated labels and preserves equals signs and empty values', () => {
    const { wrapperOptions } = parseArgs([
      '-i',
      'docker',
      '--label',
      'hive-mind.tool=codex',
      '--label=task.url=https://github.com/o/r/issues/1?q=a=b',
      '--label',
      'empty=',
      '--',
      'echo',
    ]);
    expect(wrapperOptions.labels).toEqual([
      'hive-mind.tool=codex',
      'task.url=https://github.com/o/r/issues/1?q=a=b',
      'empty=',
    ]);
    const args = buildDockerRuntimeArgs(wrapperOptions);
    for (const label of wrapperOptions.labels) {
      expect(args).toContain(label);
    }
    expect(buildDockerRuntimeMetadata(wrapperOptions).labels).toEqual(
      wrapperOptions.labels
    );
  });
  it('rejects malformed, reserved and non-Docker labels', () => {
    for (const label of [
      'missing-value',
      '=empty-key',
      'start-command.uuid=spoof',
    ]) {
      expect(() =>
        parseArgs(['-i', 'docker', '--label', label, '--', 'true'])
      ).toThrow();
    }
    expect(() => parseArgs(['--label', 'task=one', '--', 'true'])).toThrow();
  });
  it('forwards labels safely through nested Docker isolation', () => {
    const command = buildNextLevelCommand(
      {
        isolatedStack: ['screen', 'docker'],
        labels: ['task=a "quote" $value'],
      },
      'true'
    );
    expect(
      parseArgs(
        require('../src/lib/shell-utils').splitShellWords(command).slice(1)
      ).wrapperOptions.labels
    ).toEqual(['task=a "quote" $value']);
  });
});
