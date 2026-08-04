#!/usr/bin/env bun
/**
 * Regression tests for issue #150:
 * "`$ --status` fabricates a detached session exit code from the command's own
 *  output (unanchored `Exit Code:` scan over the whole log)"
 *
 * The exit code of a detached session used to be derived from an *unanchored*
 * `Exit Code: N` scan over the *whole* session log. Any text the wrapped
 * command printed that merely contained the substring `Exit Code: N` was
 * indistinguishable from the terminal footer `start` appends itself, so
 * `$ --status` could report an exit code the command never produced.
 *
 * The fix anchors the scan on the three-line footer block `start` writes
 * (separator / `Finished:` / `Exit Code:`) and only reads the tail of the log,
 * where the footer always is.
 *
 * Reference: https://github.com/link-foundation/start/issues/150
 */

const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ExecutionRecord } = require('../src/lib/execution-store');
const {
  readExitCodeFromLog,
  readLogTail,
  enrichDetachedStatus,
} = require('../src/lib/status-formatter');

const SEPARATOR = '='.repeat(50);

function realFooter(exitCode) {
  return `\n${SEPARATOR}\nFinished: 2026-07-30 23:36:20.295\nExit Code: ${exitCode}\n`;
}

describe('anchored log footer parsing (issue #150)', () => {
  let tempDir;
  let logPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-150-'));
    logPath = path.join(tempDir, 'session.log');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('ignores an `Exit Code:` substring inside the command output', () => {
    // Exactly the payload from the incident: an older session log dumped by
    // `rg -n` into the JSON output of the running command.
    fs.writeFileSync(
      logPath,
      '{"type":"item.completed","item":{"aggregated_output":' +
        '"40-==================================================\\n41-Finished: 2026-07-28 20:04:52.316\\n42-Exit Code: 1\\n",' +
        '"exit_code":0,"status":"completed"}}\n'
    );
    expect(readExitCodeFromLog(logPath)).toBeNull();
  });

  it('ignores a bare `Exit Code:` line without the footer block around it', () => {
    fs.writeFileSync(logPath, 'Exit Code: 1\nstill running\n');
    expect(readExitCodeFromLog(logPath)).toBeNull();
  });

  it('ignores an `Exit Code:` substring in the middle of a line', () => {
    fs.writeFileSync(
      logPath,
      `${SEPARATOR}\nFinished: now\nlog: Exit Code: 3\n`
    );
    expect(readExitCodeFromLog(logPath)).toBeNull();
  });

  it('reads the real footer that `start` appends', () => {
    fs.writeFileSync(logPath, `hello\n${realFooter(0)}`);
    expect(readExitCodeFromLog(logPath)).toBe(0);
  });

  it('reads the real footer even when the output forged one earlier', () => {
    fs.writeFileSync(
      logPath,
      `${SEPARATOR}\nFinished: fake\nExit Code: 1\n${realFooter(0)}`
    );
    // The last anchored footer wins - here the genuine one, appended last.
    expect(readExitCodeFromLog(logPath)).toBe(0);
  });

  it('reads negative and multi-digit codes, and tolerates CRLF logs', () => {
    fs.writeFileSync(
      logPath,
      `${SEPARATOR}\r\nFinished: t\r\nExit Code: 137\r\n`
    );
    expect(readExitCodeFromLog(logPath)).toBe(137);
    fs.writeFileSync(logPath, realFooter(-1));
    expect(readExitCodeFromLog(logPath)).toBe(-1);
  });

  it('returns null for a log without a footer and for a missing file', () => {
    fs.writeFileSync(logPath, 'still running, no footer yet\n');
    expect(readExitCodeFromLog(logPath)).toBeNull();
    expect(readExitCodeFromLog(path.join(tempDir, 'missing.log'))).toBeNull();
    expect(readExitCodeFromLog(null)).toBeNull();
  });

  it('finds the footer at the end of a large log without reading it all', () => {
    fs.writeFileSync(
      logPath,
      `${'x'.repeat(2 * 1024 * 1024)}\n${realFooter(42)}`
    );
    expect(readExitCodeFromLog(logPath)).toBe(42);
    // Only the tail is read, so an `Exit Code:` far from the end is invisible.
    const tail = readLogTail(logPath);
    expect(tail.length).toBeLessThan(32 * 1024);
  });

  it('drops the partial first line of the tail so it cannot be a line start', () => {
    const filler = 'y'.repeat(32 * 1024);
    fs.writeFileSync(
      logPath,
      `${filler}${SEPARATOR}\nFinished: t\nExit Code: 7\n`
    );
    // The separator is a line *continuation* (the line starts with the filler),
    // so it is not a footer even though the tail slice may begin mid-line.
    expect(readExitCodeFromLog(logPath)).toBeNull();
  });
});

describe('detached status is not derailed by forged output (issue #150)', () => {
  let tempDir;
  let logPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-150-enrich-'));
    logPath = path.join(tempDir, 'session.log');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeRecord() {
    return new ExecutionRecord({
      command: 'solve.mjs',
      logPath,
      options: {
        // A container name that cannot be inspected: liveness is unknown, the
        // exact window in which the incident happened.
        sessionName: `issue150-absent-${process.pid}-${Date.now()}`,
        isolated: 'docker',
        isolationMode: 'detached',
      },
    });
  }

  it('keeps an executing record executing when only the output claims an exit code', () => {
    fs.writeFileSync(
      logPath,
      '{"aggregated_output":"41-Finished: x\\n42-Exit Code: 1\\n","exit_code":0}\n'
    );
    const enriched = enrichDetachedStatus(makeRecord());
    expect(enriched.status).toBe('executing');
    expect(enriched.exitCode).toBeNull();
    expect(enriched.endTime).toBeNull();
  });

  it('marks the record executed once the genuine footer is appended', () => {
    fs.writeFileSync(
      logPath,
      `{"aggregated_output":"42-Exit Code: 1\\n"}\n${realFooter(0)}`
    );
    const enriched = enrichDetachedStatus(makeRecord());
    expect(enriched.status).toBe('executed');
    expect(enriched.exitCode).toBe(0);
    expect(enriched.endTime).not.toBeNull();
  });
});
