/**
 * Issue #231: executions get caller-chosen names (`--alias`, `--rename`) and
 * can declare the execution they continue (`--continues`), which `--status`
 * reports and `--upload-log` follows.
 */
const { describe, it, expect } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('../src/lib/args-parser');
const {
  ExecutionStore,
  ExecutionRecord,
  isClinkInstalled,
} = require('../src/lib/execution-store');
const {
  executionAliases,
  findRecord,
  nameExecution,
} = require('../src/lib/execution-identity');
const {
  attachIdentity,
  buildChain,
  identityTextLines,
  prepareUploadLog,
  resolveContinues,
} = require('../src/lib/execution-chain');

const CLI = path.join(__dirname, '../src/bin/cli.js');
const A = '23100000-0000-4000-8000-00000000000a';
const B = '23100000-0000-4000-8000-00000000000b';
const C = '23100000-0000-4000-8000-00000000000c';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-231-'));
  const appFolder = path.join(root, 'app');
  return {
    root,
    store: new ExecutionStore({ appFolder }),
    env: {
      ...process.env,
      START_APP_FOLDER: appFolder,
      START_LOG_DIR: path.join(root, 'logs'),
      START_DISABLE_AUTO_ISSUE: '1',
      START_DISABLE_LOG_UPLOAD: '1',
      START_EXECUTION_ID: '',
    },
  };
}

function run(box, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: box.env,
    encoding: 'utf8',
    timeout: 20000,
  });
}

function record(uuid, options = {}, extra = {}) {
  const r = new ExecutionRecord({ uuid, command: `cmd-${uuid}`, options });
  Object.assign(r, extra);
  return r;
}

describe('issue #231: execution names', () => {
  it('resolves uuid, session name, earlier names, then aliases', () => {
    const records = [
      record(A, { aliases: [B] }),
      record(B, { sessionName: 'live' }),
      record(C, { sessionNameHistory: ['old'], name: 'task' }),
    ];
    expect(findRecord(records, B).uuid).toBe(B);
    expect(findRecord(records, 'live').uuid).toBe(B);
    expect(findRecord(records, 'old').uuid).toBe(C);
    expect(findRecord(records, 'task').uuid).toBe(C);
    expect(findRecord(records, 'missing')).toBeNull();
    expect(findRecord(records, '')).toBeNull();
  });

  it('--alias adds a name and refuses one used by another execution', () => {
    const { store } = sandbox();
    store.save(record(A, { sessionName: 'screen-a' }));
    store.save(record(B));
    const added = nameExecution(store, 'screen-a', 'task-1');
    expect(added).toEqual({
      success: true,
      output: `Aliased execution ${A}\naliases: [${A}, screen-a, task-1]`,
    });
    expect(store.get('task-1').uuid).toBe(A);
    expect(nameExecution(store, A, 'task-1').output).toStartWith(
      `Unchanged execution ${A}`
    );
    expect(nameExecution(store, B, 'task-1')).toEqual({
      success: false,
      error: `Name "task-1" already refers to execution ${A}`,
    });
    expect(nameExecution(store, B, A).success).toBe(false);
    expect(nameExecution(store, 'nope', 'x').error).toBe(
      'No execution found with UUID or session name: nope'
    );
    expect(nameExecution(store, A, '-x').success).toBe(false);
    // The backend session name list is left alone (it drives --cleanup).
    expect(store.get(A).options.sessionNameHistory).toBeUndefined();
  });

  it('--rename sets the display name and keeps the old one resolving', () => {
    const { store } = sandbox();
    store.save(record(A, { sessionName: 'screen-a' }));
    expect(nameExecution(store, A, 'first', { rename: true }).output).toBe(
      `Renamed execution ${A}\naliases: [${A}, screen-a, first]`
    );
    nameExecution(store, 'first', 'second', { rename: true });
    const renamed = store.get('second');
    expect(renamed.options).toMatchObject({
      sessionName: 'screen-a',
      name: 'second',
      aliases: ['first'],
    });
    expect(store.get('first').uuid).toBe(A);
    expect(store.get('screen-a').uuid).toBe(A);
    expect(executionAliases(renamed)).toEqual([
      A,
      'screen-a',
      'first',
      'second',
    ]);
  });

  // Issue #253: the rename used to reach only the lino store; clink 4.x
  // rejected every links query the store built.
  it.skipIf(!isClinkInstalled())(
    '--rename reaches the links database',
    () => {
      const { store } = sandbox();
      store.save(record(A, { sessionName: 'screen-a' }));
      nameExecution(store, A, 'first', { rename: true });
      const links = store.execClink('((($id: $s $t)) (($id: $s $t)))', [
        '--changes',
      ]).output;
      expect(links).toContain(
        `${A}.options: ${A} 'options={"sessionName":"screen-a","name":"first"}'`
      );
      expect(store.verifyConsistency().errors).toEqual([]);
    },
    30000
  );

  it('a UUID-shaped alias resolves like any other name', () => {
    const { store } = sandbox();
    store.save(record(A));
    expect(nameExecution(store, A, C).success).toBe(true);
    expect(store.get(C).uuid).toBe(A);
  });

  it('parses --alias and --rename with their two arguments', () => {
    expect(parseArgs(['--alias', A, 'task']).wrapperOptions).toMatchObject({
      alias: A,
      newName: 'task',
    });
    expect(parseArgs(['--rename', A, 'task']).wrapperOptions).toMatchObject({
      rename: A,
      newName: 'task',
    });
    expect(() => parseArgs(['--alias', A])).toThrow(
      'Option --alias requires a UUID or session name and a new name'
    );
    expect(() => parseArgs(['--rename', A, '--status'])).toThrow(
      'Option --rename requires a UUID or session name and a new name'
    );
    expect(() => parseArgs(['--alias', A, 'x', '--status', A])).toThrow(
      /Cannot combine .* --alias, or --rename in the same invocation/
    );
  });
});

