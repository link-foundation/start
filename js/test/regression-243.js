/**
 * Regression tests for issue #243: `$ --status` decoded the whole store up to
 * three times, and `$ --list` started one or two `docker inspect` processes
 * per record, one after another, including records that had long finished.
 *
 * Now the store is decoded once per content within a process, one batched
 * `docker inspect` answers every probe of a query, and records whose
 * container is already marked removed are not probed at all. The output is
 * the same as before.
 */

const { describe, it, expect, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DECODED_COPY_FILE,
  ExecutionRecord,
  ExecutionStatus,
  ExecutionStore,
} = require('../src/lib/execution-store');
const { listExecutions, queryStatus } = require('../src/lib/status-formatter');
const {
  BATCH_FORMAT,
  parseBatchInspect,
  prefetchedInspect,
  withDockerInspectBatch,
} = require('../src/lib/docker-inspect-batch');
const {
  DECODED_COPY_FORMAT,
  decodeCount,
  decodeStoreContent,
  forgetDecodedStore,
} = require('../src/lib/store-decode-cache');

const posix = process.platform === 'win32' ? describe.skip : describe;
// The fake docker is a shell script, which Windows cannot spawn.
const posixIt = process.platform === 'win32' ? it.skip : it;
const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const CONTAINERS = [
  ['run-a', 'aaaa1111', 4101, true, 0, false, '2026-10-20T10:00:00Z', ''],
  [
    'run-b',
    'bbbb2222',
    0,
    false,
    0,
    false,
    '2026-10-20T10:00:00Z',
    '2026-10-20T10:05:00Z',
  ],
  [
    'kept-c',
    'cccc3333',
    0,
    false,
    1,
    false,
    '2026-10-20T09:00:00Z',
    '2026-10-20T09:01:00Z',
  ],
].map(([name, id, pid, running, exitCode, oom, startedAt, finishedAt]) => ({
  '.Name': `/${name}`,
  '.Id': id,
  '.State.Pid': String(pid),
  '.State.Running': String(running),
  '.State.ExitCode': String(exitCode),
  '.State.OOMKilled': String(oom),
  '.State.StartedAt': startedAt || '0001-01-01T00:00:00Z',
  '.State.FinishedAt': finishedAt || '0001-01-01T00:00:00Z',
}));

/**
 * Fake `docker` that answers `inspect` like Docker 29: one rendered line per
 * found target, one "No such container" line on stderr per missing one, and
 * exit 1 when any is missing. In `legacy` mode it rejects `--type`, as a
 * stubbed or old docker would, so every probe runs on its own as before.
 */
