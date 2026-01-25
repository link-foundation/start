/**
 * Tests for isolation stacking feature (issue #77)
 */

const { describe, it, expect } = require('bun:test');
const {
  parseArgs,
  validateOptions,
  hasStackedIsolation,
  MAX_ISOLATION_DEPTH,
} = require('../src/lib/args-parser');

describe('Isolation Stacking - Args Parser', () => {
  describe('parseArgs with stacked --isolated', () => {
    it('should parse single isolation (backward compatible)', () => {
      const result = parseArgs(['--isolated', 'docker', '--', 'npm', 'test']);
      expect(result.wrapperOptions.isolated).toBe('docker');
      expect(result.wrapperOptions.isolatedStack).toEqual(['docker']);
      expect(result.command).toBe('npm test');
    });

    it('should parse multi-level isolation', () => {
      const result = parseArgs([
        '--isolated',
        'screen ssh docker',
        '--endpoint',
        '_ user@host _',
        '--',
        'npm',
        'test',
      ]);
      expect(result.wrapperOptions.isolated).toBe('screen');
      expect(result.wrapperOptions.isolatedStack).toEqual([
        'screen',
        'ssh',
        'docker',
      ]);
    });

    it('should parse 5-level isolation', () => {
      const result = parseArgs([
        '--isolated',
        'screen ssh tmux ssh docker',
        '--endpoint',
        '_ user@server1 _ user@server2 _',
        '--',
        'npm',
        'test',
      ]);
      expect(result.wrapperOptions.isolatedStack).toEqual([
        'screen',
        'ssh',
        'tmux',
        'ssh',
        'docker',
      ]);
      expect(result.wrapperOptions.endpointStack).toEqual([
        null,
        'user@server1',
        null,
        'user@server2',
        null,
      ]);
    });

    it('should parse --isolated=value syntax', () => {
      const result = parseArgs(['--isolated=screen tmux', '--', 'ls']);
      expect(result.wrapperOptions.isolatedStack).toEqual(['screen', 'tmux']);
    });
  });

  describe('parseArgs with stacked --image', () => {
    it('should parse single image (backward compatible)', () => {
      const result = parseArgs([
        '--isolated',
        'docker',
        '--image',
        'ubuntu:22.04',
        '--',
        'bash',
      ]);
      expect(result.wrapperOptions.image).toBe('ubuntu:22.04');
    });

    it('should parse image sequence with placeholders', () => {
      const result = parseArgs([
        '--isolated',
        'screen docker',
        '--image',
        '_ ubuntu:22.04',
        '--',
        'bash',
      ]);
      expect(result.wrapperOptions.imageStack).toEqual([null, 'ubuntu:22.04']);
    });

    it('should parse --image=value syntax', () => {
      const result = parseArgs([
        '--isolated',
        'docker',
        '--image=alpine:latest',
        '--',
        'sh',
      ]);
      expect(result.wrapperOptions.image).toBe('alpine:latest');
    });
  });

  describe('parseArgs with stacked --endpoint', () => {
    it('should parse single endpoint (backward compatible)', () => {
      const result = parseArgs([
        '--isolated',
        'ssh',
        '--endpoint',
        'user@host',
        '--',
        'ls',
      ]);
      expect(result.wrapperOptions.endpoint).toBe('user@host');
    });

    it('should parse endpoint sequence with placeholders', () => {
      const result = parseArgs([
        '--isolated',
        'screen ssh ssh docker',
        '--endpoint',
        '_ user@host1 user@host2 _',
        '--',
        'bash',
      ]);
      expect(result.wrapperOptions.endpointStack).toEqual([
        null,
        'user@host1',
        'user@host2',
        null,
      ]);
    });
  });

  describe('hasStackedIsolation', () => {
    it('should return true for multi-level', () => {
      const { wrapperOptions } = parseArgs([
        '--isolated',
        'screen docker',
        '--',
        'test',
      ]);
      expect(hasStackedIsolation(wrapperOptions)).toBe(true);
    });

    it('should return false for single level', () => {
      const { wrapperOptions } = parseArgs([
        '--isolated',
        'docker',
        '--',
        'test',
      ]);
      expect(hasStackedIsolation(wrapperOptions)).toBe(false);
    });

    it('should return false for no isolation', () => {
      const { wrapperOptions } = parseArgs(['echo', 'hello']);
      // When no isolation, isolatedStack is null, so hasStackedIsolation returns falsy
      expect(hasStackedIsolation(wrapperOptions)).toBeFalsy();
    });
  });
});

