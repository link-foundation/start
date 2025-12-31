/**
 * Tests for public exports of start-command package
 * Verifies that ExecutionStore can be imported via package exports
 */

const { describe, it, expect } = require('bun:test');

describe('Public Exports', () => {
  describe('execution-store export', () => {
    it('should export ExecutionStore class', () => {
      const { ExecutionStore } = require('../src/lib/execution-store');
      expect(ExecutionStore).toBeDefined();
      expect(typeof ExecutionStore).toBe('function');
    });

    it('should export ExecutionRecord class', () => {
      const { ExecutionRecord } = require('../src/lib/execution-store');
      expect(ExecutionRecord).toBeDefined();
      expect(typeof ExecutionRecord).toBe('function');
    });

    it('should export ExecutionStatus enum', () => {
      const { ExecutionStatus } = require('../src/lib/execution-store');
      expect(ExecutionStatus).toBeDefined();
      expect(ExecutionStatus.EXECUTING).toBe('executing');
      expect(ExecutionStatus.EXECUTED).toBe('executed');
    });

    it('should export LockManager class', () => {
      const { LockManager } = require('../src/lib/execution-store');
      expect(LockManager).toBeDefined();
      expect(typeof LockManager).toBe('function');
    });

    it('should export isClinkInstalled function', () => {
      const { isClinkInstalled } = require('../src/lib/execution-store');
      expect(isClinkInstalled).toBeDefined();
      expect(typeof isClinkInstalled).toBe('function');
    });

    it('should export configuration constants', () => {
      const {
        DEFAULT_APP_FOLDER,
        LINO_DB_FILE,
        LINKS_DB_FILE,
        LOCK_FILE,
      } = require('../src/lib/execution-store');
      expect(DEFAULT_APP_FOLDER).toBeDefined();
      expect(typeof DEFAULT_APP_FOLDER).toBe('string');
      expect(LINO_DB_FILE).toBe('executions.lino');
      expect(LINKS_DB_FILE).toBe('executions.links');
      expect(LOCK_FILE).toBe('executions.lock');
    });

    it('should allow creating and using ExecutionStore instance', () => {
      const os = require('os');
      const path = require('path');
      const fs = require('fs');

      const {
        ExecutionStore,
        ExecutionRecord,
        ExecutionStatus,
      } = require('../src/lib/execution-store');

      // Create a temporary folder for testing
      const testFolder = path.join(
        os.tmpdir(),
        `public-export-test-${Date.now()}`
      );

      try {
        const store = new ExecutionStore({ appFolder: testFolder });
        expect(store).toBeDefined();

        // Create and save a record
        const record = new ExecutionRecord({
          command: 'echo "test"',
          logPath: '/tmp/test.log',
        });
        expect(record.status).toBe(ExecutionStatus.EXECUTING);

        store.save(record);

        // Retrieve the record
        const retrieved = store.get(record.uuid);
        expect(retrieved).toBeDefined();
        expect(retrieved.command).toBe('echo "test"');

        // Complete the record
        record.complete(0);
        store.save(record);

        const completed = store.get(record.uuid);
        expect(completed.status).toBe(ExecutionStatus.EXECUTED);
        expect(completed.exitCode).toBe(0);
      } finally {
        // Cleanup
        if (fs.existsSync(testFolder)) {
          fs.rmSync(testFolder, { recursive: true, force: true });
        }
      }
    });
  });
});
