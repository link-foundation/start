/**
 * Regression tests for issue #165.
 *
 * A runtime that aborts on its own heap limit (`FATAL ERROR: Reached heap limit
 * ...`) dies below the container limit, so every container signal `start`
 * consults is correct and useless: `State.OOMKilled` is `false` and the cgroup
 * `oom_kill` counter is `0`. The only evidence is what the runtime printed into
 * the log, which is why `--status` now carries `memoryExhausted` /
 * `memoryExhaustedReason` alongside `oomKilled`, and why the kept-container
 * footer no longer asserts a bare `oomKilled=false` next to a fatal marker.
 */

const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ExecutionRecord,
  ExecutionStore,
} = require('../src/lib/execution-store');
const {
  buildAttachedDockerKeptMessage,
  buildDetachedDockerCompletionScript,
  buildDockerKeptReasonSnippet,
} = require('../src/lib/docker-cleanup');

const TEST_APP_FOLDER = path.join(
  os.tmpdir(),
  `regression-165-${process.pid}-${Date.now()}`
);
const CLI_PATH = path.join(__dirname, '../src/bin/cli.js');

const HEAP_LIMIT_MARKER =
  'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';

function cleanupTestDir() {
  fs.rmSync(TEST_APP_FOLDER, { recursive: true, force: true });
}

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, START_APP_FOLDER: TEST_APP_FOLDER },
    timeout: 20000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

/**
 * Write a log that ends the way the incident log does: command output, the
 * dying runtime's fatal marker, an optional native stack trace, and the
 * terminal footer `start` appends itself.
 */
function writeOomLog(
  name,
  { stackTraceBytes = 0, marker = HEAP_LIMIT_MARKER }
) {
  const logPath = path.join(TEST_APP_FOLDER, name);
  const stackFrame =
    ' 1: 0x757658 node::OOMErrorHandler(char const*, v8::OOMDetails const&) [node]\n';
  const frames = stackTraceBytes
    ? stackFrame.repeat(Math.ceil(stackTraceBytes / stackFrame.length))
    : '';
  fs.writeFileSync(
    logPath,
    [
      'building...',
      '',
      '<--- Last few GCs --->',
      '[1:0xa485000]  790 ms: Mark-Compact 66.6 (99.8) -> 64.4 (194.2) MB',
      '',
      marker,
      '----- Native stack trace -----',
      frames,
      'Docker container "docker-165" exited with code 139',
      'Container kept because the command failed.',
      '',
      '==================================================',
      'Finished: 2026-09-03 08:14:20.707',
      'Exit Code: 139',
      '',
    ].join('\n'),
    'utf8'
  );
  return logPath;
}

function saveRecord(store, overrides = {}) {
  const record = new ExecutionRecord({
    command: overrides.command || 'node build.mjs',
    pid: 4242,
    logPath: overrides.logPath || null,
    workingDirectory: '/tmp',
    shell: '/bin/bash',
    options: overrides.options || {},
  });
  if (overrides.exitCode !== undefined) {
    record.complete(overrides.exitCode);
  }
  store.save(record);
  return record;
}

function statusJson(uuid) {
  const result = runCli(['--status', uuid, '--output-format', 'json']);
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout);
}

