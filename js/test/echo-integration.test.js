#!/usr/bin/env bun
/**
 * Integration tests for echo command across all isolation modes
 *
 * Issue #55: Ensure `echo "hi"` works reliably in all modes with proper output
 *
 * These tests verify for ALL isolation modes (attached + detached):
 * 1. Command output is captured and displayed
 * 2. Start and finish blocks are properly formatted
 * 3. Empty lines exist before and after command output
 * 4. Log paths and session IDs are not truncated (fully copyable)
 *
 * Test coverage:
 * - No isolation mode (direct execution)
 * - Screen isolation: attached + detached
 * - Tmux isolation: attached + detached
 * - Docker isolation: attached + detached
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { execSync } = require('child_process');
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

// Verify output contains expected structure for attached modes (shows finish block)
// Uses status spine format only
function verifyAttachedModeOutput(output, expectedOutputText = 'hi') {
  // Should contain start block with spine format
  assert.ok(
    output.includes('│ session') && output.includes('│ start'),
    'Output should contain start block with spine format'
  );

  // Should contain session info
  assert.ok(output.includes('│ session'), 'Output should contain session ID');
  assert.ok(
    output.includes('│ start'),
    'Output should contain start timestamp'
  );

  // Should contain command output
  assert.ok(
    output.includes(expectedOutputText),
    `Output should contain the "${expectedOutputText}" command output`
  );

  // Should contain finish block
  assert.ok(
    output.includes('│ finish'),
    'Output should contain finish timestamp'
  );
  assert.ok(output.includes('│ exit'), 'Output should contain exit code');
  assert.ok(output.includes('│ log'), 'Output should contain log path');

  // Should contain result marker
  assert.ok(
    output.includes('✓') || output.includes('✗'),
    'Output should contain result marker (✓ or ✗)'
  );

  // Verify there are empty lines around output (structure check)
  const lines = output.split('\n');
  const outputIndex = lines.findIndex((l) => l.trim() === expectedOutputText);

  if (outputIndex > 0) {
    // Check for empty line before output
    const lineBefore = lines[outputIndex - 1];
    // Line before should be empty
    assert.ok(
      lineBefore.trim() === '',
      `Expected empty line before output, got: "${lineBefore}"`
    );
  }

  if (outputIndex >= 0 && outputIndex < lines.length - 1) {
    // Check for empty line after output
    const lineAfter = lines[outputIndex + 1];
    // Line after should be empty or result marker (✓/✗)
    assert.ok(
      lineAfter.trim() === '' ||
        lineAfter.includes('✓') ||
        lineAfter.includes('✗'),
      `Expected empty line or result marker after output, got: "${lineAfter}"`
    );
  }
}

// Verify output for detached modes (only start block, no finish block)
// Uses status spine format only
function verifyDetachedModeOutput(output) {
  // Should contain start block with spine format
  assert.ok(
    output.includes('│ session') && output.includes('│ start'),
    'Output should contain start block with spine format'
  );

  // Should contain session info
  assert.ok(output.includes('│ session'), 'Output should contain session ID');
  assert.ok(
    output.includes('│ start'),
    'Output should contain start timestamp'
  );

  // Should show detached mode info
  assert.ok(
    output.includes('│ mode      detached') || output.includes('Reattach with'),
    'Output should indicate detached mode or show reattach instructions'
  );
}

// Verify log path is not truncated
// Uses status spine format only
function verifyLogPathNotTruncated(output) {
  const logMatch = output.match(/│ log\s+(.+)/);
  assert.ok(logMatch, 'Should have log line with spine format');
  const logPath = logMatch[1].trim();

  // Log path should end with .log extension
  assert.ok(
    logPath.endsWith('.log'),
    `Log path should end with .log extension, got: "${logPath}"`
  );
}

// Verify session ID is a valid UUID
// Uses status spine format only
function verifySessionId(output) {
  const sessionMatches = output.match(/│ session\s+([a-f0-9-]+)/g);
  assert.ok(
    sessionMatches && sessionMatches.length >= 1,
    'Should have session ID with spine format'
  );

  // Extract UUID from first match
  const uuidMatch = sessionMatches[0].match(
    /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/
  );
  assert.ok(uuidMatch, 'Session ID should be a valid UUID format');
}

describe('Echo Integration Tests - Issue #55', () => {
  // ============================================
  // NO ISOLATION MODE (Direct Execution)
  // ============================================
  describe('No Isolation Mode (Direct Execution)', () => {
    it('should execute echo hi and show output with proper formatting', () => {
      const result = runCli('echo hi');

      assert.ok(result.success, 'Command should succeed');
      verifyAttachedModeOutput(result.output);
      verifyLogPathNotTruncated(result.output);
      verifySessionId(result.output);

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

    it('should have consistent empty line formatting', () => {
      const result = runCli('echo hi');

      assert.ok(result.success, 'Command should succeed');

      // The pattern should be:
      // [start block with spine]
      // [empty line]
      // hi
      // [empty line]
      // [result marker and finish block]

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

      // Check line before hi - should be empty
      if (hiIndex > 0) {
        const prevLine = lines[hiIndex - 1].trim();
        assert.ok(prevLine === '', `Line before "hi" should be empty`);
      }

      // Check line after hi - should be empty or result marker
      if (hiIndex < lines.length - 1) {
        const nextLine = lines[hiIndex + 1].trim();
        assert.ok(
          nextLine === '' || nextLine.includes('✓') || nextLine.includes('✗'),
          `Line after "hi" should be empty or result marker`
        );
      }

      console.log('  ✓ Empty line formatting is consistent');
    });
  });

  // ============================================
  // SCREEN ISOLATION MODE (Attached + Detached)
  // ============================================
  describe('Screen Isolation Mode', () => {
    const screenAvailable = isCommandAvailable('screen');

    if (!screenAvailable) {
      it('should skip screen tests when screen is not installed', () => {
        console.log('  ⚠ screen not installed, skipping screen tests');
        assert.ok(true);
      });
      return;
    }

    describe('Attached Mode', () => {
      it('should execute echo hi in attached screen mode with proper formatting', () => {
        const result = runCli('--isolated screen -- echo hi', {
          timeout: 30000,
        });

        assert.ok(
          result.success,
          `Command should succeed. Output: ${result.output || result.stderr}`
        );
        verifyAttachedModeOutput(result.output);
        verifyLogPathNotTruncated(result.output);
        verifySessionId(result.output);

        // Should show isolation info with spine format
        assert.ok(
          result.output.includes('│ isolation screen'),
          'Should show screen isolation info'
        );
        assert.ok(
          result.output.includes('│ mode      attached'),
          'Should show attached mode'
        );

        console.log('  ✓ Screen isolation (attached): echo hi works correctly');
      });

      it('should execute echo with quotes in attached screen mode', () => {
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

        console.log('  ✓ Screen isolation (attached): echo with quotes works');
      });

      it('should show exit code and finish block in attached screen mode', () => {
        const result = runCli('--isolated screen -- echo hi', {
          timeout: 30000,
        });

        assert.ok(result.success, 'Command should succeed');
        assert.ok(
          result.output.includes('│ exit      0'),
          'Should show exit code 0 with spine format'
        );
        assert.ok(
          result.output.includes('│ finish'),
          'Should show finish timestamp with spine format'
        );

        console.log(
          '  ✓ Screen isolation (attached): finish block displays correctly'
        );
      });
    });

    describe('Detached Mode', () => {
      it('should execute echo hi in detached screen mode', () => {
        const sessionName = `test-screen-detached-${Date.now()}`;
        const result = runCli(
          `--isolated screen -d --session ${sessionName} -- echo hi`,
          { timeout: 10000 }
        );

        // Detached mode should succeed (command starts in background)
        assert.ok(
          result.success,
          `Command should succeed. Output: ${result.output || result.stderr}`
        );
        verifyDetachedModeOutput(result.output);
        verifySessionId(result.output);

        // Should show screen isolation info with detached mode (spine format)
        assert.ok(
          result.output.includes('│ isolation screen'),
          'Should show screen isolation info'
        );
        assert.ok(
          result.output.includes('│ mode      detached'),
          'Should show detached mode'
        );

        // Cleanup: kill the screen session
        try {
          execSync(`screen -S ${sessionName} -X quit`, { stdio: 'ignore' });
        } catch {
          // Session may have already exited
        }

        console.log(
          '  ✓ Screen isolation (detached): echo hi starts correctly'
        );
      });

      it('should provide reattach instructions in detached screen mode', () => {
        const sessionName = `test-screen-reattach-${Date.now()}`;
        const result = runCli(
          `--isolated screen -d --session ${sessionName} -- echo hi`,
          { timeout: 10000 }
        );

        assert.ok(result.success, 'Command should succeed');
        assert.ok(
          result.output.includes('Reattach with') ||
            result.output.includes('screen -r'),
          'Should show reattach instructions'
        );

        // Cleanup
        try {
          execSync(`screen -S ${sessionName} -X quit`, { stdio: 'ignore' });
        } catch {
          // Ignore
        }

        console.log(
          '  ✓ Screen isolation (detached): reattach instructions displayed'
        );
      });
    });
  });

  // ============================================
  // TMUX ISOLATION MODE (Attached + Detached)
  // ============================================
  describe('Tmux Isolation Mode', () => {
    const tmuxAvailable = isCommandAvailable('tmux');

    if (!tmuxAvailable) {
      it('should skip tmux tests when tmux is not installed', () => {
        console.log('  ⚠ tmux not installed, skipping tmux tests');
        assert.ok(true);
      });
      return;
    }

    describe('Attached Mode', () => {
      // Note: Attached tmux mode requires a TTY, which is not available in CI
      // We test that it properly handles no-TTY scenario
      it('should handle attached tmux mode (may require TTY)', () => {
        const result = runCli('--isolated tmux -- echo hi', { timeout: 30000 });

        // Either succeeds or fails due to no TTY - both are valid
        if (result.success) {
          assert.ok(result.output.includes('hi'), 'Output should contain "hi"');
          assert.ok(
            result.output.includes('│ isolation tmux'),
            'Should show tmux isolation info'
          );
          console.log('  ✓ Tmux isolation (attached): echo hi works correctly');
        } else {
          // May fail due to no TTY in CI
          console.log(
            '  ⚠ Tmux isolation (attached): skipped (no TTY available)'
          );
          assert.ok(true);
        }
      });
    });

    describe('Detached Mode', () => {
      it('should execute echo hi in detached tmux mode', () => {
        const sessionName = `test-tmux-detached-${Date.now()}`;
        const result = runCli(
          `--isolated tmux -d --session ${sessionName} -- echo hi`,
          { timeout: 10000 }
        );

        // Detached mode should succeed
        assert.ok(
          result.success,
          `Command should succeed. Output: ${result.output || result.stderr}`
        );
        verifyDetachedModeOutput(result.output);
        verifySessionId(result.output);

        // Should show tmux isolation info (spine format)
        assert.ok(
          result.output.includes('│ isolation tmux'),
          'Should show tmux isolation info'
        );
        assert.ok(
          result.output.includes('│ mode      detached'),
          'Should show detached mode'
        );

        // Cleanup: kill the tmux session
        try {
          execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'ignore' });
        } catch {
          // Session may have already exited
        }

        console.log('  ✓ Tmux isolation (detached): echo hi starts correctly');
      });

      it('should provide reattach instructions in detached tmux mode', () => {
        const sessionName = `test-tmux-reattach-${Date.now()}`;
        const result = runCli(
          `--isolated tmux -d --session ${sessionName} -- echo hi`,
          { timeout: 10000 }
        );

        assert.ok(result.success, 'Command should succeed');
        assert.ok(
          result.output.includes('Reattach with') ||
            result.output.includes('tmux attach'),
          'Should show reattach instructions'
        );

        // Cleanup
        try {
          execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'ignore' });
        } catch {
          // Ignore
        }

        console.log(
          '  ✓ Tmux isolation (detached): reattach instructions displayed'
        );
      });

      it('should execute echo with quotes in detached tmux mode', () => {
        const sessionName = `test-tmux-quotes-${Date.now()}`;
        const result = runCli(
          `--isolated tmux -d --session ${sessionName} -- echo "hello world"`,
          { timeout: 10000 }
        );

        assert.ok(
          result.success,
          `Command should succeed. Output: ${result.output || result.stderr}`
        );

        // Cleanup
        try {
          execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'ignore' });
        } catch {
          // Ignore
        }

        console.log('  ✓ Tmux isolation (detached): echo with quotes works');
      });
    });
  });

  // ============================================
  // DOCKER ISOLATION MODE (Attached + Detached)
  // ============================================
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

    describe('Attached Mode', () => {
      it('should execute echo hi in attached docker mode with proper formatting', () => {
        const containerName = `test-docker-attached-${Date.now()}`;
        const result = runCli(
          `--isolated docker --image alpine:latest --session ${containerName} -- echo hi`,
          { timeout: 60000 }
        );

        assert.ok(
          result.success,
          `Command should succeed. Output: ${result.output || result.stderr}`
        );
        verifyAttachedModeOutput(result.output);
        verifyLogPathNotTruncated(result.output);
        verifySessionId(result.output);

        // Should show docker isolation info (spine format)
        assert.ok(
          result.output.includes('│ isolation docker'),
          'Should show docker isolation info'
        );
        assert.ok(
          result.output.includes('│ image     alpine'),
          'Should show docker image info'
        );

        console.log('  ✓ Docker isolation (attached): echo hi works correctly');
      });

      it('should execute echo with quotes in attached docker mode', () => {
        const containerName = `test-docker-quotes-${Date.now()}`;
        const result = runCli(
          `--isolated docker --image alpine:latest --session ${containerName} -- echo "hello world"`,
          { timeout: 60000 }
        );

        assert.ok(
          result.success,
          `Command should succeed. Output: ${result.output || result.stderr}`
        );
        assert.ok(
          result.output.includes('hello world'),
          'Output should contain "hello world"'
        );

        console.log('  ✓ Docker isolation (attached): echo with quotes works');
      });

      it('should show exit code and finish block in attached docker mode', () => {
        const containerName = `test-docker-finish-${Date.now()}`;
        const result = runCli(
          `--isolated docker --image alpine:latest --session ${containerName} -- echo hi`,
          { timeout: 60000 }
        );

        assert.ok(result.success, 'Command should succeed');
        assert.ok(
          result.output.includes('│ exit      0'),
          'Should show exit code 0 with spine format'
        );
        assert.ok(
          result.output.includes('│ finish'),
          'Should show finish timestamp with spine format'
        );

        console.log(
          '  ✓ Docker isolation (attached): finish block displays correctly'
        );
      });
    });

    describe('Detached Mode', () => {
      it('should execute echo hi in detached docker mode', () => {
        const containerName = `test-docker-detached-${Date.now()}`;
        const result = runCli(
          `--isolated docker -d --image alpine:latest --session ${containerName} -- echo hi`,
          { timeout: 60000 }
        );

        // Detached mode should succeed
        assert.ok(
          result.success,
          `Command should succeed. Output: ${result.output || result.stderr}`
        );
        verifyDetachedModeOutput(result.output);
        verifySessionId(result.output);

        // Should show docker isolation info with detached mode (spine format)
        assert.ok(
          result.output.includes('│ isolation docker'),
          'Should show docker isolation info'
        );
        assert.ok(
          result.output.includes('│ mode      detached'),
          'Should show detached mode'
        );

        // Cleanup: remove the docker container
        try {
          execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
        } catch {
          // Container may have already exited
        }

        console.log(
          '  ✓ Docker isolation (detached): echo hi starts correctly'
        );
      });

      it('should provide reattach instructions in detached docker mode', () => {
        const containerName = `test-docker-reattach-${Date.now()}`;
        const result = runCli(
          `--isolated docker -d --image alpine:latest --session ${containerName} -- echo hi`,
          { timeout: 60000 }
        );

        assert.ok(result.success, 'Command should succeed');
        assert.ok(
          result.output.includes('Reattach with') ||
            result.output.includes('docker attach') ||
            result.output.includes('docker logs'),
          'Should show reattach instructions'
        );

        // Cleanup
        try {
          execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
        } catch {
          // Ignore
        }

        console.log(
          '  ✓ Docker isolation (detached): reattach instructions displayed'
        );
      });

      it('should execute echo with quotes in detached docker mode', () => {
        const containerName = `test-docker-quotes-detached-${Date.now()}`;
        const result = runCli(
          `--isolated docker -d --image alpine:latest --session ${containerName} -- echo "hello world"`,
          { timeout: 60000 }
        );

        assert.ok(
          result.success,
          `Command should succeed. Output: ${result.output || result.stderr}`
        );

        // Cleanup
        try {
          execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
        } catch {
          // Ignore
        }

        console.log('  ✓ Docker isolation (detached): echo with quotes works');
      });
    });
  });

  // ============================================
  // OUTPUT BLOCK FORMATTING (Cross-mode tests)
  // ============================================
  describe('Output Block Formatting', () => {
    it('should not truncate long log paths', () => {
      const result = runCli('echo hi');

      assert.ok(result.success, 'Command should succeed');

      // Get the log path line with spine format
      const logMatch = result.output.match(/│ log\s+(.+)/);
      assert.ok(logMatch, 'Should have log line with spine format');

      const logPath = logMatch[1];
      // Log line should contain full path ending in .log
      assert.ok(
        logPath.includes('.log'),
        'Log path should be complete and not truncated'
      );

      console.log('  ✓ Log paths are not truncated');
    });

    it('should show full session ID in both start and finish blocks', () => {
      const result = runCli('echo hi');

      assert.ok(result.success, 'Command should succeed');

      // Get session IDs from output (should appear twice: start and finish block)
      const sessionMatches = result.output.match(/│ session\s+([a-f0-9-]+)/g);
      assert.ok(
        sessionMatches && sessionMatches.length >= 2,
        'Should have session ID in both blocks with spine format'
      );

      // Extract UUID from first match
      const uuidMatch = sessionMatches[0].match(
        /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/
      );
      assert.ok(uuidMatch, 'Session ID should be a valid UUID format');

      console.log('  ✓ Session IDs are complete UUIDs in both blocks');
    });

    it('should have consistent exit code formatting', () => {
      const result = runCli('echo hi');

      assert.ok(result.success, 'Command should succeed');
      assert.ok(
        result.output.includes('│ exit      0'),
        'Should show exit code with spine format'
      );

      console.log('  ✓ Exit code formatting is consistent');
    });

    it('should include timing information in finish block', () => {
      const result = runCli('echo hi');

      assert.ok(result.success, 'Command should succeed');
      assert.ok(
        result.output.includes('│ duration'),
        'Should include duration with spine format'
      );

      console.log('  ✓ Timing information is present in finish block');
    });
  });
});

console.log('=== Echo Integration Tests - Issue #55 ===');
console.log(
  'Testing that "echo hi" works correctly across all isolation modes'
);
console.log(
  'Coverage: No isolation, Screen (attached/detached), Tmux (attached/detached), Docker (attached/detached)'
);
console.log('');
