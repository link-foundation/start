const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parseArgs } = require('../src/lib/args-parser');
const { buildDockerRuntimeArgs } = require('../src/lib/docker-runtime-args');
const { ExecutionRecord } = require('../src/lib/execution-store');
const { formatRecord } = require('../src/lib/status-formatter');
const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, '../../parity/fixtures/contracts.json'))
);

describe('shared JavaScript and Rust golden contracts', () => {
  for (const fixture of fixtures['cli-parsing']) {
    it(`CLI parsing: ${fixture.name}`, () => {
      if (fixture.error) {
        assert.throws(() => parseArgs(fixture.argv), new RegExp(fixture.error));
        return;
      }
      const parsed = parseArgs(fixture.argv);
      assert.equal(parsed.command, fixture.command);
      assert.deepEqual(parsed.rawCommand, fixture.rawCommand);
      for (const [key, value] of Object.entries(fixture.options)) {
        assert.deepEqual(parsed.wrapperOptions[key], value, key);
      }
    });
  }
  for (const fixture of fixtures['isolation-arguments']) {
    it(`isolation argv: ${fixture.name}`, () => {
      assert.deepEqual(buildDockerRuntimeArgs(fixture.options), fixture.argv);
    });
  }
  it('uses the same JSON and text status output', () => {
    const fixture = fixtures['status-output'];
    const record = new ExecutionRecord(fixture.record);
    assert.deepEqual(JSON.parse(formatRecord(record, 'json')), fixture.json);
    assert.equal(formatRecord(record, 'text'), fixture.text);
  });
  for (const fixture of fixtures['execution-record-format']) {
    it(`preserves the complete execution record format (exit ${fixture.exitCode})`, () => {
      assert.deepEqual(ExecutionRecord.fromObject(fixture).toObject(), fixture);
    });
  }
  it('executes the JavaScript source of the generated Rust parity policy', async () => {
    const { minimumRustTestCount } =
      await import('../../scripts/parity-threshold.mjs');
    for (const fixture of fixtures['parity-threshold']) {
      assert.equal(
        minimumRustTestCount(fixture.javascript),
        fixture.minimumRust
      );
    }
  });
});