describe('Issue #165: memory exhaustion observed from the log', () => {
  let store;

  beforeEach(() => {
    cleanupTestDir();
    fs.mkdirSync(TEST_APP_FOLDER, { recursive: true });
    store = new ExecutionStore({
      appFolder: TEST_APP_FOLDER,
      useLinks: false,
    });
  });

  afterEach(() => {
    cleanupTestDir();
  });

  it('reports memoryExhausted for an attached docker session that self-aborted', () => {
    const record = saveRecord(store, {
      logPath: writeOomLog('attached.log', {}),
      exitCode: 139,
      options: { isolated: 'docker', isolationMode: 'attached' },
    });

    const parsed = statusJson(record.uuid);

    expect(parsed.exitCode).toBe(139);
    // The container flag is still absent/false — the observation does not
    // contradict it, it complements it.
    expect(parsed.oomKilled).toBeUndefined();
    expect(parsed.memoryExhausted).toBe(true);
    expect(parsed.memoryExhaustedReason).toBe(HEAP_LIMIT_MARKER);
    expect(parsed.exitReason).toBe('memory-exhaustion (v8-heap-limit)');
  });

  it('finds a marker pushed far from EOF by the native stack trace', () => {
    const logPath = writeOomLog('long-trace.log', {
      stackTraceBytes: 40 * 1024,
    });
    expect(fs.statSync(logPath).size).toBeGreaterThan(32 * 1024);
    const record = saveRecord(store, { logPath, exitCode: 134 });

    const parsed = statusJson(record.uuid);

    expect(parsed.memoryExhausted).toBe(true);
    expect(parsed.memoryExhaustedReason).toBe(HEAP_LIMIT_MARKER);
  });

  it('detects a Rust allocation failure', () => {
    const record = saveRecord(store, {
      logPath: writeOomLog('rust.log', {
        marker: 'memory allocation of 1073741824 bytes failed',
      }),
      exitCode: 134,
    });

    const parsed = statusJson(record.uuid);

    expect(parsed.memoryExhausted).toBe(true);
    expect(parsed.memoryExhaustedReason).toBe(
      'memory allocation of 1073741824 bytes failed'
    );
  });

  it('never turns a clean run into a reported memory failure', () => {
    // The marker is present in the output — the command merely printed it —
    // but the run succeeded, so there is nothing to explain (issue #151's rule:
    // an observation, never a verdict).
    const logPath = path.join(TEST_APP_FOLDER, 'quoted.log');
    fs.writeFileSync(
      logPath,
      [
        `grep found: ${HEAP_LIMIT_MARKER}`,
        '==================================================',
        'Finished: 2026-09-03 08:14:20.707',
        'Exit Code: 0',
        '',
      ].join('\n'),
      'utf8'
    );
    const record = saveRecord(store, { logPath, exitCode: 0 });

    const parsed = statusJson(record.uuid);

    expect(parsed.exitCode).toBe(0);
    expect(parsed.memoryExhausted).toBeUndefined();
    expect(parsed.memoryExhaustedReason).toBeUndefined();
  });

  it('leaves an ordinary failure without a memory observation', () => {
    const logPath = path.join(TEST_APP_FOLDER, 'plain-failure.log');
    fs.writeFileSync(logPath, 'error: missing file\n', 'utf8');
    const record = saveRecord(store, { logPath, exitCode: 1 });

    const parsed = statusJson(record.uuid);

    expect(parsed.memoryExhausted).toBeUndefined();
  });

  it('shows the observation in the human-readable and links-notation output', () => {
    const record = saveRecord(store, {
      logPath: writeOomLog('formats.log', {}),
      exitCode: 139,
    });

    const text = runCli(['--status', record.uuid, '--output-format', 'text']);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('Memory Exhausted:  true');
    expect(text.stdout).toContain(`Memory Evidence:   ${HEAP_LIMIT_MARKER}`);

    const lino = runCli(['--status', record.uuid]);
    expect(lino.exitCode).toBe(0);
    expect(lino.stdout).toContain('memoryExhausted true');
    expect(lino.stdout).toContain('memoryExhaustedReason');
  });
});

describe('Issue #165: kept-container footer', () => {
  const evaluateReason = (exitCode, oomKilled) => {
    const snippet = buildDockerKeptReasonSnippet();
    const result = spawnSync(
      'sh',
      [
        '-c',
        `__start_command_exit=${exitCode}; __start_command_oom=${oomKilled}; ${snippet}; printf '%s' "$__start_command_reason"`,
      ],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(0);
    return result.stdout;
  };

  it('does not assert a bare oomKilled=false for a self-abort exit code', () => {
    for (const exitCode of [134, 139]) {
      const reason = evaluateReason(exitCode, 'false');
      expect(reason).toContain(`exitCode=${exitCode} oomKilled=false`);
      expect(reason).toContain('invisible to this flag');
    }
  });

  it('keeps the plain reason for other exit codes and for a real OOM kill', () => {
    expect(evaluateReason(1, 'false')).toBe('exitCode=1 oomKilled=false');
    expect(evaluateReason(137, 'true')).toBe('exitCode=137 oomKilled=true');
  });

  it('embeds the reason computation in the detached completion script', () => {
    const script = buildDetachedDockerCompletionScript(
      'container-165',
      'default',
      '/tmp/regression-165.log'
    );
    expect(script).toContain('__start_command_reason=');
    expect(script).toContain('Reason: %s');
  });
});

describe('Issue #165: attached kept-container message', () => {
  beforeEach(() => {
    cleanupTestDir();
    fs.mkdirSync(TEST_APP_FOLDER, { recursive: true });
  });

  afterEach(() => {
    cleanupTestDir();
  });

  it('names the evidence the runtime printed into the log', () => {
    const message = buildAttachedDockerKeptMessage({
      containerName: 'container-165',
      exitCode: 139,
      oomKilled: false,
      logPath: writeOomLog('attached-message.log', {}),
    });

    expect(message).toContain('Container kept because the command failed.');
    expect(message).toContain(
      `Memory exhaustion detected in the log: ${HEAP_LIMIT_MARKER}`
    );
    expect(message).toContain('Remove when done: docker rm -f container-165');
  });

  it('stays silent for an ordinary failure', () => {
    const logPath = path.join(TEST_APP_FOLDER, 'attached-plain.log');
    fs.writeFileSync(logPath, 'error: missing file\n', 'utf8');

    const message = buildAttachedDockerKeptMessage({
      containerName: 'container-165',
      exitCode: 1,
      oomKilled: false,
      logPath,
    });

    expect(message).not.toContain('Memory exhaustion');
  });
});
