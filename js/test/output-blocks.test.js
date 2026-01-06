/**
 * Tests for output-blocks module
 */

const { describe, it, expect } = require('bun:test');

const {
  BOX_STYLES,
  DEFAULT_STYLE,
  DEFAULT_WIDTH,
  getBoxStyle,
  createStartBlock,
  createFinishBlock,
  formatDuration,
  escapeForLinksNotation,
  formatAsNestedLinksNotation,
} = require('../src/lib/output-blocks');

describe('output-blocks module', () => {
  describe('BOX_STYLES', () => {
    it('should have all expected styles', () => {
      expect(BOX_STYLES).toHaveProperty('rounded');
      expect(BOX_STYLES).toHaveProperty('heavy');
      expect(BOX_STYLES).toHaveProperty('double');
      expect(BOX_STYLES).toHaveProperty('simple');
      expect(BOX_STYLES).toHaveProperty('ascii');
    });

    it('should have correct rounded style characters', () => {
      expect(BOX_STYLES.rounded.topLeft).toBe('╭');
      expect(BOX_STYLES.rounded.topRight).toBe('╮');
      expect(BOX_STYLES.rounded.bottomLeft).toBe('╰');
      expect(BOX_STYLES.rounded.bottomRight).toBe('╯');
    });
  });

  describe('getBoxStyle', () => {
    it('should return rounded style by default', () => {
      const style = getBoxStyle();
      expect(style).toEqual(BOX_STYLES.rounded);
    });

    it('should return requested style', () => {
      expect(getBoxStyle('heavy')).toEqual(BOX_STYLES.heavy);
      expect(getBoxStyle('double')).toEqual(BOX_STYLES.double);
      expect(getBoxStyle('ascii')).toEqual(BOX_STYLES.ascii);
    });

    it('should return rounded for unknown style', () => {
      const style = getBoxStyle('unknown');
      expect(style).toEqual(BOX_STYLES.rounded);
    });
  });

  describe('createStartBlock', () => {
    it('should create a start block with session ID', () => {
      const block = createStartBlock({
        sessionId: 'test-uuid-1234',
        timestamp: '2025-01-01 00:00:00',
        command: 'echo hello',
      });

      expect(block).toContain('╭');
      expect(block).toContain('╰');
      expect(block).toContain('Session ID: test-uuid-1234');
      expect(block).toContain('Starting at 2025-01-01 00:00:00: echo hello');
    });

    it('should use specified style', () => {
      const block = createStartBlock({
        sessionId: 'test-uuid',
        timestamp: '2025-01-01 00:00:00',
        command: 'echo hello',
        style: 'ascii',
      });

      expect(block).toContain('+');
      expect(block).toContain('-');
    });
  });

  describe('createFinishBlock', () => {
    it('should create a finish block with session ID and exit code', () => {
      const block = createFinishBlock({
        sessionId: 'test-uuid-1234',
        timestamp: '2025-01-01 00:00:01',
        exitCode: 0,
        logPath: '/tmp/test.log',
        durationMs: 17,
      });

      expect(block).toContain('╭');
      expect(block).toContain('╰');
      expect(block).toContain('Session ID: test-uuid-1234');
      expect(block).toContain(
        'Finished at 2025-01-01 00:00:01 in 0.017 seconds'
      );
      expect(block).toContain('Exit code: 0');
      expect(block).toContain('Log: /tmp/test.log');
    });

    it('should create a finish block without duration when not provided', () => {
      const block = createFinishBlock({
        sessionId: 'test-uuid-1234',
        timestamp: '2025-01-01 00:00:01',
        exitCode: 0,
        logPath: '/tmp/test.log',
      });

      expect(block).toContain('Finished at 2025-01-01 00:00:01');
      expect(block).not.toContain('seconds');
    });
  });

  describe('formatDuration', () => {
    it('should format very small durations', () => {
      expect(formatDuration(0.5)).toBe('0.001');
    });

    it('should format millisecond durations', () => {
      expect(formatDuration(17)).toBe('0.017');
      expect(formatDuration(500)).toBe('0.500');
    });

    it('should format second durations', () => {
      expect(formatDuration(1000)).toBe('1.000');
      expect(formatDuration(5678)).toBe('5.678');
    });

    it('should format longer durations with less precision', () => {
      expect(formatDuration(12345)).toBe('12.35');
      expect(formatDuration(123456)).toBe('123.5');
    });
  });

  describe('escapeForLinksNotation', () => {
    it('should not quote simple values', () => {
      expect(escapeForLinksNotation('simple')).toBe('simple');
      expect(escapeForLinksNotation('123')).toBe('123');
      expect(escapeForLinksNotation('true')).toBe('true');
    });

    it('should quote values with spaces', () => {
      expect(escapeForLinksNotation('hello world')).toBe('"hello world"');
    });

    it('should quote values with colons', () => {
      expect(escapeForLinksNotation('key:value')).toBe('"key:value"');
    });

    it('should use single quotes for values with double quotes', () => {
      expect(escapeForLinksNotation('say "hello"')).toBe('\'say "hello"\'');
    });

    it('should use double quotes for values with single quotes', () => {
      expect(escapeForLinksNotation("it's cool")).toBe('"it\'s cool"');
    });

    it('should escape quotes when both types are present', () => {
      const result = escapeForLinksNotation('say "hello" it\'s');
      // Should wrap in one quote type and escape the other
      expect(result).toMatch(/^["'].*["']$/);
    });

    it('should handle null values', () => {
      expect(escapeForLinksNotation(null)).toBe('null');
      expect(escapeForLinksNotation(undefined)).toBe('null');
    });
  });

  describe('formatAsNestedLinksNotation', () => {
    it('should format simple objects', () => {
      const obj = { key: 'value', number: 123 };
      const result = formatAsNestedLinksNotation(obj);

      expect(result).toContain('key value');
      expect(result).toContain('number 123');
    });

    it('should quote values with spaces', () => {
      const obj = { message: 'hello world' };
      const result = formatAsNestedLinksNotation(obj);

      expect(result).toContain('message "hello world"');
    });

    it('should handle empty objects', () => {
      expect(formatAsNestedLinksNotation({})).toBe('()');
    });

    it('should handle null', () => {
      expect(formatAsNestedLinksNotation(null)).toBe('null');
    });
  });
});

console.log('=== Output Blocks Unit Tests ===');
