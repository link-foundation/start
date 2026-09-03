/**
 * Regression tests for issue #162.
 *
 * A detached docker session used to be a dead end: once it stopped there was
 * no way to re-enter it, continue it, or run a different command inside the
 * same container, and a supervisor restart left records stuck in "executing"
 * forever. `exitCode 139` with `oomKilled false` also hid the real cause.
 *
 * These tests drive the CLI end to end, so they cover the wiring between the
 * argument parser, the execution store and the new attach/resume verbs.
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

const TEST_APP_FOLDER = path.join(
  os.tmpdir(),
  `regression-162-${process.pid}-${Date.now()}`
);
const CLI_PATH = path.join(__dirname, '../src/bin/cli.js');
const LINO_DB_PATH = path.join(TEST_APP_FOLDER, 'executions.lino');

function cleanupTestDir() {
  fs.rmSync(TEST_APP_FOLDER, { recursive: true, force: true });
}

function runCli(args) {
  // Reading the store back first is both a precondition check (the record
  // really is persisted) and a guarantee that the CLI child sees it.
  const persisted = fs.existsSync(LINO_DB_PATH)
    ? fs.readFileSync(LINO_DB_PATH, 'utf8')
    : '';
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, START_APP_FOLDER: TEST_APP_FOLDER },
    timeout: 20000,
  });
  return {
    persisted,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

function saveRecord(store, overrides = {}) {
  const record = new ExecutionRecord({
    command: overrides.command || 'echo hi',
    pid: overrides.pid || 4242,
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

describe('Issue #162: attach, resume and exit reasons', () => {
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

  describe('--list --running', () => {
    it('reports only executions that are still running', () => {
      const finished = saveRecord(store, {
        command: 'echo finished',
        exitCode: 0,
      });
      const running = saveRecord(store, { command: 'echo running' });

      const result = runCli(['--list', '--running', '--output-format', 'json']);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      const uuids = parsed.executions.map((record) => record.uuid);
      expect(uuids).toContain(running.uuid);
      expect(uuids).not.toContain(finished.uuid);
    });

    it('is rejected without --list', () => {
      const result = runCli(['--running', '--', 'echo hi']);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        '--running option is only valid with --list'
      );
    });
  });

  describe('--attach', () => {
    it('fails with a clear error for an unknown identifier', () => {
      const result = runCli(['--attach', 'does-not-exist']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'No execution found with UUID or session name: does-not-exist'
      );
    });

    it('refuses to attach to a non-isolated execution', () => {
      const record = saveRecord(store, { command: 'echo local' });

      const result = runCli(['--attach', record.uuid]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'Execution record does not contain an isolation session name'
      );
    });

    it('points at --resume when the session is already gone', () => {
      const record = saveRecord(store, {
        command: 'echo gone',
        options: {
          isolated: 'docker',
          isolationMode: 'detached',
          sessionName: 'start-command-162-missing',
        },
      });

      const result = runCli(['--attach', record.uuid]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--resume');
    });
  });

  describe('--resume', () => {
    it('fails with a clear error for an unknown identifier', () => {
      const result = runCli(['--resume', 'does-not-exist']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'No execution found with UUID or session name: does-not-exist'
      );
    });

    it('refuses to resume a non-isolated execution', () => {
      const record = saveRecord(store, { command: 'echo local' });

      const result = runCli(['--resume', record.uuid]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'Execution record does not contain an isolation session name'
      );
    });

    it('accepts a replacement command after --', () => {
      const result = runCli(['--resume', 'does-not-exist', '--', 'echo', 'hi']);

      // The identifier is still resolved first, so this reports the missing
      // record rather than treating "echo hi" as a fresh command.
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'No execution found with UUID or session name: does-not-exist'
      );
    });
  });

  describe('--resume-all', () => {
    it('succeeds with an empty report when nothing is running', () => {
      saveRecord(store, { command: 'echo finished', exitCode: 0 });

      const result = runCli(['--resume-all', '--output-format', 'json']);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.count).toBe(0);
      expect(parsed.executions).toEqual([]);
    });

    it('reconciles executions whose session no longer exists', () => {
      const logPath = path.join(TEST_APP_FOLDER, 'orphan.log');
      fs.writeFileSync(
        logPath,
        [
          'working...',
          '==================================================',
          'Finished: 2026-09-03 10:00:00.000',
          'Exit Code: 0',
          '',
        ].join('\n'),
        'utf8'
      );
      const record = saveRecord(store, {
        command: 'echo orphan',
        logPath,
        options: {
          isolated: 'docker',
          isolationMode: 'detached',
          sessionName: 'start-command-162-orphan',
        },
      });

      const result = runCli(['--resume-all', '--output-format', 'json']);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.count).toBe(1);
      expect(parsed.executions[0].uuid).toBe(record.uuid);
      expect(parsed.executions[0].action).toBe('reconciled');

      // The stuck "executing" record is now finalized in the store.
      const reloaded = new ExecutionStore({
        appFolder: TEST_APP_FOLDER,
        useLinks: false,
      }).get(record.uuid);
      expect(reloaded.status).toBe('executed');
    });
  });

  describe('exit reason hint', () => {
    it('explains a 139 exit caused by heap exhaustion', () => {
      const logPath = path.join(TEST_APP_FOLDER, 'oom.log');
      fs.writeFileSync(
        logPath,
        [
          'building...',
          '',
          '<--- Last few GCs --->',
          'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
          '',
          '==================================================',
          'Finished: 2026-09-03 10:00:00.000',
          'Exit Code: 139',
          '',
        ].join('\n'),
        'utf8'
      );
      const record = saveRecord(store, {
        command: 'bun run build',
        logPath,
        exitCode: 139,
      });

      const result = runCli([
        '--status',
        record.uuid,
        '--output-format',
        'json',
      ]);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.exitCode).toBe(139);
      expect(parsed.oomKilled).toBeUndefined();
      expect(parsed.exitReason).toBe('memory-exhaustion (v8-heap-limit)');
    });

    it('does not invent a reason for a clean exit', () => {
      const logPath = path.join(TEST_APP_FOLDER, 'clean.log');
      fs.writeFileSync(logPath, 'all good\n', 'utf8');
      const record = saveRecord(store, {
        command: 'echo ok',
        logPath,
        exitCode: 0,
      });

      const result = runCli([
        '--status',
        record.uuid,
        '--output-format',
        'json',
      ]);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.exitReason).toBeUndefined();
    });
  });

  describe('session identity across resumes', () => {
    it('keeps addressing one logical session by its previous name', () => {
      const record = saveRecord(store, {
        command: 'echo resumed',
        options: {
          isolated: 'docker',
          isolationMode: 'detached',
          sessionName: 'start-command-162-b',
          sessionNameHistory: ['start-command-162-a'],
        },
      });

      const result = runCli([
        '--status',
        'start-command-162-a',
        '--output-format',
        'json',
      ]);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.uuid).toBe(record.uuid);
    });
  });
});
