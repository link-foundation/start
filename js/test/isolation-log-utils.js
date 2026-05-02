#!/usr/bin/env bun
/**
 * Unit tests for isolation-log-utils module
 * Tests pure utility functions for log file management
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const path = require('path');
const {
  getTimestamp,
  generateLogFilename,
  createLogHeader,
  createLogFooter,
  getLogDir,
  createLogPath,
  getTempRoot,
} = require('../src/lib/isolation-log-utils');

describe('isolation-log-utils', () => {
  describe('getTimestamp', () => {
    it('should return a non-empty string', () => {
      const ts = getTimestamp();
      assert.strictEqual(typeof ts, 'string');
      assert.ok(ts.length > 0);
    });

    it('should return a timestamp without T or Z (ISO-like but space-separated)', () => {
      const ts = getTimestamp();
      assert.ok(!ts.includes('T'), 'Should not contain ISO T separator');
      assert.ok(!ts.endsWith('Z'), 'Should not end with Z');
    });

    it('should contain date-like content (numbers and dashes)', () => {
      const ts = getTimestamp();
      // Expect format like "2024-01-15 10:30:45.123"
      assert.match(ts, /\d{4}-\d{2}-\d{2}/);
    });

    it('should return different values on successive calls (or same within same ms)', () => {
      const ts1 = getTimestamp();
      assert.strictEqual(typeof ts1, 'string');
      // Just verify it's callable multiple times without error
      const ts2 = getTimestamp();
      assert.strictEqual(typeof ts2, 'string');
    });
  });

  describe('generateLogFilename', () => {
    it('should return a string ending with .log', () => {
      const filename = generateLogFilename('screen');
      assert.ok(filename.endsWith('.log'));
    });

    it('should include the environment name in the filename', () => {
      const filename = generateLogFilename('docker');
      assert.ok(filename.includes('docker'));
    });

    it('should start with "start-command-"', () => {
      const filename = generateLogFilename('tmux');
      assert.ok(filename.startsWith('start-command-'));
    });

    it('should generate unique filenames on successive calls', () => {
      const f1 = generateLogFilename('screen');
      const f2 = generateLogFilename('screen');
      // Due to random component, should be different
      assert.notStrictEqual(f1, f2);
    });

    it('should handle different environment names', () => {
      const environments = ['screen', 'tmux', 'docker', 'user', 'none'];
      for (const env of environments) {
        const filename = generateLogFilename(env);
        assert.ok(
          filename.includes(env),
          `Filename should include environment "${env}"`
        );
        assert.ok(filename.endsWith('.log'));
      }
    });
  });

  describe('createLogHeader', () => {
    const baseParams = {
      command: 'npm test',
      environment: 'screen',
      mode: 'attached',
      sessionName: 'test-session-123',
      startTime: '2024-01-15 10:30:00.000',
    };

    it('should return a non-empty string', () => {
      const header = createLogHeader(baseParams);
      assert.strictEqual(typeof header, 'string');
      assert.ok(header.length > 0);
    });

    it('should include the command in the header', () => {
      const header = createLogHeader(baseParams);
      assert.ok(header.includes('npm test'));
    });

    it('should include the environment in the header', () => {
      const header = createLogHeader(baseParams);
      assert.ok(header.includes('screen'));
    });

    it('should include the session name in the header', () => {
      const header = createLogHeader(baseParams);
      assert.ok(header.includes('test-session-123'));
    });

    it('should include the mode in the header', () => {
      const header = createLogHeader(baseParams);
      assert.ok(header.includes('attached'));
    });

    it('should include image field when provided', () => {
      const params = { ...baseParams, image: 'node:20-alpine' };
      const header = createLogHeader(params);
      assert.ok(header.includes('node:20-alpine'));
    });

    it('should include user field when provided', () => {
      const params = { ...baseParams, user: 'isolateduser' };
      const header = createLogHeader(params);
      assert.ok(header.includes('isolateduser'));
    });

    it('should NOT include Image line when image is not provided', () => {
      const header = createLogHeader(baseParams);
      assert.ok(!header.includes('Image:'));
    });

    it('should contain separator line', () => {
      const header = createLogHeader(baseParams);
      assert.ok(header.includes('==='));
    });
  });

  describe('createLogFooter', () => {
    it('should return a non-empty string', () => {
      const footer = createLogFooter('2024-01-15 10:35:00.000', 0);
      assert.strictEqual(typeof footer, 'string');
      assert.ok(footer.length > 0);
    });

    it('should include the exit code', () => {
      const footer = createLogFooter('2024-01-15 10:35:00.000', 42);
      assert.ok(footer.includes('42'));
    });

    it('should include exit code 0', () => {
      const footer = createLogFooter('2024-01-15 10:35:00.000', 0);
      assert.ok(footer.includes('0'));
    });

    it('should include the end time', () => {
      const endTime = '2024-01-15 10:35:00.000';
      const footer = createLogFooter(endTime, 1);
      assert.ok(footer.includes(endTime));
    });

    it('should contain separator line', () => {
      const footer = createLogFooter('2024-01-15 10:35:00.000', 0);
      assert.ok(footer.includes('='));
    });
  });

  describe('getLogDir', () => {
    it('should return a string', () => {
      const dir = getLogDir();
      assert.strictEqual(typeof dir, 'string');
    });

    it('should return a non-empty path', () => {
      const dir = getLogDir();
      assert.ok(dir.length > 0);
    });

    it('should use START_LOG_DIR env var when set', () => {
      const original = process.env.START_LOG_DIR;
      process.env.START_LOG_DIR = '/tmp/custom-log-dir';
      try {
        const dir = getLogDir();
        assert.strictEqual(dir, '/tmp/custom-log-dir');
      } finally {
        if (original === undefined) {
          delete process.env.START_LOG_DIR;
        } else {
          process.env.START_LOG_DIR = original;
        }
      }
    });

    it('should fall back to /tmp/start-command/logs when START_LOG_DIR is not set', () => {
      const original = process.env.START_LOG_DIR;
      delete process.env.START_LOG_DIR;
      try {
        const dir = getLogDir();
        assert.strictEqual(dir, path.join(getTempRoot(), 'logs'));
      } finally {
        if (original !== undefined) {
          process.env.START_LOG_DIR = original;
        }
      }
    });
  });

  describe('createLogPath', () => {
    it('should return a string ending with .log', () => {
      const logPath = createLogPath('screen');
      assert.ok(logPath.endsWith('.log'));
    });

    it('should return an absolute path', () => {
      const logPath = createLogPath('tmux');
      assert.ok(path.isAbsolute(logPath));
    });

    it('should include the environment name', () => {
      const logPath = createLogPath('docker');
      assert.ok(logPath.includes('docker'));
    });

    it('should be under the log directory', () => {
      const logDir = getLogDir();
      const logPath = createLogPath('screen');
      assert.ok(logPath.startsWith(logDir));
    });

    it('should create stable isolation log path when execution id is provided', () => {
      const logPath = createLogPath('screen', 'uuid-123');
      assert.ok(
        logPath.endsWith(
          path.join('logs', 'isolation', 'screen', 'uuid-123.log')
        )
      );
    });

    it('should create stable direct log path without duplicated environment segment', () => {
      const logPath = createLogPath('direct', 'uuid-123');
      assert.ok(logPath.endsWith(path.join('logs', 'direct', 'uuid-123.log')));
    });
  });
});
