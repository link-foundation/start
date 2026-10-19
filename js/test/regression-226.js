// Issue #226: `$ --status` printed nested option values (launchOwner,
// exitEvidence, resolvedLimits, resourceLimitSpecs) as "[object Object]".
const { describe, it, expect } = require('bun:test');
const { ExecutionRecord } = require('../src/lib/execution-store');
const {
  formatRecordAsLinksNotation,
  formatRecordAsText,
  formatRecordList,
} = require('../src/lib/status-formatter');

function recordWithNestedOptions() {
  return new ExecutionRecord({
    uuid: 'obj-demo-uuid',
    command: "sh -c 'exit 1'",
    status: 'executed',
    exitCode: 1,
    startTime: '2026-10-19T00:00:00.000Z',
    endTime: '2026-10-19T00:00:10.000Z',
    logPath: '/tmp/obj-demo.log',
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: 'obj-demo',
      launchOwner: { pid: 522913, hostname: '70a2c2990824' },
      exitEvidence: { daemonRestart: false, mainOom: false },
      resolvedLimits: { cpus: 2, memory: '4g' },
      resourceLimitSpecs: { memory: { value: '4g', source: 'flag' } },
      ports: ['8080:80', '9090:90'],
    },
  });
}

describe('issue #226: nested option values in --status', () => {
  it('links notation renders nested option values instead of [object Object]', () => {
    const output = formatRecordAsLinksNotation(recordWithNestedOptions());
    expect(output).not.toContain('[object Object]');
    const lines = output.split('\n');
    const at = (line) => lines.indexOf(line);
    expect(at('    launchOwner')).toBeGreaterThan(at('  options'));
    expect(lines[at('    launchOwner') + 1]).toBe('        pid 522913');
    expect(lines[at('    launchOwner') + 2]).toBe(
      '        hostname 70a2c2990824'
    );
    expect(lines[at('    exitEvidence') + 1]).toBe(
      '        daemonRestart false'
    );
    expect(lines[at('    exitEvidence') + 2]).toBe('        mainOom false');
    expect(lines[at('    resolvedLimits') + 1]).toBe('        cpus 2');
    expect(lines[at('    resolvedLimits') + 2]).toBe('        memory 4g');
    expect(lines[at('    resourceLimitSpecs') + 1]).toBe('        memory');
    expect(lines[at('    resourceLimitSpecs') + 2]).toBe(
      '            value 4g'
    );
    expect(lines.slice(at('    ports'), at('    ports') + 4)).toEqual([
      '    ports',
      '      (',
      '        "8080:80"',
      '        "9090:90"',
    ]);
  });

  it('text format renders nested option values as JSON', () => {
    const output = formatRecordAsText(recordWithNestedOptions());
    expect(output).not.toContain('[object Object]');
    expect(output).toContain(
      '  launchOwner: {"pid":522913,"hostname":"70a2c2990824"}'
    );
    expect(output).toContain(
      '  exitEvidence: {"daemonRestart":false,"mainOom":false}'
    );
    expect(output).toContain('  ports: ["8080:80","9090:90"]');
  });

  it('--list output in every format keeps the nested values', () => {
    for (const format of ['links-notation', 'text', 'json']) {
      const output = formatRecordList([recordWithNestedOptions()], format);
      expect(output).not.toContain('[object Object]');
      expect(output).toContain('522913');
    }
  });
});
