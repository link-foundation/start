#!/usr/bin/env bun
/**
 * Unit tests for exit-reason detection (issue #162).
 *
 * `exitCode 139` with `oomKilled false` is not actionable on its own: the
 * kernel/cgroup OOM flag is unset when the process aborts itself after hitting
 * a runtime memory limit. The log almost always carries the real cause, so the
 * footer scan surfaces it as `exitReason`.
 */

const { describe, it } = require('node:test');
const assert = require('assert');

const {
  detectExitReason,
  resolveExitReason,
  signalNameForExitCode,
} = require('../src/lib/exit-reason');

describe('detectExitReason', () => {
  it('should detect the V8 heap limit marker from the incident log', () => {
    const tail = [
      'some command output',
      '',
      '<--- Last few GCs --->',
      '',
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      '',
      '==================================================',
      'Finished: 2026-09-01 12:00:00.000',
      'Exit Code: 139',
    ].join('\n');

    assert.strictEqual(
      detectExitReason(tail),
      'memory-exhaustion (v8-heap-limit)'
    );
  });

  it('should detect a bare JavaScript heap out of memory line', () => {
    assert.strictEqual(
      detectExitReason('JavaScript heap out of memory\n'),
      'memory-exhaustion (v8-heap-limit)'
    );
  });

  it('should detect the kernel OOM killer marker', () => {
    assert.strictEqual(
      detectExitReason('Out of memory: Killed process 4242 (bun)\n'),
      'memory-exhaustion (kernel-oom-killer)'
    );
  });

  it('should detect allocation failures', () => {
    assert.strictEqual(
      detectExitReason('terminate called after throwing std::bad_alloc'),
      'memory-exhaustion (allocation-failure)'
    );
    assert.strictEqual(
      detectExitReason('memory allocation of 1048576 bytes failed'),
      'memory-exhaustion (allocation-failure)'
    );
  });

  it('should not invent a reason for ordinary output', () => {
    assert.strictEqual(detectExitReason('all tests passed\n'), null);
    assert.strictEqual(detectExitReason(''), null);
    assert.strictEqual(detectExitReason(null), null);
  });
});

describe('signalNameForExitCode', () => {
  it('should map 139 to SIGSEGV', () => {
    assert.strictEqual(signalNameForExitCode(139), 'SIGSEGV');
  });

  it('should map 137 to SIGKILL', () => {
    assert.strictEqual(signalNameForExitCode(137), 'SIGKILL');
  });

  it('should ignore ordinary exit codes', () => {
    assert.strictEqual(signalNameForExitCode(0), null);
    assert.strictEqual(signalNameForExitCode(1), null);
    assert.strictEqual(signalNameForExitCode(-1), null);
    assert.strictEqual(signalNameForExitCode(null), null);
  });
});

describe('resolveExitReason', () => {
  it('should prefer the log marker over the signal fallback', () => {
    const reason = resolveExitReason({
      exitCode: 139,
      logTail: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      oomKilled: false,
    });
    assert.strictEqual(reason, 'memory-exhaustion (v8-heap-limit)');
  });

  it('should report the cgroup OOM observation when there is no marker', () => {
    const reason = resolveExitReason({ exitCode: 137, oomKilled: true });
    assert.strictEqual(reason, 'memory-exhaustion (cgroup-oom-killer)');
  });

  it('should fall back to the signal name for signal exit codes', () => {
    assert.strictEqual(
      resolveExitReason({ exitCode: 139, oomKilled: false }),
      'signal (SIGSEGV)'
    );
  });

  it('should return null when nothing is known', () => {
    assert.strictEqual(resolveExitReason({ exitCode: 0 }), null);
    assert.strictEqual(resolveExitReason({}), null);
    assert.strictEqual(resolveExitReason(null), null);
  });
});