describe('Isolation Stacking - Validation', () => {
  describe('validateOptions', () => {
    it('should validate single backend (backward compatible)', () => {
      const options = {
        isolated: 'docker',
        isolatedStack: ['docker'],
      };
      expect(() => validateOptions(options)).not.toThrow();
      // Should apply default image
      expect(options.imageStack[0]).toBeDefined();
    });

    it('should validate multi-level stack', () => {
      const options = {
        isolated: 'screen',
        isolatedStack: ['screen', 'ssh', 'docker'],
        endpointStack: [null, 'user@host', null],
      };
      expect(() => validateOptions(options)).not.toThrow();
    });

    it('should throw on invalid backend in stack', () => {
      const options = {
        isolated: 'screen',
        isolatedStack: ['screen', 'invalid', 'docker'],
      };
      expect(() => validateOptions(options)).toThrow(/Invalid isolation/);
    });

    it('should throw on missing SSH endpoint', () => {
      const options = {
        isolated: 'ssh',
        isolatedStack: ['ssh'],
        endpointStack: [null],
      };
      expect(() => validateOptions(options)).toThrow(/requires --endpoint/);
    });

    it('should throw on image/stack length mismatch', () => {
      const options = {
        isolated: 'screen',
        isolatedStack: ['screen', 'ssh', 'docker'],
        imageStack: [null, 'ubuntu:22.04'], // Only 2, should be 3
        endpointStack: [null, 'user@host', null],
      };
      expect(() => validateOptions(options)).toThrow(/value\(s\)/);
    });

    it('should throw on depth exceeding limit', () => {
      const tooDeep = Array(MAX_ISOLATION_DEPTH + 1).fill('screen');
      const options = {
        isolated: 'screen',
        isolatedStack: tooDeep,
      };
      expect(() => validateOptions(options)).toThrow(/too deep/);
    });

    it('should distribute single image to all levels', () => {
      const options = {
        isolated: 'screen',
        isolatedStack: ['screen', 'docker', 'docker'],
        image: 'ubuntu:22.04',
      };
      validateOptions(options);
      expect(options.imageStack).toEqual([
        'ubuntu:22.04',
        'ubuntu:22.04',
        'ubuntu:22.04',
      ]);
    });

    it('should apply default docker image for each docker level', () => {
      const options = {
        isolated: 'docker',
        isolatedStack: ['docker'],
      };
      validateOptions(options);
      expect(options.imageStack[0]).toBeDefined();
      expect(options.imageStack[0]).toContain(':'); // Should have image:tag format
    });

    it('should throw if image provided but no docker in stack', () => {
      const options = {
        isolated: 'screen',
        isolatedStack: ['screen', 'tmux'],
        image: 'ubuntu:22.04',
      };
      expect(() => validateOptions(options)).toThrow(/docker/);
    });

    it('should throw if endpoint provided but no ssh in stack', () => {
      const options = {
        isolated: 'screen',
        isolatedStack: ['screen', 'docker'],
        endpoint: 'user@host',
        imageStack: [null, 'ubuntu:22.04'],
      };
      expect(() => validateOptions(options)).toThrow(/ssh/);
    });
  });
});

describe('Isolation Stacking - Backward Compatibility', () => {
  it('should work with existing docker command', () => {
    const result = parseArgs([
      '--isolated',
      'docker',
      '--image',
      'node:18',
      '--',
      'npm',
      'test',
    ]);
    expect(result.wrapperOptions.isolated).toBe('docker');
    expect(result.wrapperOptions.image).toBe('node:18');
    expect(result.wrapperOptions.isolatedStack).toEqual(['docker']);
    expect(result.command).toBe('npm test');
  });

  it('should work with existing ssh command', () => {
    const result = parseArgs([
      '--isolated',
      'ssh',
      '--endpoint',
      'user@server',
      '--',
      'ls',
      '-la',
    ]);
    expect(result.wrapperOptions.isolated).toBe('ssh');
    expect(result.wrapperOptions.endpoint).toBe('user@server');
    expect(result.wrapperOptions.isolatedStack).toEqual(['ssh']);
  });

  it('should work with existing screen command', () => {
    const result = parseArgs([
      '--isolated',
      'screen',
      '--detached',
      '--keep-alive',
      '--',
      'long-running-task',
    ]);
    expect(result.wrapperOptions.isolated).toBe('screen');
    expect(result.wrapperOptions.detached).toBe(true);
    expect(result.wrapperOptions.keepAlive).toBe(true);
    expect(result.wrapperOptions.isolatedStack).toEqual(['screen']);
  });

  it('should work with -i shorthand', () => {
    const result = parseArgs(['-i', 'tmux', '--', 'vim']);
    expect(result.wrapperOptions.isolated).toBe('tmux');
    expect(result.wrapperOptions.isolatedStack).toEqual(['tmux']);
  });

  it('should work with attached mode', () => {
    const result = parseArgs([
      '--isolated',
      'docker',
      '--attached',
      '--image',
      'alpine',
      '--',
      'sh',
    ]);
    expect(result.wrapperOptions.attached).toBe(true);
    expect(result.wrapperOptions.isolated).toBe('docker');
  });

  it('should work with session name', () => {
    const result = parseArgs([
      '--isolated',
      'screen',
      '--session',
      'my-session',
      '--',
      'bash',
    ]);
    expect(result.wrapperOptions.session).toBe('my-session');
  });

  it('should work with session-id', () => {
    const result = parseArgs([
      '--isolated',
      'docker',
      '--image',
      'alpine',
      '--session-id',
      '12345678-1234-4123-8123-123456789012',
      '--',
      'echo',
      'hi',
    ]);
    expect(result.wrapperOptions.sessionId).toBe(
      '12345678-1234-4123-8123-123456789012'
    );
  });
});
