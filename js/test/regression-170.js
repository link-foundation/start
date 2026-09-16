/**
 * Regression tests for issue #170: detached Docker executions never persist a
 * terminal state, and `--status` fabricates `endTime` with `new Date()`.
 *
 * The three defects covered here:
 *   170.1 the detached completion watcher must write the terminal state back
 *         into the store instead of leaving the record `executing` forever;
 *   170.2 `--status` must derive `endTime` from a real clock
 *         (`State.FinishedAt` -> log footer `Finished:`) and mark the
 *         provenance via `endTimeSource` when it falls back to observation time;
 *   170.3 `cleanupStale()` must record `staleDetectedAt`, not a fabricated
 *         finish time.
 */

const { describe, it, expect, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  ExecutionStore,
  ExecutionRecord,
  ExecutionStatus,
} = require('../src/lib/execution-store');
const { resolveDetachedStatus } = require('../src/lib/status-formatter');
const {
  buildDetachedDockerCompletionScript,
} = require('../src/lib/docker-cleanup');
const { finalizeDetachedExecution } = require('../src/lib/detached-finalize');

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

/**
 * A fake `docker` that answers `inspect` with a fixed state line, whatever the
 * `-f` template asks for. The template is echoed verbatim by the caller, so the
 * test controls exactly how many fields the formatter has to cope with.
 */
function withFakeDockerInspect(stateLine, fn) {
  const fakeBin = makeTempDir('fake-docker-170-');
  const dockerPath = path.join(fakeBin, 'docker');
  createExecutable(
    dockerPath,
    [
      '#!/bin/sh',
      '[ "$1" = "inspect" ] || exit 1',
      `echo "${stateLine}"`,
      '',
    ].join('\n')
  );
  const originalPath = process.env.PATH;
  const originalDockerBin = process.env.START_DOCKER_BIN;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ''}`;
  process.env.START_DOCKER_BIN = dockerPath;
  try {
    return fn();
  } finally {
    process.env.PATH = originalPath;
    if (originalDockerBin === undefined) {
      delete process.env.START_DOCKER_BIN;
    } else {
      process.env.START_DOCKER_BIN = originalDockerBin;
    }
  }
}

function withFakeDockerMissingContainer(fn) {
  const fakeBin = makeTempDir('fake-docker-gone-170-');
  const dockerPath = path.join(fakeBin, 'docker');
  createExecutable(dockerPath, ['#!/bin/sh', 'exit 1', ''].join('\n'));
  const originalPath = process.env.PATH;
  const originalDockerBin = process.env.START_DOCKER_BIN;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ''}`;
  process.env.START_DOCKER_BIN = dockerPath;
  try {
    return fn();
  } finally {
    process.env.PATH = originalPath;
    if (originalDockerBin === undefined) {
      delete process.env.START_DOCKER_BIN;
    } else {
      process.env.START_DOCKER_BIN = originalDockerBin;
    }
  }
}

