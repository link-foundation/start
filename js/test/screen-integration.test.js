#!/usr/bin/env bun
/**
 * Integration tests for screen isolation
 * Tests actual screen session behavior including output capture, exit codes, and edge cases.
 * Extracted from isolation.test.js to keep file sizes under the 1000-line limit.
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { execSync } = require('child_process');
const {
  isCommandAvailable,
  runInScreen,
} = require('../src/lib/isolation');

describe('Screen Integration Tests', () => {
  describe('runInScreen (if available)', () => {
    it('should run command in detached screen session', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      const result = await runInScreen('echo "test from screen"', {
        session: `test-session-${Date.now()}`,
        detached: true,
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.sessionName);
      assert.ok(result.message.includes('screen'));
      assert.ok(result.message.includes('Reattach with'));

      // Clean up the session
      try {
        execSync(`screen -S ${result.sessionName} -X quit`, {
          stdio: 'ignore',
        });
      } catch {
        // Session may have already exited
      }
    });

    it('should run command in attached mode and capture output (issue #15)', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      // Test attached mode - this should work without TTY using log capture fallback
      const result = await runInScreen('echo hello', {
        session: `test-attached-${Date.now()}`,
        detached: false,
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.sessionName);
      assert.ok(result.message.includes('exited with code 0'));
      // The output property should exist when using log capture
      if (result.output !== undefined) {
        console.log(`  Captured output: "${result.output.trim()}"`);
        assert.ok(
          result.output.includes('hello'),
          'Output should contain the expected message'
        );
      }
    });

    it('should handle multi-line output in attached mode', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      const result = await runInScreen(
        "echo 'line1'; echo 'line2'; echo 'line3'",
        {
          session: `test-multiline-${Date.now()}`,
          detached: false,
        }
      );

      assert.strictEqual(result.success, true);
      if (result.output !== undefined) {
        console.log(
          `  Captured multi-line output: "${result.output.trim().replace(/\n/g, '\\n')}"`
        );
        assert.ok(result.output.includes('line1'));
        assert.ok(result.output.includes('line2'));
        assert.ok(result.output.includes('line3'));
      }
    });

    it('should capture output from commands with quoted strings (issue #25)', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      const result = await runInScreen('echo "hello"', {
        session: `test-quoted-${Date.now()}`,
        detached: false,
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.sessionName);
      assert.ok(result.message.includes('exited with code 0'));
      if (result.output !== undefined) {
        console.log(`  Captured quoted output: "${result.output.trim()}"`);
        assert.ok(
          result.output.includes('hello'),
          'Output should contain "hello" (issue #25 regression test)'
        );
      }
    });

    it('should capture output from commands with complex quoted strings', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      const result = await runInScreen('echo "hello from attached mode"', {
        session: `test-complex-quote-${Date.now()}`,
        detached: false,
      });

      assert.strictEqual(result.success, true);
      if (result.output !== undefined) {
        console.log(
          `  Captured complex quote output: "${result.output.trim()}"`
        );
        assert.ok(
          result.output.includes('hello from attached mode'),
          'Output should contain the full message with spaces'
        );
      }
    });

    it('should always return output property in attached mode (issue #25 fix verification)', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      const result = await runInScreen('echo "quick command output"', {
        session: `test-output-guaranteed-${Date.now()}`,
        detached: false,
      });

      assert.strictEqual(result.success, true);
      assert.ok(
        result.output !== undefined,
        'Attached mode should always return output property'
      );
      assert.ok(
        result.output.includes('quick command output'),
        'Output should be captured (issue #25 fix verification)'
      );
      console.log(`  Verified output capture: "${result.output.trim()}"`);
    });

    it('should capture output from version-flag commands (issue #96)', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      const result = await runInScreen('node --version', {
        session: `test-version-flag-${Date.now()}`,
        detached: false,
      });

      assert.strictEqual(result.success, true, 'Command should succeed');
      assert.ok(
        result.output !== undefined,
        'Attached mode should always return output property'
      );
      assert.ok(
        result.output.trim().length > 0,
        'Output should not be empty (issue #96: version output was silently lost)'
      );
      assert.ok(
        result.output.includes('v') || /\d+\.\d+/.test(result.output),
        'Output should contain version string'
      );
      console.log(`  Captured version output: "${result.output.trim()}"`);
    });

    it('should capture exit code from failed commands (issue #96)', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      const result = await runInScreen('nonexistent_command_12345', {
        session: `test-exit-code-${Date.now()}`,
        detached: false,
      });

      assert.strictEqual(
        result.success,
        false,
        'Command should fail (command not found)'
      );
      assert.ok(
        result.exitCode !== undefined,
        'Exit code should be captured'
      );
      assert.ok(
        result.exitCode !== 0,
        `Exit code should be non-zero for failed command, got: ${result.exitCode}`
      );
      console.log(`  Captured exit code: ${result.exitCode}`);
    });

    it('should capture stderr output in screen isolation (issue #96)', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      const result = await runInScreen('echo "stderr-test" >&2', {
        session: `test-stderr-${Date.now()}`,
        detached: false,
      });

      assert.strictEqual(result.success, true, 'Command should succeed');
      assert.ok(
        result.output !== undefined,
        'Output should be captured'
      );
      assert.ok(
        result.output.includes('stderr-test'),
        'stderr output should be captured via screen logging'
      );
      console.log(`  Captured stderr output: "${result.output.trim()}"`);
    });

    it('should capture multi-line output with correct exit code (issue #96)', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      const result = await runInScreen(
        'echo "line1" && echo "line2" && echo "line3"',
        {
          session: `test-multiline-exit-${Date.now()}`,
          detached: false,
        }
      );

      assert.strictEqual(result.success, true, 'Command should succeed');
      assert.strictEqual(
        result.exitCode,
        0,
        'Exit code should be 0 for successful command'
      );
      assert.ok(result.output.includes('line1'), 'Should contain line1');
      assert.ok(result.output.includes('line2'), 'Should contain line2');
      assert.ok(result.output.includes('line3'), 'Should contain line3');
      console.log(`  Multi-line output with exit code 0: verified`);
    });
  });
});
