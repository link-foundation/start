#!/usr/bin/env bun
/**
 * Unit tests for the argument parser
 * Tests wrapper options parsing, validation, and command extraction
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const {
  parseArgs,
  validateOptions,
  generateSessionName,
  hasIsolation,
  getEffectiveMode,
  VALID_BACKENDS,
} = require('../src/lib/args-parser');

describe('parseArgs', () => {
  describe('basic command parsing', () => {
    it('should parse simple command without options', () => {
      const result = parseArgs(['echo', 'hello', 'world']);
      assert.strictEqual(result.command, 'echo hello world');
      assert.strictEqual(result.wrapperOptions.isolated, null);
      assert.strictEqual(result.wrapperOptions.attached, false);
      assert.strictEqual(result.wrapperOptions.detached, false);
    });

    it('should parse command with -- separator', () => {
      const result = parseArgs(['--', 'npm', 'test']);
      assert.strictEqual(result.command, 'npm test');
    });

    it('should parse empty command correctly', () => {
      const result = parseArgs([]);
      assert.strictEqual(result.command, '');
    });
  });

  describe('isolation options', () => {
    it('should parse --isolated with value', () => {
      const result = parseArgs(['--isolated', 'tmux', '--', 'npm', 'test']);
      assert.strictEqual(result.wrapperOptions.isolated, 'tmux');
      assert.strictEqual(result.command, 'npm test');
    });

    it('should parse -i shorthand', () => {
      const result = parseArgs(['-i', 'screen', '--', 'npm', 'start']);
      assert.strictEqual(result.wrapperOptions.isolated, 'screen');
      assert.strictEqual(result.command, 'npm start');
    });

    it('should parse --isolated=value format', () => {
      const result = parseArgs(['--isolated=tmux', '--', 'ls', '-la']);
      assert.strictEqual(result.wrapperOptions.isolated, 'tmux');
    });

    it('should normalize backend to lowercase', () => {
      const result = parseArgs(['--isolated', 'TMUX', '--', 'echo', 'test']);
      assert.strictEqual(result.wrapperOptions.isolated, 'tmux');
    });

    it('should throw error for missing backend argument', () => {
      assert.throws(() => {
        parseArgs(['--isolated']);
      }, /requires a backend argument/);
    });
  });

  describe('attached and detached modes', () => {
    it('should parse --attached flag', () => {
      const result = parseArgs([
        '--isolated',
        'tmux',
        '--attached',
        '--',
        'npm',
        'test',
      ]);
      assert.strictEqual(result.wrapperOptions.attached, true);
      assert.strictEqual(result.wrapperOptions.detached, false);
    });

    it('should parse -a shorthand', () => {
      const result = parseArgs(['-i', 'screen', '-a', '--', 'npm', 'start']);
      assert.strictEqual(result.wrapperOptions.attached, true);
    });

    it('should parse --detached flag', () => {
      const result = parseArgs([
        '--isolated',
        'tmux',
        '--detached',
        '--',
        'npm',
        'start',
      ]);
      assert.strictEqual(result.wrapperOptions.detached, true);
      assert.strictEqual(result.wrapperOptions.attached, false);
    });

    it('should parse -d shorthand', () => {
      const result = parseArgs(['-i', 'screen', '-d', '--', 'npm', 'start']);
      assert.strictEqual(result.wrapperOptions.detached, true);
    });

    it('should throw error when both --attached and --detached are set', () => {
      assert.throws(() => {
        parseArgs([
          '--isolated',
          'tmux',
          '--attached',
          '--detached',
          '--',
          'npm',
          'test',
        ]);
      }, /Cannot use both --attached and --detached/);
    });

    it('should provide helpful error message for mode conflict', () => {
      try {
        parseArgs(['-i', 'screen', '-a', '-d', '--', 'npm', 'test']);
        assert.fail('Should have thrown an error');
      } catch (err) {
        assert.ok(err.message.includes('Please choose only one mode'));
      }
    });
  });

  describe('session option', () => {
    it('should parse --session with value', () => {
      const result = parseArgs([
        '--isolated',
        'tmux',
        '--session',
        'my-session',
        '--',
        'npm',
        'test',
      ]);
      assert.strictEqual(result.wrapperOptions.session, 'my-session');
    });

    it('should parse -s shorthand', () => {
      const result = parseArgs([
        '-i',
        'screen',
        '-s',
        'test-session',
        '--',
        'npm',
        'start',
      ]);
      assert.strictEqual(result.wrapperOptions.session, 'test-session');
    });

    it('should parse --session=value format', () => {
      const result = parseArgs([
        '--isolated',
        'tmux',
        '--session=my-session',
        '--',
        'npm',
        'test',
      ]);
      assert.strictEqual(result.wrapperOptions.session, 'my-session');
    });

    it('should throw error for session without isolation', () => {
      assert.throws(() => {
        parseArgs(['--session', 'my-session', '--', 'npm', 'test']);
      }, /--session option is only valid with --isolated/);
    });
  });

  describe('docker image option', () => {
    it('should parse --image with value', () => {
      const result = parseArgs([
        '--isolated',
        'docker',
        '--image',
        'node:20',
        '--',
        'npm',
        'test',
      ]);
      assert.strictEqual(result.wrapperOptions.image, 'node:20');
    });

    it('should parse --image=value format', () => {
      const result = parseArgs([
        '--isolated',
        'docker',
        '--image=alpine:latest',
        '--',
        'ls',
      ]);
      assert.strictEqual(result.wrapperOptions.image, 'alpine:latest');
    });

    it('should throw error for docker without image', () => {
      assert.throws(() => {
        parseArgs(['--isolated', 'docker', '--', 'npm', 'test']);
      }, /Docker isolation requires --image option/);
    });

    it('should throw error for image with non-docker backend', () => {
      assert.throws(() => {
        parseArgs([
          '--isolated',
          'tmux',
          '--image',
          'node:20',
          '--',
          'npm',
          'test',
        ]);
      }, /--image option is only valid with --isolated docker/);
    });
  });

  describe('command without separator', () => {
    it('should parse command after options without separator', () => {
      const result = parseArgs(['-i', 'tmux', '-d', 'npm', 'start']);
      assert.strictEqual(result.wrapperOptions.isolated, 'tmux');
      assert.strictEqual(result.wrapperOptions.detached, true);
      assert.strictEqual(result.command, 'npm start');
    });

    it('should handle mixed options and command', () => {
      const result = parseArgs(['-i', 'screen', 'echo', 'hello']);
      assert.strictEqual(result.wrapperOptions.isolated, 'screen');
      assert.strictEqual(result.command, 'echo hello');
    });
  });

  describe('backend validation', () => {
    it('should accept valid backends', () => {
      for (const backend of VALID_BACKENDS) {
        // Docker requires image, so handle it separately
        if (backend === 'docker') {
          const result = parseArgs([
            '-i',
            backend,
            '--image',
            'alpine',
            '--',
            'echo',
            'test',
          ]);
          assert.strictEqual(result.wrapperOptions.isolated, backend);
        } else {
          const result = parseArgs(['-i', backend, '--', 'echo', 'test']);
          assert.strictEqual(result.wrapperOptions.isolated, backend);
        }
      }
    });

    it('should throw error for invalid backend', () => {
      assert.throws(() => {
        parseArgs(['--isolated', 'invalid-backend', '--', 'npm', 'test']);
      }, /Invalid isolation backend/);
    });

    it('should list valid backends in error message', () => {
      try {
        parseArgs(['--isolated', 'invalid', '--', 'npm', 'test']);
        assert.fail('Should have thrown an error');
      } catch (err) {
        for (const backend of VALID_BACKENDS) {
          assert.ok(
            err.message.includes(backend),
            `Error should mention ${backend}`
          );
        }
      }
    });
  });
});

describe('validateOptions', () => {
  it('should pass for valid options', () => {
    assert.doesNotThrow(() => {
      validateOptions({
        isolated: 'tmux',
        attached: false,
        detached: true,
        session: 'test',
        image: null,
      });
    });
  });

  it('should throw for attached and detached together', () => {
    assert.throws(() => {
      validateOptions({
        isolated: 'screen',
        attached: true,
        detached: true,
        session: null,
        image: null,
      });
    }, /Cannot use both --attached and --detached/);
  });

  it('should pass for docker with image', () => {
    assert.doesNotThrow(() => {
      validateOptions({
        isolated: 'docker',
        attached: false,
        detached: false,
        session: null,
        image: 'node:20',
      });
    });
  });
});

describe('generateSessionName', () => {
  it('should generate unique session names', () => {
    const name1 = generateSessionName();
    const name2 = generateSessionName();
    assert.notStrictEqual(name1, name2);
  });

  it('should use default prefix', () => {
    const name = generateSessionName();
    assert.ok(name.startsWith('start-'));
  });

  it('should use custom prefix', () => {
    const name = generateSessionName('custom');
    assert.ok(name.startsWith('custom-'));
  });

  it('should contain timestamp-like portion', () => {
    const name = generateSessionName();
    // Should have format: prefix-timestamp-random
    const parts = name.split('-');
    assert.ok(parts.length >= 3);
    // Second part should be numeric (timestamp)
    assert.ok(/^\d+$/.test(parts[1]));
  });
});

describe('hasIsolation', () => {
  it('should return true when isolated is set', () => {
    assert.strictEqual(hasIsolation({ isolated: 'tmux' }), true);
  });

  it('should return false when isolated is null', () => {
    assert.strictEqual(hasIsolation({ isolated: null }), false);
  });
});

describe('getEffectiveMode', () => {
  it('should return attached by default', () => {
    const mode = getEffectiveMode({ attached: false, detached: false });
    assert.strictEqual(mode, 'attached');
  });

  it('should return attached when explicitly set', () => {
    const mode = getEffectiveMode({ attached: true, detached: false });
    assert.strictEqual(mode, 'attached');
  });

  it('should return detached when set', () => {
    const mode = getEffectiveMode({ attached: false, detached: true });
    assert.strictEqual(mode, 'detached');
  });
});

describe('VALID_BACKENDS', () => {
  it('should include screen', () => {
    assert.ok(VALID_BACKENDS.includes('screen'));
  });

  it('should include tmux', () => {
    assert.ok(VALID_BACKENDS.includes('tmux'));
  });

  it('should include docker', () => {
    assert.ok(VALID_BACKENDS.includes('docker'));
  });
});

describe('user option', () => {
  it('should parse --user with value', () => {
    const result = parseArgs(['--user', 'john', '--', 'npm', 'test']);
    assert.strictEqual(result.wrapperOptions.user, 'john');
    assert.strictEqual(result.command, 'npm test');
  });

  it('should parse --user=value format', () => {
    const result = parseArgs(['--user=www-data', '--', 'npm', 'start']);
    assert.strictEqual(result.wrapperOptions.user, 'www-data');
  });

  it('should work with isolation options', () => {
    const result = parseArgs([
      '--isolated',
      'screen',
      '--user',
      'john',
      '--',
      'npm',
      'start',
    ]);
    assert.strictEqual(result.wrapperOptions.isolated, 'screen');
    assert.strictEqual(result.wrapperOptions.user, 'john');
    assert.strictEqual(result.command, 'npm start');
  });

  it('should work without isolation (standalone user switch)', () => {
    const result = parseArgs(['--user', 'www-data', '--', 'node', 'server.js']);
    assert.strictEqual(result.wrapperOptions.user, 'www-data');
    assert.strictEqual(result.wrapperOptions.isolated, null);
    assert.strictEqual(result.command, 'node server.js');
  });

  it('should throw error for missing user argument', () => {
    assert.throws(() => {
      parseArgs(['--user']);
    }, /requires a username argument/);
  });

  it('should accept valid usernames', () => {
    const validUsernames = [
      'john',
      'www-data',
      'user123',
      'john-doe',
      'user_1',
    ];
    for (const username of validUsernames) {
      assert.doesNotThrow(() => {
        parseArgs(['--user', username, '--', 'echo', 'test']);
      });
    }
  });

  it('should reject invalid username formats', () => {
    const invalidUsernames = [
      'john@doe',
      'user name',
      'user.name',
      'user/name',
    ];
    for (const username of invalidUsernames) {
      assert.throws(() => {
        parseArgs(['--user', username, '--', 'echo', 'test']);
      }, /Invalid username format/);
    }
  });

  it('should work with docker isolation', () => {
    const result = parseArgs([
      '--isolated',
      'docker',
      '--image',
      'node:20',
      '--user',
      '1000:1000',
      '--',
      'npm',
      'install',
    ]);
    assert.strictEqual(result.wrapperOptions.isolated, 'docker');
    assert.strictEqual(result.wrapperOptions.image, 'node:20');
    assert.strictEqual(result.wrapperOptions.user, '1000:1000');
  });
});