function withFakeDocker(mode, fn) {
  const dir = makeTempDir('fake-docker-243-');
  const state = path.join(dir, 'containers.json');
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(state, JSON.stringify(CONTAINERS));
  const script = path.join(dir, 'docker.js');
  fs.writeFileSync(
    script,
    `const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'inspect') process.exit(1);
let rest = args.slice(1);
if (rest[0] === '--type') {
  if (${JSON.stringify(mode)} === 'legacy') {
    process.stderr.write('unknown flag: --type\\n');
    process.exit(125);
  }
  rest = rest.slice(2);
}
const format = rest[1];
const containers = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
let missing = false;
for (const target of rest.slice(2)) {
  const c = containers.find((x) => x['.Name'] === '/' + target) ||
    containers.find((x) => x['.Id'].startsWith(target));
  if (!c) {
    missing = true;
    process.stderr.write('Error response from daemon: No such container: ' + target + '\\n');
    continue;
  }
  process.stdout.write(format.replace(/\\{\\{\\s*(\\.[A-Za-z.]+)\\s*\\}\\}/g, (_, f) => c[f]) + '\\n');
}
process.exit(missing ? 1 : 0);
`
  );
  const docker = path.join(dir, 'docker');
  fs.writeFileSync(
    docker,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`
  );
  fs.chmodSync(docker, 0o755);
  const original = process.env.START_DOCKER_BIN;
  process.env.START_DOCKER_BIN = docker;
  try {
    return fn(() =>
      fs.existsSync(calls)
        ? fs
            .readFileSync(calls, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : []
    );
  } finally {
    if (original === undefined) {
      delete process.env.START_DOCKER_BIN;
    } else {
      process.env.START_DOCKER_BIN = original;
    }
  }
}

function dockerRecord(sessionName, overrides = {}) {
  return new ExecutionRecord({
    uuid: `00000243-0000-4000-8000-${sessionName.padEnd(12, '0').slice(0, 12)}`,
    command: `echo ${sessionName}`,
    status: ExecutionStatus.EXECUTED,
    exitCode: 1,
    startTime: '2026-10-20T09:00:00.000Z',
    endTime: '2026-10-20T09:01:00.000Z',
    endTimeSource: 'docker-finished-at',
    ...overrides,
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName,
      ...(overrides.options || {}),
    },
  });
}

/** One store with every kind of record `--list` handles. */
function populatedStore() {
  const store = new ExecutionStore({
    appFolder: makeTempDir('store-243-'),
    useLinks: false,
  });
  const executing = {
    status: ExecutionStatus.EXECUTING,
    exitCode: null,
    endTime: null,
    endTimeSource: undefined,
    startTime: '2026-10-20T10:00:00.000Z',
  };
  const records = {
    running: dockerRecord('run-a', executing),
    exited: dockerRecord('run-b', executing),
    kept: dockerRecord('kept-c', { options: { containerId: 'cccc3333' } }),
    gone: dockerRecord('gone-d', { options: { containerId: 'dddd4444' } }),
    removed: dockerRecord('removed-e', {
      options: { containerId: 'eeee5555' },
      containerState: 'removed',
      containerRemovedObservedAt: '2026-10-20T09:30:00.000Z',
    }),
    plain: new ExecutionRecord({
      uuid: '00000243-0000-4000-8000-000000000000',
      command: 'echo plain',
      status: ExecutionStatus.EXECUTED,
      exitCode: 0,
      startTime: '2026-10-20T08:00:00.000Z',
      endTime: '2026-10-20T08:00:01.000Z',
    }),
  };
  for (const record of Object.values(records)) {
    store.save(record);
  }
  return { store, records };
}

/** Query-time clocks, which differ between any two runs. */
const CLOCKS = new Set(['currentTime', 'containerRemovedObservedAt']);

/** Parsed JSON output without the query-time clocks. */
function stable(output) {
  return JSON.parse(output, (key, value) =>
    CLOCKS.has(key) ? undefined : value
  );
}

const inspects = (calls) => calls.filter((args) => args[0] === 'inspect');

posix('issue #243: one docker inspect per query, same output', () => {
  it('lists every docker record with one docker process', () => {
    const legacy = withFakeDocker('legacy', (readCalls) => {
      const { store } = populatedStore();
      const result = listExecutions(store, 'json');
      expect(result.success).toBe(true);
      return { output: stable(result.output), calls: inspects(readCalls()) };
    });
    const batched = withFakeDocker('batch', (readCalls) => {
      const { store } = populatedStore();
      const result = listExecutions(store, 'json');
      expect(result.success).toBe(true);
      return { output: stable(result.output), calls: inspects(readCalls()) };
    });

    // Before: one or two probes per docker record, after the rejected batch.
    expect(legacy.calls.length).toBeGreaterThan(5);
    expect(batched.calls).toHaveLength(1);
    expect(batched.calls[0].slice(0, 5)).toEqual([
      'inspect',
      '--type',
      'container',
      '-f',
      BATCH_FORMAT,
    ]);
    expect(batched.output).toEqual(legacy.output);
  });

  it('never asks docker about a container already marked removed', () => {
    withFakeDocker('batch', (readCalls) => {
      const { store, records } = populatedStore();
      listExecutions(store, 'json');
      queryStatus(store, records.removed.uuid, 'json');
      const targets = inspects(readCalls()).flatMap((args) => args.slice(5));
      expect(targets).not.toContain('removed-e');
      expect(targets).not.toContain('eeee5555');
    });
  });

  it('answers $ --status with one docker inspect', () => {
    const run = (mode) =>
      withFakeDocker(mode, (readCalls) => {
        const { store, records } = populatedStore();
        const result = queryStatus(store, records.kept.uuid, 'json');
        expect(result.success).toBe(true);
        return { output: stable(result.output), calls: inspects(readCalls()) };
      });
    const legacy = run('legacy');
    const batched = run('batch');
    expect(legacy.calls.length).toBeGreaterThanOrEqual(3);
    expect(batched.calls).toHaveLength(1);
    expect(batched.output).toEqual(legacy.output);
    expect(batched.output.processIds).toEqual({ containerId: 'cccc3333' });
  });

  it('still records a removal the batch observed', () => {
    withFakeDocker('batch', () => {
      const { store, records } = populatedStore();
      const status = stable(
        queryStatus(store, records.gone.uuid, 'json').output
      );
      expect(status.containerState).toBe('removed');
      expect(store.get(records.gone.uuid).containerState).toBe('removed');
    });
  });
});

describe('issue #243: batched inspect answers', () => {
  const row = (name, id) => `/${name} ${id} 7 true 0 false s f`;

  it('matches lines by name or ID prefix, not by order', () => {
    const answers = parseBatchInspect(
      ['beta', 'aaaa'],
      `${row('alpha', 'aaaa9999')}\n${row('beta', 'bbbb0000')}\n`,
      ''
    );
    expect(answers.get('beta')['.Id']).toBe('bbbb0000');
    expect(answers.get('aaaa')['.Name']).toBe('/alpha');
  });

  it("takes docker's not-found over another container's ID prefix", () => {
    const answers = parseBatchInspect(
      ['bbbb', 'gone'],
      `${row('beta', 'bbbb0000')}\n`,
      'Error response from daemon: No such container: gone\n'
    );
    expect(answers.get('gone')).toBeNull();
    expect(answers.has('bbbb')).toBe(true);
  });

  it('leaves targets it cannot account for to their own probe', () => {
    const answers = parseBatchInspect(
      ['x'],
      'false 1 false\n',
      'unknown flag: --type'
    );
    expect(answers.has('x')).toBe(false);
  });

  posixIt(
    'renders the per-record templates from the batch only inside a query',
    () => {
      expect(prefetchedInspect('{{.Id}}', 'kept-c')).toBeNull();
      withFakeDocker('batch', () => {
        const docker = {
          dockerCommand: process.env.START_DOCKER_BIN,
          spawnOptions: { encoding: 'utf8' },
        };
        withDockerInspectBatch(
          [dockerRecord('kept-c'), dockerRecord('nope')],
          docker,
          () => {
            expect(
              prefetchedInspect('{{.Id}} {{.State.Pid}}', 'kept-c')
            ).toEqual({
              success: true,
              status: 0,
              stdout: 'cccc3333 0\n',
              stderr: '',
            });
            expect(prefetchedInspect('{{.Config.Image}}', 'kept-c')).toBeNull();
            expect(prefetchedInspect('{{.Id}}', 'nope').stderr).toMatch(
              /No such container: nope/
            );
            expect(prefetchedInspect('{{.Id}}', 'unrelated')).toBeNull();
          }
        );
      });
      expect(prefetchedInspect('{{.Id}}', 'kept-c')).toBeNull();
    }
  );
});

describe('issue #243: the store is decoded once per content', () => {
  /** Number of store decodes `fn` caused, from the store's verbose log. */
  function countDecodes(fn) {
    const original = console.log;
    let count = 0;
    console.log = (message, ...rest) => {
      if (/^\[ExecutionStore\] Decoded the store/.test(String(message))) {
        count += 1;
        return;
      }
      if (!/^\[ExecutionStore\]/.test(String(message))) {
        original(message, ...rest);
      }
    };
    try {
      fn();
    } finally {
      console.log = original;
    }
    return count;
  }

  it('decodes once for every read of an unchanged file', () => {
    const store = new ExecutionStore({
      appFolder: makeTempDir('store-243-'),
      useLinks: false,
      verbose: true,
    });
    const record = new ExecutionRecord({ command: 'echo one', exitCode: 0 });
    countDecodes(() => store.save(record));
    forgetDecodedStore();
    const decodes = countDecodes(() => {
      expect(queryStatus(store, record.uuid, 'json').success).toBe(true);
      store.getAll();
      store.get(record.uuid);
    });
    expect(decodes).toBe(1);
  });

  it('sees every write and hands out independent copies', () => {
    const appFolder = makeTempDir('store-243-');
    const store = new ExecutionStore({ appFolder, useLinks: false });
    store.save(new ExecutionRecord({ command: 'echo one', exitCode: 0 }));
    const first = store.getAll();
    first[0].command = 'mutated';
    first[0].options.isolated = 'mutated';
    expect(store.getAll()[0].command).toBe('echo one');
    expect(store.getAll()[0].options.isolated).toBeUndefined();

    // Another store object (as another process would) writes the file.
    const other = new ExecutionStore({ appFolder, useLinks: false });
    other.save(new ExecutionRecord({ command: 'echo two', exitCode: 0 }));
    expect(
      store
        .getAll()
        .map((r) => r.command)
        .sort()
    ).toEqual(['echo one', 'echo two']);
  });

  it('keys the cache on content, not on a clock', () => {
    let decodes = 0;
    const decode = (content) => {
      decodes += 1;
      return JSON.parse(content);
    };
    const file = '/virtual/executions.lino';
    forgetDecodedStore(file);
    expect(decodeStoreContent(file, '[1]', decode).data).toEqual([1]);
    expect(decodeStoreContent(file, '[1]', decode).reused).toBe(true);
    // Same size, same instant: still decoded again.
    expect(decodeStoreContent(file, '[2]', decode).data).toEqual([2]);
    expect(decodes).toBe(2);
    expect(decodeCount(file)).toBe(2);
    forgetDecodedStore(file);
  });
});

describe('issue #243: the next process reads the decoded JSON copy', () => {
  function storeWithOneRecord() {
    const appFolder = makeTempDir('store-243-');
    const store = new ExecutionStore({ appFolder, useLinks: false });
    store.save(
      new ExecutionRecord({
        command: 'echo one',
        exitCode: 0,
        options: { isolated: 'docker', nested: { list: [1, 'a', null] } },
      })
    );
    return { appFolder, store };
  }

  it('reads the copy instead of decoding when the store is unchanged', () => {
    const { appFolder, store } = storeWithOneRecord();
    const decoded = store.getAll();
    const copy = JSON.parse(
      fs.readFileSync(path.join(appFolder, DECODED_COPY_FILE), 'utf8')
    );
    expect(copy.format).toBe(DECODED_COPY_FORMAT);
    expect(copy.sha256).toMatch(/^[0-9a-f]{64}$/);

    // A new process starts with an empty in-memory cache.
    forgetDecodedStore();
    expect(store.getAll()).toEqual(decoded);
    expect(decodeCount(store.linoDbPath)).toBe(0);
  });

  it('decodes again when the copy is of other content or damaged', () => {
    const { appFolder, store } = storeWithOneRecord();
    store.getAll();
    const copyPath = path.join(appFolder, DECODED_COPY_FILE);
    const stale = fs.readFileSync(copyPath, 'utf8');
    new ExecutionStore({ appFolder, useLinks: false }).save(
      new ExecutionRecord({ command: 'echo two', exitCode: 0 })
    );
    fs.writeFileSync(copyPath, stale);
    forgetDecodedStore();
    expect(store.getAll().map((r) => r.command)).toContain('echo two');
    expect(decodeCount(store.linoDbPath)).toBe(1);

    fs.writeFileSync(copyPath, '{not json');
    forgetDecodedStore();
    expect(store.getAll()).toHaveLength(2);
    expect(decodeCount(store.linoDbPath)).toBe(1);
  });

  it('keeps no copy of records JSON cannot represent exactly', () => {
    const copyPath = path.join(makeTempDir('store-243-'), 'copy.json');
    const file = '/virtual/unrepresentable.lino';
    decodeStoreContent(file, 'x', () => [{ when: new Date(0) }], {
      copyPath,
    });
    expect(fs.existsSync(copyPath)).toBe(false);
    forgetDecodedStore(file);
  });
});
