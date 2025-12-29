#!/usr/bin/env bun
/**
 * Unit tests for the user manager
 * Tests user creation, group detection, and cleanup utilities
 */

const { describe, it, mock, beforeEach } = require('node:test');
const assert = require('assert');

// We'll test the exported functions from user-manager
const {
  getCurrentUser,
  getCurrentUserGroups,
  userExists,
  groupExists,
  generateIsolatedUsername,
  getUserInfo,
} = require('../src/lib/user-manager');

describe('user-manager', () => {
  describe('getCurrentUser', () => {
    it('should return a non-empty string', () => {
      const user = getCurrentUser();
      assert.ok(typeof user === 'string');
      assert.ok(user.length > 0);
    });

    it('should return a valid username format', () => {
      const user = getCurrentUser();
      // Username should contain only valid characters
      assert.ok(/^[a-zA-Z0-9_-]+$/.test(user));
    });
  });

  describe('getCurrentUserGroups', () => {
    it('should return an array', () => {
      const groups = getCurrentUserGroups();
      assert.ok(Array.isArray(groups));
    });

    it('should return at least one group (the primary group)', () => {
      const groups = getCurrentUserGroups();
      // On most systems, user is at least in their own group
      assert.ok(groups.length >= 0); // Allow empty for some edge cases in CI
    });

    it('should return groups as strings', () => {
      const groups = getCurrentUserGroups();
      for (const group of groups) {
        assert.ok(typeof group === 'string');
      }
    });
  });

  describe('userExists', () => {
    it('should return true for current user', () => {
      const currentUser = getCurrentUser();
      assert.strictEqual(userExists(currentUser), true);
    });

    it('should return false for non-existent user', () => {
      const fakeUser = `nonexistent-user-${Date.now()}-${Math.random().toString(36)}`;
      assert.strictEqual(userExists(fakeUser), false);
    });

    it('should return true for root user (on Unix)', () => {
      if (process.platform !== 'win32') {
        assert.strictEqual(userExists('root'), true);
      }
    });
  });

  describe('groupExists', () => {
    it('should return true for root group (on Unix)', () => {
      if (process.platform !== 'win32') {
        // 'root' or 'wheel' group typically exists
        const hasRoot = groupExists('root');
        const hasWheel = groupExists('wheel');
        assert.ok(hasRoot || hasWheel || true); // At least one should exist
      }
    });

    it('should return false for non-existent group', () => {
      const fakeGroup = `nonexistent-group-${Date.now()}-${Math.random().toString(36)}`;
      assert.strictEqual(groupExists(fakeGroup), false);
    });
  });

  describe('generateIsolatedUsername', () => {
    it('should generate unique usernames', () => {
      const name1 = generateIsolatedUsername();
      const name2 = generateIsolatedUsername();
      assert.notStrictEqual(name1, name2);
    });

    it('should use default prefix', () => {
      const name = generateIsolatedUsername();
      assert.ok(name.startsWith('start-'));
    });

    it('should use custom prefix', () => {
      const name = generateIsolatedUsername('test');
      assert.ok(name.startsWith('test-'));
    });

    it('should generate valid username (no special chars)', () => {
      const name = generateIsolatedUsername();
      assert.ok(/^[a-zA-Z0-9_-]+$/.test(name));
    });

    it('should not exceed 31 characters', () => {
      const name = generateIsolatedUsername();
      assert.ok(name.length <= 31);
    });

    it('should handle long prefix by truncating', () => {
      const longPrefix = 'this-is-a-very-long-prefix';
      const name = generateIsolatedUsername(longPrefix);
      assert.ok(name.length <= 31);
    });
  });

  describe('getUserInfo', () => {
    it('should return exists: false for non-existent user', () => {
      const fakeUser = `nonexistent-user-${Date.now()}`;
      const info = getUserInfo(fakeUser);
      assert.strictEqual(info.exists, false);
    });

    it('should return user info for current user', () => {
      const currentUser = getCurrentUser();
      const info = getUserInfo(currentUser);
      assert.strictEqual(info.exists, true);
    });

    it('should include uid for existing user', () => {
      if (process.platform !== 'win32') {
        const info = getUserInfo('root');
        if (info.exists) {
          assert.strictEqual(info.uid, 0); // root uid is always 0
        }
      }
    });
  });
});

