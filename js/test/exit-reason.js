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
  detectMemoryMarker,
  resolveExitReason,
  resolveMemoryExhaustion,
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

  it('should detect other runtimes reporting their own exhaustion', () => {
    assert.strictEqual(
      detectExitReason('fatal error: runtime: out of memory'),
      'memory-exhaustion (go-runtime)'
    );
    assert.strictEqual(
      detectExitReason('Array buffer allocation failed'),
      'memory-exhaustion (allocation-failure)'
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
      logTail:
        'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
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

describe('detectMemoryMarker', () => {
  it('should return the whole line carrying the marker', () => {
    const tail = [
      '<--- Last few GCs --->',
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      '----- Native stack trace -----',
    ].join('\n');

    assert.deepStrictEqual(detectMemoryMarker(tail), {
      reason: 'memory-exhaustion (v8-heap-limit)',
      line: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    });
  });

  it('should bound an absurdly long line', () => {
    const marker = detectMemoryMarker(
      `${'x'.repeat(5000)} JavaScript heap out of memory`
    );

    assert.ok(marker.line.length <= 304);
    assert.ok(marker.line.endsWith('...'));
  });
});

describe('resolveMemoryExhaustion', () => {
  const marker =
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';

  it('should report the evidence for an abnormal exit', () => {
    assert.deepStrictEqual(
      resolveMemoryExhaustion({
        exitCode: 139,
        logTail: `working\n${marker}\n`,
        oomKilled: false,
      }),
      { memoryExhausted: true, memoryExhaustedReason: marker }
    );
  });

  it('should fall back to the container flag when the log says nothing', () => {
    assert.deepStrictEqual(
      resolveMemoryExhaustion({
        exitCode: 137,
        logTail: 'killed\n',
        oomKilled: true,
      }),
      {
        memoryExhausted: true,
        memoryExhaustedReason: 'Docker reported State.OOMKilled=true',
      }
    );
  });

  it('should stay silent for a clean or unfinished run', () => {
    // An observation, never a verdict (#151): a log that merely quotes the
    // marker cannot turn a successful run into a memory failure.
    assert.strictEqual(
      resolveMemoryExhaustion({ exitCode: 0, logTail: marker }),
      null
    );
    assert.strictEqual(
      resolveMemoryExhaustion({ exitCode: null, logTail: marker }),
      null
    );
  });

  it('should stay silent for an ordinary failure', () => {
    assert.strictEqual(
      resolveMemoryExhaustion({
        exitCode: 1,
        logTail: 'error: file not found\n',
        oomKilled: false,
      }),
      null
    );
    assert.strictEqual(resolveMemoryExhaustion(null), null);
  });
});
