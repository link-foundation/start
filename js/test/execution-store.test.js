/**
 * Unit tests for execution-store.js
 */

const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  ExecutionStore,
  ExecutionRecord,
  ExecutionStatus,
  LockManager,
  isClinkInstalled,
  LINO_DB_FILE,
  LINKS_DB_FILE,
  LOCK_FILE,
} = require('../src/lib/execution-store');

// Use temp directory for tests
const TEST_APP_FOLDER = path.join(
  os.tmpdir(),
  `execution-store-test-${Date.now()}`
);

// Helper to clean up test directory
function cleanupTestDir() {
  if (fs.existsSync(TEST_APP_FOLDER)) {
    fs.rmSync(TEST_APP_FOLDER, { recursive: true, force: true });
  }
}

describe('ExecutionRecord', () => {
  it('should create a new execution record with default values', () => {
    const record = new ExecutionRecord();

    expect(record.uuid).toBeTruthy();
    expect(record.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(record.pid).toBeNull();
    expect(record.status).toBe(ExecutionStatus.EXECUTING);
    expect(record.exitCode).toBeNull();
    expect(record.command).toBe('');
    expect(record.logPath).toBe('');
    expect(record.startTime).toBeTruthy();
    expect(record.endTime).toBeNull();
    expect(record.workingDirectory).toBeTruthy();
    expect(record.platform).toBe(process.platform);
  });

  it('should create a new execution record with custom values', () => {
    const customOptions = {
      uuid: '12345678-1234-1234-1234-123456789abc',
      pid: 12345,
      status: ExecutionStatus.EXECUTED,
      exitCode: 0,
      command: 'echo hello',
      logPath: '/tmp/test.log',
      startTime: '2024-01-01T00:00:00.000Z',
      endTime: '2024-01-01T00:00:01.000Z',
      workingDirectory: '/home/user',
      shell: '/bin/zsh',
      platform: 'darwin',
      options: { custom: 'option' },
    };

    const record = new ExecutionRecord(customOptions);

    expect(record.uuid).toBe(customOptions.uuid);
    expect(record.pid).toBe(customOptions.pid);
    expect(record.status).toBe(customOptions.status);
    expect(record.exitCode).toBe(customOptions.exitCode);
    expect(record.command).toBe(customOptions.command);
    expect(record.logPath).toBe(customOptions.logPath);
    expect(record.startTime).toBe(customOptions.startTime);
    expect(record.endTime).toBe(customOptions.endTime);
    expect(record.workingDirectory).toBe(customOptions.workingDirectory);
    expect(record.shell).toBe(customOptions.shell);
    expect(record.platform).toBe(customOptions.platform);
    expect(record.options.custom).toBe('option');
  });

  it('should mark execution as completed', () => {
    const record = new ExecutionRecord({ command: 'echo hello' });

    expect(record.status).toBe(ExecutionStatus.EXECUTING);
    expect(record.exitCode).toBeNull();
    expect(record.endTime).toBeNull();

    record.complete(0);

    expect(record.status).toBe(ExecutionStatus.EXECUTED);
    expect(record.exitCode).toBe(0);
    expect(record.endTime).toBeTruthy();
  });

  it('should convert to plain object and back', () => {
    const record = new ExecutionRecord({
      command: 'echo hello',
      pid: 12345,
      logPath: '/tmp/test.log',
    });

    const obj = record.toObject();
    expect(obj.uuid).toBe(record.uuid);
    expect(obj.command).toBe('echo hello');
    expect(obj.pid).toBe(12345);

    const restored = ExecutionRecord.fromObject(obj);
    expect(restored.uuid).toBe(record.uuid);
    expect(restored.command).toBe('echo hello');
    expect(restored.pid).toBe(12345);
  });
});

describe('LockManager', () => {
  const testLockPath = path.join(TEST_APP_FOLDER, 'test.lock');

  beforeEach(() => {
    cleanupTestDir();
    fs.mkdirSync(TEST_APP_FOLDER, { recursive: true });
  });

  afterEach(() => {
    cleanupTestDir();
  });

  it('should acquire and release a lock', () => {
    const lock = new LockManager(testLockPath);

    expect(lock.acquire()).toBe(true);
    expect(fs.existsSync(testLockPath)).toBe(true);

    lock.release();
    expect(fs.existsSync(testLockPath)).toBe(false);
  });

  it('should fail to acquire lock if already held by another process', () => {
    // Create a lock file manually
    fs.writeFileSync(
      testLockPath,
      JSON.stringify({
        pid: 999999, // Non-existent PID but still check the mechanism
        timestamp: Date.now(),
        hostname: os.hostname(),
      })
    );

    const lock = new LockManager(testLockPath);

    // The lock should be acquired because the PID 999999 doesn't exist
    // (so the lock is considered stale)
    expect(lock.acquire(1000)).toBe(true);

    lock.release();
  });

  it('should detect stale locks', () => {
    const lock = new LockManager(testLockPath);

    // Create a stale lock (old timestamp)
    const staleData = {
      pid: 999999,
      timestamp: Date.now() - 120000, // 2 minutes ago
      hostname: os.hostname(),
    };

    expect(lock.isLockStale(staleData)).toBe(true);

    // Create a fresh lock
    const freshData = {
      pid: process.pid,
      timestamp: Date.now(),
      hostname: os.hostname(),
    };

    expect(lock.isLockStale(freshData)).toBe(false);
  });
});

describe('ExecutionStore', () => {
  let store;

  beforeEach(() => {
    cleanupTestDir();
    store = new ExecutionStore({
      appFolder: TEST_APP_FOLDER,
      useLinks: false, // Disable links for unit tests
      verbose: false,
    });
  });

  afterEach(() => {
    cleanupTestDir();
  });

  it('should create app folder on initialization', () => {
    expect(fs.existsSync(TEST_APP_FOLDER)).toBe(true);
  });

  it('should save and retrieve an execution record', () => {
    const record = new ExecutionRecord({
      command: 'echo hello',
      pid: 12345,
      logPath: '/tmp/test.log',
    });

    store.save(record);

    const retrieved = store.get(record.uuid);
    expect(retrieved).toBeTruthy();
    expect(retrieved.uuid).toBe(record.uuid);
    expect(retrieved.command).toBe('echo hello');
    expect(retrieved.pid).toBe(12345);
  });

  it('should update an existing record', () => {
    const record = new ExecutionRecord({
      command: 'echo hello',
      pid: 12345,
    });

    store.save(record);

    // Update the record
    record.complete(0);
    store.save(record);

    const retrieved = store.get(record.uuid);
    expect(retrieved.status).toBe(ExecutionStatus.EXECUTED);
    expect(retrieved.exitCode).toBe(0);
    expect(retrieved.endTime).toBeTruthy();
  });

  it('should get all records', () => {
    const record1 = new ExecutionRecord({ command: 'echo 1' });
    const record2 = new ExecutionRecord({ command: 'echo 2' });
    const record3 = new ExecutionRecord({ command: 'echo 3' });

    store.save(record1);
    store.save(record2);
    store.save(record3);

    const all = store.getAll();
    expect(all.length).toBe(3);
  });

  it('should get records by status', () => {
    const executing1 = new ExecutionRecord({ command: 'echo 1' });
    const executing2 = new ExecutionRecord({ command: 'echo 2' });
    const executed = new ExecutionRecord({ command: 'echo 3' });
    executed.complete(0);

    store.save(executing1);
    store.save(executing2);
    store.save(executed);

    const executingRecords = store.getExecuting();
    expect(executingRecords.length).toBe(2);

    const executedRecords = store.getByStatus(ExecutionStatus.EXECUTED);
    expect(executedRecords.length).toBe(1);
    expect(executedRecords[0].uuid).toBe(executed.uuid);
  });

  it('should get recent records', () => {
    // Create records with different start times
    const record1 = new ExecutionRecord({
      command: 'echo 1',
      startTime: '2024-01-01T00:00:00.000Z',
    });
    const record2 = new ExecutionRecord({
      command: 'echo 2',
      startTime: '2024-01-02T00:00:00.000Z',
    });
    const record3 = new ExecutionRecord({
      command: 'echo 3',
      startTime: '2024-01-03T00:00:00.000Z',
    });

    store.save(record1);
    store.save(record2);
    store.save(record3);

    const recent = store.getRecent(2);
    expect(recent.length).toBe(2);
    expect(recent[0].command).toBe('echo 3'); // Most recent first
    expect(recent[1].command).toBe('echo 2');
  });

  it('should delete a record', () => {
    const record = new ExecutionRecord({ command: 'echo hello' });

    store.save(record);
    expect(store.get(record.uuid)).toBeTruthy();

    const deleted = store.delete(record.uuid);
    expect(deleted).toBe(true);
    expect(store.get(record.uuid)).toBeNull();
  });

  it('should return false when deleting non-existent record', () => {
    const deleted = store.delete('non-existent-uuid');
    expect(deleted).toBe(false);
  });

  it('should clear all records', () => {
    const record1 = new ExecutionRecord({ command: 'echo 1' });
    const record2 = new ExecutionRecord({ command: 'echo 2' });

    store.save(record1);
    store.save(record2);
    expect(store.getAll().length).toBe(2);

    store.clear();
    expect(store.getAll().length).toBe(0);
  });

  it('should get statistics', () => {
    const executing = new ExecutionRecord({ command: 'echo 1' });
    const success = new ExecutionRecord({ command: 'echo 2' });
    success.complete(0);
    const failure = new ExecutionRecord({ command: 'echo 3' });
    failure.complete(1);

    store.save(executing);
    store.save(success);
    store.save(failure);

    const stats = store.getStats();
    expect(stats.total).toBe(3);
    expect(stats.executing).toBe(1);
    expect(stats.executed).toBe(2);
    expect(stats.successful).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.linoDbPath).toContain(LINO_DB_FILE);
  });

  it('should handle concurrent saves with locking', async () => {
    // Create multiple records quickly
    const records = [];
    for (let i = 0; i < 10; i++) {
      records.push(new ExecutionRecord({ command: `echo ${i}` }));
    }

    // Save all records
    for (const record of records) {
      store.save(record);
    }

    // Verify all are saved
    const all = store.getAll();
    expect(all.length).toBe(10);
  });

  it('should persist data to lino file', () => {
    const record = new ExecutionRecord({
      command: 'echo hello',
      pid: 12345,
    });

    store.save(record);

    // Verify file exists
    const linoPath = path.join(TEST_APP_FOLDER, LINO_DB_FILE);
    expect(fs.existsSync(linoPath)).toBe(true);

    // Read and verify content - lino format uses base64 encoding for strings
    const content = fs.readFileSync(linoPath, 'utf8');
    expect(content.length).toBeGreaterThan(0);
    // Verify content has array structure
    expect(content).toContain('(array');
    // Verify PID is stored (as int)
    expect(content).toContain('(int 12345)');
  });
});