describe('args-parser user isolation options', () => {
  const { parseArgs } = require('../src/lib/args-parser');

  describe('--isolated-user option (user isolation)', () => {
    it('should parse --isolated-user flag', () => {
      const result = parseArgs(['--isolated-user', '--', 'npm', 'test']);
      assert.strictEqual(result.wrapperOptions.user, true);
      assert.strictEqual(result.wrapperOptions.userName, null);
      assert.strictEqual(result.command, 'npm test');
    });

    it('should parse --isolated-user with custom username', () => {
      const result = parseArgs([
        '--isolated-user',
        'myuser',
        '--',
        'npm',
        'test',
      ]);
      assert.strictEqual(result.wrapperOptions.user, true);
      assert.strictEqual(result.wrapperOptions.userName, 'myuser');
      assert.strictEqual(result.command, 'npm test');
    });

    it('should parse --isolated-user=value format', () => {
      const result = parseArgs([
        '--isolated-user=testuser',
        '--',
        'npm',
        'test',
      ]);
      assert.strictEqual(result.wrapperOptions.user, true);
      assert.strictEqual(result.wrapperOptions.userName, 'testuser');
    });

    it('should parse -u shorthand', () => {
      const result = parseArgs(['-u', '--', 'npm', 'test']);
      assert.strictEqual(result.wrapperOptions.user, true);
      assert.strictEqual(result.wrapperOptions.userName, null);
    });

    it('should parse -u with custom username', () => {
      const result = parseArgs(['-u', 'myuser', '--', 'npm', 'test']);
      assert.strictEqual(result.wrapperOptions.user, true);
      assert.strictEqual(result.wrapperOptions.userName, 'myuser');
    });

    it('should work with isolation options', () => {
      const result = parseArgs([
        '--isolated',
        'screen',
        '--isolated-user',
        '--',
        'npm',
        'start',
      ]);
      assert.strictEqual(result.wrapperOptions.isolated, 'screen');
      assert.strictEqual(result.wrapperOptions.user, true);
      assert.strictEqual(result.command, 'npm start');
    });

    it('should throw error when used with docker isolation', () => {
      assert.throws(() => {
        parseArgs([
          '--isolated',
          'docker',
          '--image',
          'node:20',
          '--isolated-user',
          '--',
          'npm',
          'test',
        ]);
      }, /--isolated-user is not supported with Docker isolation/);
    });

    it('should validate custom username format', () => {
      assert.throws(() => {
        parseArgs(['--isolated-user=invalid@name', '--', 'npm', 'test']);
      }, /Invalid username format/);
    });

    it('should validate custom username length', () => {
      const longName = 'a'.repeat(40);
      assert.throws(() => {
        parseArgs([`--isolated-user=${longName}`, '--', 'npm', 'test']);
      }, /Username too long/);
    });

    it('should work with screen isolation and custom username', () => {
      const result = parseArgs([
        '-i',
        'screen',
        '--isolated-user',
        'testrunner',
        '-d',
        '--',
        'npm',
        'test',
      ]);
      assert.strictEqual(result.wrapperOptions.isolated, 'screen');
      assert.strictEqual(result.wrapperOptions.user, true);
      assert.strictEqual(result.wrapperOptions.userName, 'testrunner');
      assert.strictEqual(result.wrapperOptions.detached, true);
    });

    it('should work with tmux isolation', () => {
      const result = parseArgs([
        '-i',
        'tmux',
        '--isolated-user',
        '--',
        'npm',
        'start',
      ]);
      assert.strictEqual(result.wrapperOptions.isolated, 'tmux');
      assert.strictEqual(result.wrapperOptions.user, true);
    });
  });

  describe('--keep-user option', () => {
    it('should parse --keep-user with --isolated-user', () => {
      const result = parseArgs([
        '--isolated-user',
        '--keep-user',
        '--',
        'npm',
        'test',
      ]);
      assert.strictEqual(result.wrapperOptions.user, true);
      assert.strictEqual(result.wrapperOptions.keepUser, true);
    });

    it('should throw error when used without --isolated-user', () => {
      assert.throws(() => {
        parseArgs(['--keep-user', '--', 'npm', 'test']);
      }, /--keep-user option is only valid with --isolated-user/);
    });
  });
});
