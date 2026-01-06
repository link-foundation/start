#!/usr/bin/env bun
/**
 * Integration tests for echo command across all isolation modes
 *
 * Issue #55: Ensure `echo "hi"` works reliably in all modes with proper output
 *
 * These tests verify:
 * 1. Command output is captured and displayed
 * 2. Start and finish blocks are properly formatted
 * 3. Empty lines exist before and after command output
 * 4. Log paths and session IDs are not truncated (fully copyable)
 */

const { describe, it, beforeAll, afterAll } = require('node:test');
const assert = require('assert');
const { execSync, spawn } = require('child_process');
const path = require('path');
const {
  isCommandAvailable,
  canRunLinuxDockerImages,
} = require('../src/lib/isolation');

// Path to the CLI
const CLI_PATH = path.join(__dirname, '..', 'src', 'bin', 'cli.js');

// Helper function to run the CLI and capture output
function runCli(args, options = {}) {
  const timeout = options.timeout || 30000;
  try {
    const result = execSync(`bun run ${CLI_PATH} ${args}`, {
      encoding: 'utf8',
      timeout,
      env: {
        ...process.env,
        START_DISABLE_AUTO_ISSUE: '1',
        START_DISABLE_TRACKING: '1',
      },
      maxBuffer: 1024 * 1024, // 1MB
    });
    return { success: true, output: result };
  } catch (err) {
    return {
      success: false,
      output: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  }
}

// Verify output contains expected structure
function verifyOutputStructure(output, expectedCommand = 'echo hi') {
  // Should contain start block
  assert.ok(
    output.includes('╭'),
    'Output should contain start block top border'
  );
  assert.ok(output.includes('╰'), 'Output should contain block bottom border');
  assert.ok(output.includes('Session ID:'), 'Output should contain Session ID');
  assert.ok(
    output.includes('Starting at'),
    'Output should contain Starting at timestamp'
  );

  // Should contain command output
  assert.ok(
    output.includes('hi'),
    'Output should contain the "hi" command output'
  );

  // Should contain finish block
  assert.ok(
    output.includes('Finished at'),
    'Output should contain Finished at timestamp'
  );
  assert.ok(output.includes('Exit code:'), 'Output should contain Exit code');
  assert.ok(output.includes('Log:'), 'Output should contain Log path');

  // Verify there are empty lines around output (structure check)
  const lines = output.split('\n');
  const outputIndex = lines.findIndex((l) => l.trim() === 'hi');

  if (outputIndex > 0) {
    // Check for empty line before "hi"
    const lineBefore = lines[outputIndex - 1];
    // Line before should be empty or end of start block
    assert.ok(
      lineBefore.trim() === '' || lineBefore.includes('╰'),
      `Expected empty line or block end before output, got: "${lineBefore}"`
    );
  }

  if (outputIndex >= 0 && outputIndex < lines.length - 1) {
    // Check for empty line after "hi"
    const lineAfter = lines[outputIndex + 1];
    // Line after should be empty or start of finish block
    assert.ok(
      lineAfter.trim() === '' || lineAfter.includes('╭'),
      `Expected empty line or block start after output, got: "${lineAfter}"`
    );
  }
}

// Verify log path is not truncated
function verifyLogPathNotTruncated(output) {
  const logMatch = output.match(/Log: (.+)/);
  assert.ok(logMatch, 'Should have Log line');
  const logPath = logMatch[1].trim();
  // Remove trailing box border character if present
  const cleanPath = logPath.replace(/\s*│\s*$/, '').trim();

  // Log path should end with .log extension
  assert.ok(
    cleanPath.endsWith('.log'),
    `Log path should end with .log extension, got: "${cleanPath}"`
  );
}

describe('Echo Integration Tests - Issue #55', () => {
  describe('No Isolation Mode (Direct Execution)', () => {
    it('should execute echo hi and show output with proper formatting', () => {
      const result = runCli('echo hi');

      assert.ok(result.success, 'Command should succeed');
      verifyOutputStructure(result.output);
      verifyLogPathNotTruncated(result.output);

      console.log('  ✓ No isolation mode: echo hi works correctly');
    });

    it('should execute echo with single quotes', () => {
      const result = runCli("'echo hi'");

      assert.ok(result.success, 'Command should succeed');
      assert.ok(result.output.includes('hi'), 'Output should contain "hi"');

      console.log('  ✓ No isolation mode: echo with single quotes works');
    });

    it('should execute echo with double quotes', () => {
      const result = runCli('\'echo "hi"\'');

      assert.ok(result.success, 'Command should succeed');
      assert.ok(result.output.includes('hi'), 'Output should contain "hi"');

      console.log('  ✓ No isolation mode: echo with double quotes works');
    });
  });

  describe('Screen Isolation Mode', () => {
    const screenAvailable = isCommandAvailable('screen');

    if (!screenAvailable) {
      it('should skip screen tests when screen is not installed', () => {
        console.log('  ⚠ screen not installed, skipping screen tests');
        assert.ok(true);
      });
      return;
    }

    it('should execute echo hi in attached screen mode with proper formatting', () => {
      const result = runCli('--isolated screen -- echo hi', { timeout: 30000 });

      assert.ok(
        result.success,
        `Command should succeed. Output: ${result.output || result.stderr}`
      );
      verifyOutputStructure(result.output);
      verifyLogPathNotTruncated(result.output);

      // Should show isolation info
      assert.ok(
        result.output.includes('[Isolation] Environment: screen'),
        'Should show screen isolation info'
      );

      console.log('  ✓ Screen isolation (attached): echo hi works correctly');
    });

    it('should execute echo with quotes in screen mode', () => {
      const result = runCli('--isolated screen -- echo "hello world"', {
        timeout: 30000,
      });

      assert.ok(
        result.success,
        `Command should succeed. Output: ${result.output || result.stderr}`
      );
      assert.ok(
        result.output.includes('hello world'),
        'Output should contain "hello world"'
      );

      console.log('  ✓ Screen isolation: echo with quotes works');
    });
  });

  describe('Tmux Isolation Mode', () => {
    const tmuxAvailable = isCommandAvailable('tmux');

    if (!tmuxAvailable) {
      it('should skip tmux tests when tmux is not installed', () => {
        console.log('  ⚠ tmux not installed, skipping tmux tests');
        assert.ok(true);
      });
      return;
    }

    it('should execute echo hi in detached tmux mode', () => {
      // Test detached mode only since attached mode requires TTY
      const sessionName = `test-echo-${Date.now()}`;
      const result = runCli(
        `--isolated tmux -d --session ${sessionName} -- echo hi`,
        { timeout: 10000 }
      );

      // Detached mode should succeed (command starts in background)
      assert.ok(
        result.success,
        `Command should succeed. Output: ${result.output || result.stderr}`
      );

      // Should show isolation info
      assert.ok(
        result.output.includes('[Isolation] Environment: tmux'),
        'Should show tmux isolation info'
      );

      // Cleanup: kill the tmux session
      try {
        execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'ignore' });
      } catch {
        // Session may have already exited
      }

      console.log('  ✓ Tmux isolation (detached): echo hi starts correctly');
    });
  });

  describe('Docker Isolation Mode', () => {
    const dockerAvailable = canRunLinuxDockerImages();

    if (!dockerAvailable) {
      it('should skip docker tests when docker is not available or cannot run Linux containers', () => {
        console.log(
          '  ⚠ docker not available or cannot run Linux containers, skipping docker tests'
        );
        assert.ok(true);
      });
      return;
    }

    it('should execute echo hi in docker mode with proper formatting', () => {
      const containerName = `test-echo-${Date.now()}`;
      const result = runCli(
        `--isolated docker --image alpine:latest --session ${containerName} -- echo hi`,
        { timeout: 60000 }
      );

      assert.ok(
        result.success,
        `Command should succeed. Output: ${result.output || result.stderr}`
      );
      verifyOutputStructure(result.output);
      verifyLogPathNotTruncated(result.output);

      // Should show isolation info
      assert.ok(
        result.output.includes('[Isolation] Environment: docker'),
        'Should show docker isolation info'
      );
      assert.ok(
        result.output.includes('[Isolation] Image: alpine:latest'),
        'Should show docker image info'
      );

      console.log('  ✓ Docker isolation: echo hi works correctly');
    });
  });

  describe('Output Block Formatting', () => {
    it('should not truncate long log paths', () => {
      const result = runCli('echo hi');

      assert.ok(result.success, 'Command should succeed');

      // Get the log path line
      const logMatch = result.output.match(/Log: (.+)/);
      assert.ok(logMatch, 'Should have Log line');

      const logLine = logMatch[0];
      // Log line should contain full path ending in .log
      assert.ok(
        logLine.includes('.log'),
        'Log path should be complete and not truncated'
      );

      console.log('  ✓ Log paths are not truncated');
    });

    it('should show full session ID', () => {
      const result = runCli('echo hi');

      assert.ok(result.success, 'Command should succeed');

      // Get session IDs from output (should appear twice: start and finish block)
      const sessionMatches = result.output.match(/Session ID: ([a-f0-9-]+)/g);
      assert.ok(
        sessionMatches && sessionMatches.length >= 2,
        'Should have Session ID in both blocks'
      );

      // Extract UUID from first match
      const uuidMatch = sessionMatches[0].match(
        /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/
      );
      assert.ok(uuidMatch, 'Session ID should be a valid UUID format');

      console.log('  ✓ Session IDs are complete UUIDs');
    });

    it('should have consistent empty line formatting', () => {
      const result = runCli('echo hi');

      assert.ok(result.success, 'Command should succeed');

      // The pattern should be:
      // [start block]
      // [empty line]
      // hi
      // [empty line]
      // [finish block]

      const lines = result.output.split('\n');
      let foundHi = false;
      let hiIndex = -1;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === 'hi') {
          foundHi = true;
          hiIndex = i;
          break;
        }
      }

      assert.ok(foundHi, 'Should find "hi" output on its own line');

      // Check line before hi
      if (hiIndex > 0) {
        const prevLine = lines[hiIndex - 1].trim();
        assert.ok(
          prevLine === '' || prevLine.startsWith('╰'),
          `Line before "hi" should be empty or end of start block`
        );
      }

      // Check line after hi
      if (hiIndex < lines.length - 1) {
        const nextLine = lines[hiIndex + 1].trim();
        assert.ok(
          nextLine === '' || nextLine.startsWith('╭'),
          `Line after "hi" should be empty or start of finish block`
        );
      }

      console.log('  ✓ Empty line formatting is consistent');
    });
  });
});

console.log('=== Echo Integration Tests - Issue #55 ===');
console.log(
  'Testing that "echo hi" works correctly across all isolation modes'
);
console.log('');
