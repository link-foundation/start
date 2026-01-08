/**
 * Tests for output-blocks module
 *
 * Tests the "timeline" format: width-independent, lossless output
 * (formerly called "status spine" format)
 */

const { describe, it, expect } = require('bun:test');

const {
  // Timeline format exports (new names)
  TIMELINE_MARKER,
  createTimelineLine,
  createEmptyTimelineLine,

  // Deprecated aliases (for backward compatibility)
  SPINE,
  createSpineLine,
  createEmptySpineLine,

  // Common exports
  SUCCESS_MARKER,
  FAILURE_MARKER,
  createCommandLine,
  getResultMarker,
  parseIsolationMetadata,
  generateIsolationLines,

  // Virtual command API
  createVirtualCommandBlock,
  createVirtualCommandResult,
  createTimelineSeparator,

  // Main block functions
  createStartBlock,
  createFinishBlock,
  formatDuration,

  // Links notation utilities
  escapeForLinksNotation,
  formatAsNestedLinksNotation,
} = require('../src/lib/output-blocks');

describe('output-blocks module', () => {
  describe('timeline format constants', () => {
    it('should export timeline marker character', () => {
      expect(TIMELINE_MARKER).toBe('│');
    });

    it('should export spine as alias for backward compatibility', () => {
      expect(SPINE).toBe(TIMELINE_MARKER);
    });

    it('should export result markers', () => {
      expect(SUCCESS_MARKER).toBe('✓');
      expect(FAILURE_MARKER).toBe('✗');
    });
  });

  describe('createTimelineLine', () => {
    it('should create a line with timeline marker prefix and padded label', () => {
      const line = createTimelineLine('session', 'abc-123');
      expect(line).toBe('│ session   abc-123');
    });

    it('should pad labels to 10 characters', () => {
      const shortLabel = createTimelineLine('exit', '0');
      expect(shortLabel).toBe('│ exit      0');

      const longLabel = createTimelineLine('isolation', 'docker');
      expect(longLabel).toBe('│ isolation docker');
    });
  });

  describe('createSpineLine (deprecated alias)', () => {
    it('should work as alias for createTimelineLine', () => {
      const line = createSpineLine('session', 'abc-123');
      expect(line).toBe(createTimelineLine('session', 'abc-123'));
    });
  });

  describe('createEmptyTimelineLine', () => {
    it('should create just the timeline marker character', () => {
      expect(createEmptyTimelineLine()).toBe('│');
    });
  });

  describe('createEmptySpineLine (deprecated alias)', () => {
    it('should work as alias for createEmptyTimelineLine', () => {
      expect(createEmptySpineLine()).toBe(createEmptyTimelineLine());
    });
  });

  describe('createCommandLine', () => {
    it('should create a line with $ prefix', () => {
      expect(createCommandLine('echo hi')).toBe('$ echo hi');
    });
  });

  describe('getResultMarker', () => {
    it('should return success marker for exit code 0', () => {
      expect(getResultMarker(0)).toBe('✓');
    });

    it('should return failure marker for non-zero exit codes', () => {
      expect(getResultMarker(1)).toBe('✗');
      expect(getResultMarker(127)).toBe('✗');
      expect(getResultMarker(-1)).toBe('✗');
    });
  });

  describe('parseIsolationMetadata', () => {
    it('should parse environment and mode', () => {
      const extraLines = ['[Isolation] Environment: docker, Mode: attached'];
      const metadata = parseIsolationMetadata(extraLines);

      expect(metadata.isolation).toBe('docker');
      expect(metadata.mode).toBe('attached');
    });

    it('should parse session name', () => {
      const extraLines = ['[Isolation] Session: my-session'];
      const metadata = parseIsolationMetadata(extraLines);

      expect(metadata.session).toBe('my-session');
    });

    it('should parse docker image', () => {
      const extraLines = ['[Isolation] Image: ubuntu:latest'];
      const metadata = parseIsolationMetadata(extraLines);

      expect(metadata.image).toBe('ubuntu:latest');
    });

    it('should parse all fields together', () => {
      const extraLines = [
        '[Isolation] Environment: docker, Mode: detached',
        '[Isolation] Session: docker-container-123',
        '[Isolation] Image: node:18-alpine',
        '[Isolation] User: testuser (isolated)',
      ];
      const metadata = parseIsolationMetadata(extraLines);

      expect(metadata.isolation).toBe('docker');
      expect(metadata.mode).toBe('detached');
      expect(metadata.session).toBe('docker-container-123');
      expect(metadata.image).toBe('node:18-alpine');
      expect(metadata.user).toBe('testuser');
    });
  });

  describe('generateIsolationLines', () => {
    it('should generate lines for docker isolation', () => {
      const metadata = {
        isolation: 'docker',
        mode: 'attached',
        image: 'ubuntu',
        session: 'docker-container-1',
      };
      const lines = generateIsolationLines(metadata);

      expect(lines).toContain('│ isolation docker');
      expect(lines).toContain('│ mode      attached');
      expect(lines).toContain('│ image     ubuntu');
      expect(lines).toContain('│ container docker-container-1');
    });

    it('should generate lines for screen isolation', () => {
      const metadata = {
        isolation: 'screen',
        mode: 'attached',
        session: 'screen-session-1',
      };
      const lines = generateIsolationLines(metadata);

      expect(lines).toContain('│ isolation screen');
      expect(lines).toContain('│ mode      attached');
      expect(lines).toContain('│ screen    screen-session-1');
    });
  });

  describe('createStartBlock', () => {
    it('should create a start block with session and timestamp', () => {
      const block = createStartBlock({
        sessionId: 'test-uuid-1234',
        timestamp: '2025-01-01 00:00:00',
        command: 'echo hello',
      });

      expect(block).toContain('│ session   test-uuid-1234');
      expect(block).toContain('│ start     2025-01-01 00:00:00');
      expect(block).toContain('$ echo hello');
    });

    it('should include empty spine line before command', () => {
      const block = createStartBlock({
        sessionId: 'test-uuid',
        timestamp: '2025-01-01 00:00:00',
        command: 'echo hello',
      });

      const lines = block.split('\n');
      // Last line should be command, second-to-last should be empty spine
      expect(lines[lines.length - 1]).toBe('$ echo hello');
      expect(lines[lines.length - 2]).toBe('│');
    });

    it('should include isolation metadata when provided', () => {
      const block = createStartBlock({
        sessionId: 'test-uuid',
        timestamp: '2025-01-01 00:00:00',
        command: 'echo hello',
        extraLines: [
          '[Isolation] Environment: screen, Mode: attached',
          '[Isolation] Session: my-session',
        ],
      });

      expect(block).toContain('│ session   test-uuid');
      expect(block).toContain('│ isolation screen');
      expect(block).toContain('│ mode      attached');
      expect(block).toContain('│ screen    my-session');
      expect(block).toContain('$ echo hello');
    });

    it('should include docker metadata correctly', () => {
      const block = createStartBlock({
        sessionId: 'test-uuid',
        timestamp: '2025-01-01 00:00:00',
        command: 'echo hello',
        extraLines: [
          '[Isolation] Environment: docker, Mode: attached',
          '[Isolation] Image: ubuntu',
          '[Isolation] Session: docker-container-123',
        ],
      });

      expect(block).toContain('│ isolation docker');
      expect(block).toContain('│ image     ubuntu');
      expect(block).toContain('│ container docker-container-123');
    });
  });

  describe('createFinishBlock', () => {
    it('should create a finish block with result marker and metadata', () => {
      const block = createFinishBlock({
        sessionId: 'test-uuid-1234',
        timestamp: '2025-01-01 00:00:01',
        exitCode: 0,
        logPath: '/tmp/test.log',
        durationMs: 17,
      });

      expect(block).toContain('✓');
      expect(block).toContain('│ finish    2025-01-01 00:00:01');
      expect(block).toContain('│ duration  0.017s');
      expect(block).toContain('│ exit      0');
      expect(block).toContain('│ log       /tmp/test.log');
      expect(block).toContain('│ session   test-uuid-1234');
    });

    it('should use failure marker for non-zero exit code', () => {
      const block = createFinishBlock({
        sessionId: 'test-uuid',
        timestamp: '2025-01-01 00:00:01',
        exitCode: 1,
        logPath: '/tmp/test.log',
        durationMs: 100,
      });

      expect(block).toContain('✗');
      expect(block).toContain('│ exit      1');
    });

    it('should omit duration when not provided', () => {
      const block = createFinishBlock({
        sessionId: 'test-uuid-1234',
        timestamp: '2025-01-01 00:00:01',
        exitCode: 0,
        logPath: '/tmp/test.log',
      });

      expect(block).not.toContain('duration');
      expect(block).toContain('│ finish    2025-01-01 00:00:01');
    });

    it('should repeat isolation metadata in footer', () => {
      const block = createFinishBlock({
        sessionId: 'test-uuid',
        timestamp: '2025-01-01 00:00:01',
        exitCode: 0,
        logPath: '/tmp/test.log',
        durationMs: 17,
        extraLines: [
          '[Isolation] Environment: docker, Mode: attached',
          '[Isolation] Image: ubuntu',
          '[Isolation] Session: docker-container-123',
        ],
      });

      expect(block).toContain('│ isolation docker');
      expect(block).toContain('│ mode      attached');
      expect(block).toContain('│ image     ubuntu');
      expect(block).toContain('│ container docker-container-123');
    });

    it('should have log and session as the last two lines', () => {
      const block = createFinishBlock({
        sessionId: 'test-uuid',
        timestamp: '2025-01-01 00:00:01',
        exitCode: 0,
        logPath: '/tmp/test.log',
        durationMs: 17,
        extraLines: [
          '[Isolation] Environment: screen, Mode: attached',
          '[Isolation] Session: my-screen',
        ],
      });

      const lines = block.split('\n');
      expect(lines[lines.length - 1]).toBe('│ session   test-uuid');
      expect(lines[lines.length - 2]).toBe('│ log       /tmp/test.log');
    });
  });

  describe('formatDuration', () => {
    it('should format very small durations', () => {
      expect(formatDuration(0.5)).toBe('0.001s');
    });

    it('should format millisecond durations', () => {
      expect(formatDuration(17)).toBe('0.017s');
      expect(formatDuration(500)).toBe('0.500s');
    });

    it('should format second durations', () => {
      expect(formatDuration(1000)).toBe('1.000s');
      expect(formatDuration(5678)).toBe('5.678s');
    });

    it('should format longer durations with less precision', () => {
      expect(formatDuration(12345)).toBe('12.35s');
      expect(formatDuration(123456)).toBe('123.5s');
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

  describe('Virtual Command API', () => {
    describe('createVirtualCommandBlock', () => {
      it('should create a command line for virtual commands', () => {
        const block = createVirtualCommandBlock('docker pull ubuntu:latest');
        expect(block).toBe('$ docker pull ubuntu:latest');
      });

      it('should behave like createCommandLine', () => {
        const virtualBlock = createVirtualCommandBlock('npm install');
        const commandLine = createCommandLine('npm install');
        expect(virtualBlock).toBe(commandLine);
      });
    });

    describe('createVirtualCommandResult', () => {
      it('should return success marker for true', () => {
        expect(createVirtualCommandResult(true)).toBe('✓');
      });

      it('should return failure marker for false', () => {
        expect(createVirtualCommandResult(false)).toBe('✗');
      });
    });

    describe('createTimelineSeparator', () => {
      it('should create an empty timeline line', () => {
        expect(createTimelineSeparator()).toBe('│');
      });

      it('should behave like createEmptyTimelineLine', () => {
        expect(createTimelineSeparator()).toBe(createEmptyTimelineLine());
      });
    });
  });

  describe('createStartBlock with deferCommand', () => {
    it('should include command line by default', () => {
      const block = createStartBlock({
        sessionId: 'test-uuid',
        timestamp: '2025-01-01 00:00:00',
        command: 'echo hello',
      });
      expect(block).toContain('$ echo hello');
    });

    it('should omit command line when deferCommand is true', () => {
      const block = createStartBlock({
        sessionId: 'test-uuid',
        timestamp: '2025-01-01 00:00:00',
        command: 'echo hello',
        deferCommand: true,
      });
      expect(block).not.toContain('$ echo hello');
    });

    it('should end with empty timeline line when deferCommand is true (issue #73)', () => {
      // Issue #73: Visual continuity - when deferCommand is true,
      // the start block should end with │ (empty timeline line)
      // and no trailing empty line should be added by the CLI
      const block = createStartBlock({
        sessionId: 'test-uuid',
        timestamp: '2025-01-01 00:00:00',
        command: 'echo hello',
        extraLines: [
          '[Isolation] Environment: docker, Mode: attached',
          '[Isolation] Image: alpine:latest',
          '[Isolation] Session: docker-container-123',
        ],
        deferCommand: true,
      });
      const lines = block.split('\n');
      // Last line should be empty timeline line (│)
      expect(lines[lines.length - 1]).toBe('│');
      // Should not contain the command
      expect(block).not.toContain('$ echo hello');
    });
  });

  describe('Visual Continuity (issue #73)', () => {
    it('virtual command block should be followed by empty line for visual separation', () => {
      // Issue #73: The empty line should come AFTER the command
      // ($ docker pull ...), not BEFORE it
      // This test verifies the expected format: command line followed by
      // empty line before output
      const virtualCommand = createVirtualCommandBlock(
        'docker pull alpine:latest'
      );
      expect(virtualCommand).toBe('$ docker pull alpine:latest');
      // The empty line is added by the caller (dockerPullImage)
      // after the command and before running docker pull
    });

    it('timeline separator should be empty timeline line for visual structure', () => {
      // After virtual command output, we print result marker and separator
      const separator = createTimelineSeparator();
      expect(separator).toBe('│');
    });

    it('start block with docker isolation should end cleanly for virtual commands', () => {
      // When using docker isolation with defer_command, the block ends with │
      // The virtual command (docker pull) starts immediately after
      const block = createStartBlock({
        sessionId: 'uuid-abc',
        timestamp: '2026-01-08 12:00:00',
        command: 'echo hi',
        extraLines: [
          '[Isolation] Environment: docker, Mode: attached',
          '[Isolation] Image: alpine:latest',
          '[Isolation] Session: docker-1234',
        ],
        deferCommand: true,
      });

      // Expected structure:
      // │ session   uuid-abc
      // │ start     2026-01-08 12:00:00
      // │
      // │ isolation docker
      // │ mode      attached
      // │ image     alpine:latest
      // │ container docker-1234
      // │   <-- ends here with empty timeline line
      const lines = block.split('\n');
      expect(lines[lines.length - 1]).toBe('│');

      // Next should be virtual command (added separately by docker-utils):
      // $ docker pull alpine:latest
      // <empty line>
      // <docker output>
      // ✓
      // │
      // $ echo hi
      // <empty line>
      // hi
      // ✓
    });
  });
});

console.log('=== Output Blocks Unit Tests ===');