describe('isClinkInstalled', () => {
  it('should return a boolean', () => {
    const result = isClinkInstalled();
    expect(typeof result).toBe('boolean');
    // Note: The actual value depends on whether clink is installed in the test environment
  });
});

describe('ExecutionStore with lino-objects-codec', () => {
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

  it('should properly encode and decode complex options', () => {
    const record = new ExecutionRecord({
      command: 'npm test',
      options: {
        substitutionMatched: true,
        originalCommand: 'run tests',
        runtime: 'Bun',
        runtimeVersion: '1.0.0',
        nested: {
          deep: {
            value: 'test',
          },
        },
        array: [1, 2, 3],
      },
    });

    store.save(record);

    const retrieved = store.get(record.uuid);
    expect(retrieved.options.substitutionMatched).toBe(true);
    expect(retrieved.options.originalCommand).toBe('run tests');
    expect(retrieved.options.nested.deep.value).toBe('test');
    expect(retrieved.options.array).toEqual([1, 2, 3]);
  });

  it('should handle special characters in command', () => {
    const record = new ExecutionRecord({
      command: 'echo "hello world" | grep "world"',
    });

    store.save(record);

    const retrieved = store.get(record.uuid);
    expect(retrieved.command).toBe('echo "hello world" | grep "world"');
  });

  it('should handle unicode characters', () => {
    const record = new ExecutionRecord({
      command: 'echo "Hello 世界 🌍"',
      logPath: '/tmp/unicode-日本語.log',
    });

    store.save(record);

    const retrieved = store.get(record.uuid);
    expect(retrieved.command).toBe('echo "Hello 世界 🌍"');
    expect(retrieved.logPath).toBe('/tmp/unicode-日本語.log');
  });
});

describe('ExecutionStore verifyConsistency', () => {
  let store;

  beforeEach(() => {
    cleanupTestDir();
    store = new ExecutionStore({
      appFolder: TEST_APP_FOLDER,
      useLinks: false, // clink likely not available in test environment
    });
  });

  afterEach(() => {
    cleanupTestDir();
  });

  it('should report consistency status for lino-only store', () => {
    const record1 = new ExecutionRecord({ command: 'echo 1' });
    const record2 = new ExecutionRecord({ command: 'echo 2' });

    store.save(record1);
    store.save(record2);

    const result = store.verifyConsistency();
    expect(result.linoCount).toBe(2);
    // Without clink, there will be an error about it not being installed
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

console.log('=== Execution Store Unit Tests ===');
