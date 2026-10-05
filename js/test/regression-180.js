/**
 * Regression tests for issue #180:
 *
 *   `$ --status` reported `exitReason memory-exhaustion (cgroup-oom-killer)`
 *   and `memoryExhausted true` for an ordinary exit 0/1 whenever Docker's
 *   `State.OOMKilled` flag was set. Since moby/moby#43564 that flag is
 *   container-wide and sticky: it turns on as soon as *any* process in the
 *   container is OOM-killed (a `rustc` child under `cargo test`) and stays on
 *   until the container starts again. A command that survived that and later
 *   exited 1 on its own was reported as having run out of memory.
 *
 *   The flag only explains the command's exit when that exit is 137
 *   (`128 + SIGKILL`) or unknown: the rule `isKilledExit()` applies since #178.
 */

const { describe, it, expect, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  CGROUP_OOM_EXIT_REASON,
  isOomKillOfCommand,
  resolveExitReason,
  resolveMemoryExhaustion,
} = require('../src/lib/exit-reason');
const {
  attachExitReason,
  attachMemoryExhaustion,
} = require('../src/lib/status-formatter');
const { finalizeDetachedExecution } = require('../src/lib/detached-finalize');
const { buildAttachedDockerKeptMessage } = require('../src/lib/docker-cleanup');
const {
  ExecutionStore,
  ExecutionRecord,
  ExecutionStatus,
} = require('../src/lib/execution-store');

const OOM_REASON = 'Docker reported State.OOMKilled=true';

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

function finishedRecord(fields) {
  const record = new ExecutionRecord({
    status: ExecutionStatus.EXECUTED,
    command: 'cargo test',
    logPath: null,
  });
  return Object.assign(record, fields);
}

describe('issue #180: the sticky OOMKilled flag is not an exit reason', () => {
  // The reproduction table from the issue, plus the watcher's unknown exit.
  const CASES = [
    { exitCode: 0, oomKilled: true, reason: null, memory: false },
    { exitCode: 1, oomKilled: true, reason: null, memory: false },
    { exitCode: 1, oomKilled: false, reason: null, memory: false },
    {
      exitCode: 137,
      oomKilled: true,
      reason: CGROUP_OOM_EXIT_REASON,
      memory: true,
    },
    {
      exitCode: 137,
      oomKilled: false,
      reason: 'signal (SIGKILL)',
      memory: false,
    },
    {
      exitCode: -1,
      oomKilled: true,
      reason: CGROUP_OOM_EXIT_REASON,
      memory: true,
    },
    {
      exitCode: 139,
      oomKilled: true,
      reason: 'signal (SIGSEGV)',
      memory: false,
    },
  ];

  for (const { exitCode, oomKilled, reason, memory } of CASES) {
    it(`exit ${exitCode} with oomKilled=${oomKilled}`, () => {
      expect(resolveExitReason({ exitCode, oomKilled })).toBe(reason);
      expect(resolveMemoryExhaustion({ exitCode, oomKilled })).toEqual(
        memory
          ? { memoryExhausted: true, memoryExhaustedReason: OOM_REASON }
          : null
      );
    });
  }

  it('blames the flag on the command only for SIGKILL or an unknown exit', () => {
    expect(isOomKillOfCommand({ exitCode: 137, oomKilled: true })).toBe(true);
    expect(isOomKillOfCommand({ exitCode: null, oomKilled: true })).toBe(true);
    expect(isOomKillOfCommand({ exitCode: -1, oomKilled: true })).toBe(true);
    expect(isOomKillOfCommand({ exitCode: 0, oomKilled: true })).toBe(false);
    expect(isOomKillOfCommand({ exitCode: 1, oomKilled: true })).toBe(false);
    expect(isOomKillOfCommand({ exitCode: 137, oomKilled: false })).toBe(false);
    expect(isOomKillOfCommand(null)).toBe(false);
  });

  it('still trusts a memory marker the command printed itself', () => {
    const logTail =
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';
    expect(resolveExitReason({ exitCode: 1, oomKilled: true, logTail })).toBe(
      'memory-exhaustion (v8-heap-limit)'
    );
    expect(
      resolveMemoryExhaustion({ exitCode: 1, oomKilled: true, logTail })
        .memoryExhausted
    ).toBe(true);
  });

  it('reports the incident record without a memory verdict', () => {
    const record = finishedRecord({ exitCode: 1, oomKilled: true });
    const enriched = attachMemoryExhaustion(
      attachExitReason(record, 'Failed to authenticate: OAuth session expired'),
      'Failed to authenticate: OAuth session expired'
    );
    expect(enriched.oomKilled).toBe(true);
    expect(enriched.exitReason).toBeUndefined();
    expect(enriched.memoryExhausted).toBeUndefined();
  });

  it('drops a stale cgroup reason stored before the fix', () => {
    const record = finishedRecord({
      exitCode: 1,
      oomKilled: true,
      exitReason: CGROUP_OOM_EXIT_REASON,
    });
    const enriched = attachExitReason(record, null);
    expect(enriched.exitReason).toBeUndefined();
    expect(record.exitReason).toBe(CGROUP_OOM_EXIT_REASON);
  });

  it('the finalizer does not record the flag as the reason for exit 1', () => {
    const appFolder = makeTempDir('finalize-180-');
    const store = new ExecutionStore({ appFolder, useLinks: false });
    const record = new ExecutionRecord({
      status: ExecutionStatus.EXECUTING,
      command: 'cargo test',
      logPath: null,
      options: { isolated: 'docker', isolationMode: 'detached' },
    });
    store.save(record);

    finalizeDetachedExecution({
      store,
      executionId: record.uuid,
      exitCode: '1',
      oomKilled: 'true',
      startedAt: '2026-10-01T19:00:00Z',
      finishedAt: '2026-10-01T19:41:00Z',
      running: 'false',
    });

    const stored = store.get(record.uuid);
    expect(stored.exitCode).toBe(1);
    expect(stored.oomKilled).toBe(true);
    expect(stored.exitReason).toBeUndefined();
  });

  it('the attached kept message names a child OOM kill, not the command', () => {
    const child = buildAttachedDockerKeptMessage({
      containerName: 'c',
      exitCode: 1,
      oomKilled: true,
      logPath: null,
    });
    expect(child).toContain('a process in it was OOM-killed');
    expect(child).not.toContain('Memory exhaustion detected');

    const main = buildAttachedDockerKeptMessage({
      containerName: 'c',
      exitCode: 137,
      oomKilled: true,
      logPath: null,
    });
    expect(main).toContain('Docker reports it was OOM-killed.');
  });
});