function detachedDockerRecord(overrides = {}) {
  return new ExecutionRecord({
    pid: null,
    status: ExecutionStatus.EXECUTING,
    exitCode: null,
    command: 'sleep 100',
    startTime: '2026-09-15T22:21:40.000Z',
    endTime: null,
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: 'start-command-170',
    },
    ...overrides,
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('issue #170.2: endTime is never fabricated silently', () => {
  it('derives endTime from docker State.FinishedAt for a stopped container', () => {
    const record = detachedDockerRecord();
    const enriched = withFakeDockerInspect(
      'false 137 false 2026-09-15T22:21:40.942007645Z 2026-09-15T22:21:46.740817278Z',
      () => resolveDetachedStatus(record, null)
    );

    expect(enriched.status).toBe('executed');
    expect(enriched.exitCode).toBe(137);
    expect(enriched.endTimeSource).toBe('docker-finished-at');
    expect(new Date(enriched.endTime).toISOString()).toBe(
      '2026-09-15T22:21:46.740Z'
    );
  });

  it('falls back to the log footer Finished: line when docker is gone', () => {
    const record = detachedDockerRecord();
    const tail = [
      'output line',
      '='.repeat(50),
      'Finished: 2026-09-15 22:21:46.740',
      'Exit Code: 137',
      '',
    ].join('\n');

    const enriched = withFakeDockerMissingContainer(() =>
      resolveDetachedStatus(record, tail)
    );

    expect(enriched.status).toBe('executed');
    expect(enriched.exitCode).toBe(137);
    expect(enriched.endTimeSource).toBe('log-footer');
    expect(new Date(enriched.endTime).toISOString()).toBe(
      '2026-09-15T22:21:46.740Z'
    );
  });

  it('marks the observation-time fallback instead of pretending it is a finish time', () => {
    const record = detachedDockerRecord();
    const tail = [
      '='.repeat(50),
      'Finished: not-a-timestamp',
      'Exit Code: 3',
      '',
    ].join('\n');

    const enriched = withFakeDockerMissingContainer(() =>
      resolveDetachedStatus(record, tail)
    );

    expect(enriched.status).toBe('executed');
    expect(enriched.exitCode).toBe(3);
    expect(enriched.endTimeSource).toBe('observed-at');
    expect(enriched.observedAt).toBe(enriched.endTime);
  });

  it('keeps an already recorded endTime and marks it as persisted', () => {
    const record = detachedDockerRecord({
      status: ExecutionStatus.EXECUTED,
      exitCode: 0,
      endTime: '2026-09-15T22:21:46.740Z',
      endTimeSource: 'docker-finished-at',
    });

    const enriched = withFakeDockerInspect('false 0 false', () =>
      resolveDetachedStatus(record, null)
    );

    expect(enriched.endTime).toBe('2026-09-15T22:21:46.740Z');
    expect(enriched.endTimeSource).toBe('docker-finished-at');
  });
});

describe('issue #170.3: cleanupStale records the detection time', () => {
  it('sets staleDetectedAt and leaves endTime unknown', () => {
    const appFolder = makeTempDir('stale-170-');
    const store = new ExecutionStore({ appFolder, useLinks: false });

    const record = new ExecutionRecord({
      pid: 999999,
      status: ExecutionStatus.EXECUTING,
      command: 'sleep 1000',
      startTime: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });
    store.save(record);

    const result = store.cleanupStale({ maxAge: 1000 });
    expect(result.cleaned).toBe(1);

    const cleaned = store.get(record.uuid);
    expect(cleaned.status).toBe(ExecutionStatus.EXECUTED);
    expect(cleaned.exitCode).toBe(-1);
    expect(cleaned.endTime).toBeNull();
    expect(typeof cleaned.staleDetectedAt).toBe('string');
    expect(Number.isNaN(Date.parse(cleaned.staleDetectedAt))).toBe(false);
  });
});

describe('issue #170.1: the detached watcher persists the terminal state', () => {
  it('invokes the finalizer with the inspected docker facts', () => {
    const script = buildDetachedDockerCompletionScript(
      'start-command-170',
      'default',
      '/tmp/start-command-170.log',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );

    expect(script).toContain('detached-finalize');
    expect(script).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(script).toContain('$__start_command_exit');
    expect(script).toContain('$__start_command_finished');
  });

  it('stays backward compatible when no execution id is supplied', () => {
    const script = buildDetachedDockerCompletionScript(
      'start-command-170',
      'default',
      '/tmp/start-command-170.log'
    );
    expect(script).not.toContain('detached-finalize');
  });

  it('writes status, exitCode, endTime and provenance into the store', () => {
    const appFolder = makeTempDir('finalize-170-');
    const store = new ExecutionStore({ appFolder, useLinks: false });
    const record = detachedDockerRecord();
    store.save(record);

    const outcome = finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      exitCode: 137,
      oomKilled: false,
      startedAt: '2026-09-15T22:21:40.942007645Z',
      finishedAt: '2026-09-15T22:21:46.740817278Z',
      containerError: '',
    });

    expect(outcome.updated).toBe(true);

    const stored = store.get(record.uuid);
    expect(stored.status).toBe(ExecutionStatus.EXECUTED);
    expect(stored.exitCode).toBe(137);
    expect(stored.oomKilled).toBe(false);
    expect(stored.endTimeSource).toBe('docker-finished-at');
    expect(new Date(stored.endTime).toISOString()).toBe(
      '2026-09-15T22:21:46.740Z'
    );
    expect(stored.exitReason).toContain('SIGKILL');
  });

  it('falls back to observation time when docker reports no finish time', () => {
    const appFolder = makeTempDir('finalize-170-zero-');
    const store = new ExecutionStore({ appFolder, useLinks: false });
    const record = detachedDockerRecord();
    store.save(record);

    finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      exitCode: 0,
      oomKilled: false,
      startedAt: 'unknown',
      finishedAt: '0001-01-01T00:00:00Z',
      containerError: '',
    });

    const stored = store.get(record.uuid);
    expect(stored.status).toBe(ExecutionStatus.EXECUTED);
    expect(stored.exitCode).toBe(0);
    expect(stored.endTimeSource).toBe('observed-at');
    expect(stored.observedAt).toBe(stored.endTime);
    expect(new Date(stored.endTime).getUTCFullYear()).toBeGreaterThan(2000);
  });

  it('never fails when the record is gone', () => {
    const appFolder = makeTempDir('finalize-170-missing-');
    const store = new ExecutionStore({ appFolder, useLinks: false });
    const outcome = finalizeDetachedExecution({
      store,
      executionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      exitCode: 1,
    });
    expect(outcome.updated).toBe(false);
    expect(outcome.reason).toBe('record-not-found');
  });
});