describe('issue #231: continuation chains', () => {
  const chainRecords = () => [
    record(A, {}, { startTime: '2026-01-01T00:00:00.000Z' }),
    record(B, {}, { continues: A, startTime: '2026-01-02T00:00:00.000Z' }),
    record(C, {}, { continues: B, startTime: '2026-01-03T00:00:00.000Z' }),
  ];

  it('builds the chain from any member, oldest first', () => {
    const records = chainRecords();
    for (const member of records) {
      expect(buildChain(records, member).map((r) => r.uuid)).toEqual([A, B, C]);
    }
  });

  it('stops at a cycle', () => {
    const records = [
      record(A, {}, { continues: B }),
      record(B, {}, { continues: A }),
    ];
    expect(buildChain(records, records[0]).map((r) => r.uuid)).toEqual([B, A]);
  });

  it('resolves --continues by any name and refuses unknown or itself', () => {
    const { store } = sandbox();
    store.save(record(A, { sessionName: 'first' }));
    expect(resolveContinues(store, 'first', B)).toBe(A);
    expect(() => resolveContinues(store, 'nope', B)).toThrow(
      'No execution found with UUID or session name: nope'
    );
    expect(() => resolveContinues(store, A, A)).toThrow(
      `Execution ${A} cannot continue itself`
    );
    expect(() => resolveContinues(null, A, B)).toThrow(
      '--continues requires execution tracking.'
    );
  });

  it('--status reports aliases and the chain right after uuid', () => {
    const { store } = sandbox();
    chainRecords().forEach((r) => store.save(r));
    nameExecution(store, B, 'task');
    const obj = attachIdentity(store.get(B), store).toObject();
    expect(Object.keys(obj).slice(0, 3)).toEqual(['uuid', 'aliases', 'chain']);
    expect(obj.aliases).toEqual([B, 'task']);
    expect(obj.chain).toEqual([A, B, C]);
    expect(obj.continues).toBe(A);
    expect(identityTextLines(obj)).toEqual([
      `Aliases:           ${B}, task`,
      `Continues:         ${A}`,
      `Chain:             ${A} -> ${B} -> ${C}`,
    ]);
    // A record without names or a chain is reported unchanged.
    const plain = record(C);
    expect(attachIdentity(plain, null)).toBe(plain);
  });

  it('--upload-log joins the chain logs, oldest first', () => {
    const { store, root } = sandbox();
    chainRecords().forEach((r, i) => {
      r.logPath = path.join(root, `${i}.log`);
      fs.writeFileSync(r.logPath, `log-${i}\n`);
      store.save(r);
    });
    const single = record('23100000-0000-4000-8000-0000000000dd');
    single.logPath = '/x.log';
    store.save(single);
    expect(prepareUploadLog(store, single).path).toBe('/x.log');

    const prepared = prepareUploadLog(store, store.get(B));
    const text = fs.readFileSync(prepared.path, 'utf8');
    expect(text.indexOf('log-0')).toBeLessThan(text.indexOf('log-1'));
    expect(text.indexOf('log-1')).toBeLessThan(text.indexOf('log-2'));
    expect(text.split('"event":"continuation"').length - 1).toBe(3);
    expect(text).toContain(`"uuid":"${C}","chainIndex":3,"chainLength":3`);
    prepared.cleanup();
    expect(fs.existsSync(prepared.path)).toBe(false);
  });

  it('parses --continues and keeps it to launches', () => {
    expect(
      parseArgs(['--continues', A, '--', 'echo']).wrapperOptions.continues
    ).toBe(A);
    expect(
      parseArgs([`--continues=${A}`, '--', 'echo']).wrapperOptions.continues
    ).toBe(A);
    expect(() => parseArgs(['--continues', '--', 'echo'])).toThrow(
      'Option --continues requires a UUID or session name argument'
    );
    expect(() => parseArgs(['--status', A, '--continues', B])).toThrow(
      '--continues option is only valid when launching a command'
    );
  });
});

describe('issue #231: CLI flow', () => {
  if (process.platform === 'win32') {
    return;
  }

  it('aliases, renames and chains executions end to end', () => {
    const box = sandbox();
    expect(run(box, ['--session-id', A, '--', 'echo', 'one']).status).toBe(0);
    const alias = run(box, ['--alias', A, 'nightly']);
    expect(alias.status).toBe(0);
    expect(alias.stdout).toContain(`Aliased execution ${A}`);
    const rename = run(box, ['--rename', 'nightly', 'nightly-1']);
    expect(rename.stdout).toContain(`Renamed execution ${A}`);

    const second = run(box, [
      '--session-id',
      B,
      '--continues',
      'nightly-1',
      '--',
      'echo',
      'two',
    ]);
    expect(second.status).toBe(0);

    const status = run(box, [
      '--status',
      'nightly-1',
      '--output-format',
      'json',
    ]);
    const obj = JSON.parse(status.stdout);
    expect(obj.uuid).toBe(A);
    expect(obj.aliases).toEqual([A, 'nightly', 'nightly-1']);
    expect(obj.chain).toEqual([A, B]);

    const text = run(box, ['--status', B, '--output-format', 'text']);
    expect(text.stdout).toContain(`Continues:         ${A}`);
    expect(text.stdout).toContain(`Chain:             ${A} -> ${B}`);

    const missing = run(box, ['--continues', 'nope', '--', 'echo', 'x']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      'No execution found with UUID or session name: nope'
    );
    expect(missing.stdout).not.toContain('x\n');
  });
});
