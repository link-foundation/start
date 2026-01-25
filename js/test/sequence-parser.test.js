/**
 * Tests for sequence-parser.js
 * Isolation stacking feature for issue #77
 */

const { describe, it, expect } = require('bun:test');
const {
  parseSequence,
  formatSequence,
  shiftSequence,
  isSequence,
  distributeOption,
  getValueAtLevel,
  formatIsolationChain,
  buildNextLevelOptions,
} = require('../src/lib/sequence-parser');

describe('Sequence Parser', () => {
  describe('parseSequence', () => {
    it('should parse single value', () => {
      expect(parseSequence('docker')).toEqual(['docker']);
    });

    it('should parse space-separated sequence', () => {
      expect(parseSequence('screen ssh docker')).toEqual([
        'screen',
        'ssh',
        'docker',
      ]);
    });

    it('should parse sequence with underscores as null', () => {
      expect(parseSequence('_ ssh _ docker')).toEqual([
        null,
        'ssh',
        null,
        'docker',
      ]);
    });

    it('should handle all underscores', () => {
      expect(parseSequence('_ _ _')).toEqual([null, null, null]);
    });

    it('should handle empty string', () => {
      expect(parseSequence('')).toEqual([]);
    });

    it('should handle null/undefined', () => {
      expect(parseSequence(null)).toEqual([]);
      expect(parseSequence(undefined)).toEqual([]);
    });

    it('should trim whitespace', () => {
      expect(parseSequence('  screen  ssh  ')).toEqual(['screen', 'ssh']);
    });

    it('should handle multiple spaces between values', () => {
      expect(parseSequence('screen   ssh   docker')).toEqual([
        'screen',
        'ssh',
        'docker',
      ]);
    });
  });

  describe('formatSequence', () => {
    it('should format array with values', () => {
      expect(formatSequence(['screen', 'ssh', 'docker'])).toBe(
        'screen ssh docker'
      );
    });

    it('should format array with nulls as underscores', () => {
      expect(formatSequence([null, 'ssh', null, 'docker'])).toBe(
        '_ ssh _ docker'
      );
    });

    it('should handle empty array', () => {
      expect(formatSequence([])).toBe('');
    });

    it('should handle non-array', () => {
      expect(formatSequence(null)).toBe('');
      expect(formatSequence(undefined)).toBe('');
    });
  });

  describe('shiftSequence', () => {
    it('should remove first element', () => {
      expect(shiftSequence(['screen', 'ssh', 'docker'])).toEqual([
        'ssh',
        'docker',
      ]);
    });

    it('should handle nulls', () => {
      expect(shiftSequence([null, 'ssh', null])).toEqual(['ssh', null]);
    });

    it('should handle single element', () => {
      expect(shiftSequence(['docker'])).toEqual([]);
    });

    it('should handle empty array', () => {
      expect(shiftSequence([])).toEqual([]);
    });
  });

  describe('isSequence', () => {
    it('should return true for space-separated values', () => {
      expect(isSequence('screen ssh docker')).toBe(true);
    });

    it('should return false for single value', () => {
      expect(isSequence('docker')).toBe(false);
    });

    it('should return false for non-string', () => {
      expect(isSequence(null)).toBe(false);
      expect(isSequence(undefined)).toBe(false);
      expect(isSequence(123)).toBe(false);
    });
  });

  describe('distributeOption', () => {
    it('should replicate single value for all levels', () => {
      expect(distributeOption('ubuntu:22.04', 3, '--image')).toEqual([
        'ubuntu:22.04',
        'ubuntu:22.04',
        'ubuntu:22.04',
      ]);
    });

    it('should parse sequence with matching length', () => {
      expect(distributeOption('_ _ ubuntu:22.04', 3, '--image')).toEqual([
        null,
        null,
        'ubuntu:22.04',
      ]);
    });

    it('should throw on length mismatch', () => {
      expect(() => distributeOption('_ _', 3, '--image')).toThrow();
    });

    it('should handle null/undefined value', () => {
      expect(distributeOption(null, 3, '--image')).toEqual([null, null, null]);
    });
  });

  describe('getValueAtLevel', () => {
    it('should get value at valid index', () => {
      expect(getValueAtLevel(['a', 'b', 'c'], 1)).toBe('b');
    });

    it('should handle nulls', () => {
      expect(getValueAtLevel([null, 'b', null], 0)).toBe(null);
      expect(getValueAtLevel([null, 'b', null], 1)).toBe('b');
    });

    it('should return null for out of bounds', () => {
      expect(getValueAtLevel(['a', 'b'], 5)).toBe(null);
      expect(getValueAtLevel(['a', 'b'], -1)).toBe(null);
    });

    it('should handle non-array', () => {
      expect(getValueAtLevel(null, 0)).toBe(null);
    });
  });

  describe('formatIsolationChain', () => {
    it('should format simple chain', () => {
      expect(formatIsolationChain(['screen', 'tmux', 'docker'])).toBe(
        'screen → tmux → docker'
      );
    });

    it('should add SSH endpoint', () => {
      const options = { endpointStack: [null, 'user@host', null] };
      expect(formatIsolationChain(['screen', 'ssh', 'docker'], options)).toBe(
        'screen → ssh@user@host → docker'
      );
    });

    it('should add Docker image short name', () => {
      const options = { imageStack: [null, null, 'oven/bun:latest'] };
      expect(formatIsolationChain(['screen', 'ssh', 'docker'], options)).toBe(
        'screen → ssh → docker:bun'
      );
    });

    it('should handle placeholders', () => {
      expect(formatIsolationChain([null, 'ssh', null])).toBe('_ → ssh → _');
    });

    it('should handle empty array', () => {
      expect(formatIsolationChain([])).toBe('');
    });
  });

  describe('buildNextLevelOptions', () => {
    it('should shift all stacks', () => {
      const options = {
        isolated: 'screen',
        isolatedStack: ['screen', 'ssh', 'docker'],
        image: null,
        imageStack: [null, null, 'ubuntu:22.04'],
        endpoint: null,
        endpointStack: [null, 'user@host', null],
      };

      const next = buildNextLevelOptions(options);

      expect(next.isolated).toBe('ssh');
      expect(next.isolatedStack).toEqual(['ssh', 'docker']);
      expect(next.image).toBe(null);
      expect(next.imageStack).toEqual([null, 'ubuntu:22.04']);
      expect(next.endpoint).toBe('user@host');
      expect(next.endpointStack).toEqual(['user@host', null]);
    });

    it('should handle last level', () => {
      const options = {
        isolated: 'docker',
        isolatedStack: ['docker'],
        imageStack: ['ubuntu:22.04'],
      };

      const next = buildNextLevelOptions(options);

      expect(next.isolated).toBe(null);
      expect(next.isolatedStack).toEqual([]);
    });
  });
});
