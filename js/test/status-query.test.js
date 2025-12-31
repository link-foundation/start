/**
 * Integration tests for --status query functionality
 */

const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  ExecutionStore,
  ExecutionRecord,
  ExecutionStatus,
} = require('../src/lib/execution-store');

// Use temp directory for tests
const TEST_APP_FOLDER = path.join(
  os.tmpdir(),
  `status-query-test-${Date.now()}`
);

// Path to CLI
const CLI_PATH = path.join(__dirname, '../src/bin/cli.js');

// Helper to clean up test directory
function cleanupTestDir() {
  if (fs.existsSync(TEST_APP_FOLDER)) {
    fs.rmSync(TEST_APP_FOLDER, { recursive: true, force: true });
  }
}

// Helper to run CLI command
function runCli(args, env = {}) {
  const result = spawnSync('bun', [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      START_APP_FOLDER: TEST_APP_FOLDER,
      ...env,
    },
    timeout: 10000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

describe('--status query functionality', () => {
  let store;
  let testRecord;

  beforeEach(() => {
    cleanupTestDir();
    store = new ExecutionStore({
      appFolder: TEST_APP_FOLDER,
      useLinks: false,
    });

    // Create a test execution record
    testRecord = new ExecutionRecord({
      command: 'echo hello world',
      pid: 12345,
      logPath: '/tmp/test.log',
      workingDirectory: '/home/test',
      shell: '/bin/bash',
    });
    testRecord.complete(0);
    store.save(testRecord);
  });

  afterEach(() => {
    cleanupTestDir();
  });

  describe('links-notation format (default)', () => {
    it('should output status in links-notation format by default', () => {
      const result = runCli(['--status', testRecord.uuid]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`(${testRecord.uuid}.uuid:`);
      expect(result.stdout).toContain('uuid "');
      expect(result.stdout).toContain(`(${testRecord.uuid}.status:`);
      expect(result.stdout).toContain('status "executed"');
      expect(result.stdout).toContain(`(${testRecord.uuid}.command:`);
      expect(result.stdout).toContain('command "echo hello world"');
    });

    it('should output status in links-notation format with explicit flag', () => {
      const result = runCli([
        '--status',
        testRecord.uuid,
        '--output-format',
        'links-notation',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`(${testRecord.uuid}.uuid:`);
    });
  });

  describe('json format', () => {
    it('should output status in JSON format', () => {
      const result = runCli([
        '--status',
        testRecord.uuid,
        '--output-format',
        'json',
      ]);

      expect(result.exitCode).toBe(0);

      // Parse the JSON output
      const parsed = JSON.parse(result.stdout);
      expect(parsed.uuid).toBe(testRecord.uuid);
      expect(parsed.command).toBe('echo hello world');
      expect(parsed.status).toBe('executed');
      expect(parsed.exitCode).toBe(0);
      expect(parsed.pid).toBe(12345);
    });
  });

  describe('text format', () => {
    it('should output status in human-readable text format', () => {
      const result = runCli([
        '--status',
        testRecord.uuid,
        '--output-format',
        'text',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Execution Status');
      expect(result.stdout).toContain('UUID:');
      expect(result.stdout).toContain(testRecord.uuid);
      expect(result.stdout).toContain('Status:');
      expect(result.stdout).toContain('executed');
      expect(result.stdout).toContain('Command:');
      expect(result.stdout).toContain('echo hello world');
      expect(result.stdout).toContain('Exit Code:');
      expect(result.stdout).toContain('0');
    });
  });

  describe('error handling', () => {
    it('should show error for non-existent UUID', () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000000';
      const result = runCli(['--status', fakeUuid]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No execution found with UUID');
      expect(result.stderr).toContain(fakeUuid);
    });

    it('should show error when tracking is disabled', () => {
      const result = runCli(['--status', testRecord.uuid], {
        START_DISABLE_TRACKING: '1',
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('tracking is disabled');
    });
  });

  describe('executing status', () => {
    it('should show executing status for ongoing commands', () => {
      // Create an executing (not completed) record
      const executingRecord = new ExecutionRecord({
        command: 'sleep 100',
        pid: 99999,
        logPath: '/tmp/executing.log',
      });
      store.save(executingRecord);

      const result = runCli([
        '--status',
        executingRecord.uuid,
        '--output-format',
        'json',
      ]);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).toBe('executing');
      expect(parsed.exitCode).toBeNull();
      expect(parsed.endTime).toBeNull();
    });
  });
});

console.log('=== Status Query Integration Tests ===');
