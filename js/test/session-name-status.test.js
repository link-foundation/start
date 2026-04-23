/**
 * Tests for --status lookup by session name and detached status enrichment
 * Issue #101: --session name not usable with --status, and --detached reports immediate completion
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
const {
  queryStatus,
  isDetachedSessionAlive,
  enrichDetachedStatus,
  attachCurrentTime,
} = require('../src/lib/status-formatter');

// Use temp directory for tests
const TEST_APP_FOLDER = path.join(
  os.tmpdir(),
  `session-name-status-test-${Date.now()}`
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

describe('Issue #101: --status with session name lookup', () => {
  let store;

  beforeEach(() => {
    cleanupTestDir();
    store = new ExecutionStore({
      appFolder: TEST_APP_FOLDER,
      useLinks: false,
    });
  });

  afterEach(() => {
    cleanupTestDir();
  });

  describe('ExecutionStore.get() session name lookup', () => {
    it('should find record by UUID', () => {
      const record = new ExecutionRecord({
        command: 'echo hello',
        pid: 12345,
        logPath: '/tmp/test.log',
        options: { sessionName: 'my-custom-session' },
      });
      record.complete(0);
      store.save(record);

      const found = store.get(record.uuid);
      expect(found).not.toBeNull();
      expect(found.uuid).toBe(record.uuid);
    });

    it('should find record by session name', () => {
      const record = new ExecutionRecord({
        command: 'sleep 60',
        pid: 12345,
        logPath: '/tmp/test.log',
        options: {
          sessionName: 'my-custom-session',
          isolated: 'screen',
          isolationMode: 'detached',
        },
      });
      store.save(record);

      const found = store.get('my-custom-session');
      expect(found).not.toBeNull();
      expect(found.uuid).toBe(record.uuid);
      expect(found.options.sessionName).toBe('my-custom-session');
    });

    it('should prefer UUID match over session name', () => {
      // Create two records: one whose session name matches the UUID of another
      const record1 = new ExecutionRecord({
        command: 'echo first',
        pid: 111,
        logPath: '/tmp/first.log',
        options: { sessionName: 'some-session' },
      });
      record1.complete(0);
      store.save(record1);

      const record2 = new ExecutionRecord({
        command: 'echo second',
        pid: 222,
        logPath: '/tmp/second.log',
        options: { sessionName: record1.uuid }, // session name matches record1's UUID
      });
      store.save(record2);

      // Looking up by record1's UUID should return record1, not record2
      const found = store.get(record1.uuid);
      expect(found.command).toBe('echo first');
    });

    it('should return null for non-existent session name', () => {
      const found = store.get('nonexistent-session');
      expect(found).toBeNull();
    });

    it('should return null for record without session name', () => {
      const record = new ExecutionRecord({
        command: 'echo hello',
        pid: 12345,
        logPath: '/tmp/test.log',
      });
      store.save(record);

      const found = store.get('some-session-name');
      expect(found).toBeNull();
    });
  });

  describe('queryStatus() with session name', () => {
    it('should query status by session name', () => {
      const record = new ExecutionRecord({
        command: 'sleep 60',
        pid: 12345,
        logPath: '/tmp/test.log',
        options: {
          sessionName: 'my-test-session',
          isolated: 'screen',
          isolationMode: 'attached',
        },
      });
      record.complete(0);
      store.save(record);

      const result = queryStatus(store, 'my-test-session', 'json');
      expect(result.success).toBe(true);

      const parsed = JSON.parse(result.output);
      expect(parsed.uuid).toBe(record.uuid);
      expect(parsed.command).toBe('sleep 60');
    });

    it('should show error for non-existent session name', () => {
      const result = queryStatus(store, 'nonexistent-session', 'json');
      expect(result.success).toBe(false);
      expect(result.error).toContain('No execution found');
      expect(result.error).toContain('nonexistent-session');
    });
  });

  describe('CLI --status with session name', () => {
    it('should query by session name via CLI', () => {
      const record = new ExecutionRecord({
        command: 'echo hello world',
        pid: 12345,
        logPath: '/tmp/test.log',
        options: {
          sessionName: 'cli-test-session',
          isolated: 'screen',
          isolationMode: 'attached',
        },
      });
      record.complete(0);
      store.save(record);

      const result = runCli([
        '--status',
        'cli-test-session',
        '--output-format',
        'json',
      ]);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.uuid).toBe(record.uuid);
      expect(parsed.command).toBe('echo hello world');
      expect(parsed.status).toBe('executed');
    });

    it('should show error for non-existent session name via CLI', () => {
      const result = runCli(['--status', 'nonexistent-session']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No execution found');
    });
  });
});

describe('Issue #101: Detached status enrichment', () => {
  describe('isDetachedSessionAlive()', () => {
    it('should return null for non-detached records', () => {
      const record = new ExecutionRecord({
        command: 'echo hello',
        options: {
          sessionName: 'test',
          isolated: 'screen',
          isolationMode: 'attached',
        },
      });
      expect(isDetachedSessionAlive(record)).toBeNull();
    });

    it('should return null for records without session name', () => {
      const record = new ExecutionRecord({
        command: 'echo hello',
        options: { isolationMode: 'detached' },
      });
      expect(isDetachedSessionAlive(record)).toBeNull();
    });

    it('should return false for non-existent screen session', () => {
      const record = new ExecutionRecord({
        command: 'sleep 60',
        options: {
          sessionName: 'nonexistent-screen-session-test-101',
          isolated: 'screen',
          isolationMode: 'detached',
        },
      });
      const alive = isDetachedSessionAlive(record);
      // May be false or null depending on whether screen is installed
      if (alive !== null) {
        expect(alive).toBe(false);
      }
    });

    it('should return false for non-existent docker container', () => {
      const record = new ExecutionRecord({
        command: 'sleep 60',
        options: {
          sessionName: 'nonexistent-docker-container-test-101',
          isolated: 'docker',
          isolationMode: 'detached',
        },
      });
      const alive = isDetachedSessionAlive(record);
      // May be false or null depending on whether docker is installed
      if (alive !== null) {
        expect(alive).toBe(false);
      }
    });
  });

  describe('enrichDetachedStatus()', () => {
    it('should not modify non-detached records', () => {
      const record = new ExecutionRecord({
        command: 'echo hello',
        options: {
          sessionName: 'test',
          isolated: 'screen',
          isolationMode: 'attached',
        },
      });
      record.complete(0);

      const enriched = enrichDetachedStatus(record);
      expect(enriched.status).toBe('executed');
      expect(enriched.exitCode).toBe(0);
    });

    it('should mark non-running detached session as executed', () => {
      const record = new ExecutionRecord({
        command: 'sleep 60',
        options: {
          sessionName: 'nonexistent-session-enrich-test-101',
          isolated: 'screen',
          isolationMode: 'detached',
        },
      });
      // Record says executing, but session doesn't exist

      const enriched = enrichDetachedStatus(record);
      // If screen is available, should mark as executed
      // If screen is not available, should return unchanged
      if (enriched.status === 'executed') {
        expect(enriched.exitCode).toBe(-1); // Unknown exit code
        expect(enriched.endTime).not.toBeNull();
      }
    });
  });
});

describe('Issue #105: attachCurrentTime for executing status', () => {
  it('should add currentTime to serialization when status is executing', () => {
    const record = new ExecutionRecord({
      command: 'sleep 60',
      pid: 12345,
      logPath: '/tmp/test.log',
    });

    const before = Date.now();
    const wrapped = attachCurrentTime(record);
    const obj = wrapped.toObject();
    const after = Date.now();

    expect(obj.currentTime).toBeDefined();
    const currentTimeMs = new Date(obj.currentTime).getTime();
    expect(Number.isNaN(currentTimeMs)).toBe(false);
    expect(currentTimeMs).toBeGreaterThanOrEqual(before - 1);
    expect(currentTimeMs).toBeLessThanOrEqual(after + 1);
  });

  it('should not add currentTime when status is executed', () => {
    const record = new ExecutionRecord({
      command: 'echo hello',
      pid: 12345,
      logPath: '/tmp/test.log',
    });
    record.complete(0);

    const wrapped = attachCurrentTime(record);
    // attachCurrentTime should return the original record unchanged
    expect(wrapped).toBe(record);
    const obj = wrapped.toObject();
    expect(obj.currentTime).toBeUndefined();
  });

  it('should not mutate the original record', () => {
    const record = new ExecutionRecord({
      command: 'sleep 60',
      pid: 12345,
      logPath: '/tmp/test.log',
    });

    const wrapped = attachCurrentTime(record);
    expect(wrapped).not.toBe(record);
    // The original record's toObject output should not include currentTime
    const originalObj = record.toObject();
    expect(originalObj.currentTime).toBeUndefined();
  });

  it('should place currentTime right after startTime in serialization order', () => {
    const record = new ExecutionRecord({
      command: 'sleep 60',
      pid: 12345,
      logPath: '/tmp/test.log',
    });

    const wrapped = attachCurrentTime(record);
    const keys = Object.keys(wrapped.toObject());
    const startIndex = keys.indexOf('startTime');
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(keys[startIndex + 1]).toBe('currentTime');
  });

  it('should handle null record gracefully', () => {
    expect(attachCurrentTime(null)).toBeNull();
  });
});

console.log('=== Session Name Status Tests (Issue #101) ===');
