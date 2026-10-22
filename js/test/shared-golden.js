const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parseArgs } = require('../src/lib/args-parser');
const { buildDockerRuntimeArgs } = require('../src/lib/docker-runtime-args');
const { ExecutionRecord } = require('../src/lib/execution-store');
const {
  formatRecord,
  enrichDetachedStatus,
} = require('../src/lib/status-formatter');
const { executionAliases } = require('../src/lib/execution-identity');
const { buildChain, identityTextLines } = require('../src/lib/execution-chain');
const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, '../../parity/fixtures/contracts.json'))
);

describe('shared JavaScript and Rust golden contracts', () => {
  for (const fixture of fixtures['attempt-status-output']) {
    it(`attempt diagnostics: ${fixture.name}`, () => {
      const record = ExecutionRecord.fromObject(fixture.record);
      const output = JSON.parse(
        formatRecord(enrichDetachedStatus(record), 'json')
      );
      assert.deepEqual(output.attemptHistory, fixture.attemptHistory);
      assert.deepEqual(record.toObject(), fixture.record);
    });
  }
  for (const fixture of fixtures['docker-oom-event']) {
    it(`Docker OOM event: ${fixture.name}`, () => {
      assert.equal(
        require('../src/lib/exit-evidence').recentDockerOom(
          fixture.events,
          fixture.finishedAt
        ),
        fixture.recent
      );
    });
  }
  // The fixtures describe the defaults, so a host-wide docker init default
  // (issue #244) must not leak into them.
  function parseWithoutHostDefaults(argv) {
    const saved = process.env.START_COMMAND_DOCKER_INIT;
    delete process.env.START_COMMAND_DOCKER_INIT;
    try {
      return parseArgs(argv);
    } finally {
      if (saved !== undefined) {
        process.env.START_COMMAND_DOCKER_INIT = saved;
      }
    }
  }
  for (const fixture of fixtures['cli-parsing']) {
    it(`CLI parsing: ${fixture.name}`, () => {
      if (fixture.error) {
        assert.throws(
          () => parseWithoutHostDefaults(fixture.argv),
          new RegExp(fixture.error)
        );
        return;
      }
      const parsed = parseWithoutHostDefaults(fixture.argv);
      assert.equal(parsed.command, fixture.command);
      assert.deepEqual(parsed.rawCommand, fixture.rawCommand);
      for (const [key, value] of Object.entries(fixture.options)) {
        assert.deepEqual(parsed.wrapperOptions[key], value, key);
      }
      if (fixture.dockerResourceLimits) {
        const {
          resolveResourceOptions,
        } = require('../src/lib/docker-resource-options');
        assert.deepEqual(
          buildDockerRuntimeArgs(
            resolveResourceOptions(parsed.wrapperOptions)
          ).sort(),
          [...fixture.dockerResourceLimits].sort()
        );
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
  it('renders nested status options identically (issue #226)', () => {
    const fixture = fixtures['status-nested-options'];
    const record = ExecutionRecord.fromObject(fixture.record);
    const block = (text, start, isEnd) => {
      const lines = text.split('\n');
      const rest = lines.slice(lines.indexOf(start) + 1);
      const end = rest.findIndex(isEnd);
      return [start, ...(end === -1 ? rest : rest.slice(0, end))];
    };
    const links = formatRecord(record, 'links-notation');
    assert.deepEqual(
      block(links, '  options', (line) => /^ {2}\S/.test(line)),
      fixture.links
    );
    const text = formatRecord(record, 'text');
    assert.deepEqual(
      block(text, 'Options:', (line) => /^\S/.test(line)),
      fixture.text
    );
  });
  it('reports execution names and the continuation chain (issue #231)', () => {
    const fixture = fixtures['status-identity'];
    const records = fixture.records.map((r) => ExecutionRecord.fromObject(r));
    const record = records.find((r) => r.uuid === fixture.uuid);
    const aliases = executionAliases(record);
    const chain = buildChain(records, record).map((r) => r.uuid);
    assert.deepEqual(aliases, fixture.aliases);
    assert.deepEqual(chain, fixture.chain);
    assert.deepEqual(
      identityTextLines({ aliases, continues: record.continues, chain }),
      fixture.text
    );
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
  for (const fixture of fixtures['cpu-penalty-state']) {
    it(`CPU state: ${fixture.name}`, () => {
      const {
        initialState,
        observeBase,
        evaluate,
      } = require('../src/lib/cpu-penalty');
      let state = initialState(fixture.baseCpus, 0, fixture.saved);
      for (const step of fixture.steps) {
        state = observeBase(state, step.baseCpus, step.now);
        const decision = evaluate(
          state,
          { now: step.now, cores: step.cores, daemonCpus: 6, maxGapMs: 50 },
          fixture.config
        );
        assert.equal(decision.action?.kind || null, step.action);
        state = decision.state;
      }
      for (const [key, value] of Object.entries(fixture.expected)) {
        assert.deepEqual(state[key], value, key);
      }
    });
  }
});
