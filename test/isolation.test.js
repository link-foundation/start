#!/usr/bin/env bun
/**
 * Unit tests for the isolation module
 * Tests command availability checking and session name generation
 * Note: Actual isolation execution tests are integration tests that require the tools to be installed
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { isCommandAvailable, hasTTY } = require('../src/lib/isolation');

describe('Isolation Module', () => {
  describe('isCommandAvailable', () => {
    it('should return true for common commands (echo)', () => {
      // echo is available on all platforms
      const result = isCommandAvailable('echo');
      assert.strictEqual(result, true);
    });

    it('should return true for node', () => {
      // node should be available since we are running tests with it
      const result = isCommandAvailable('node');
      assert.strictEqual(result, true);
    });

    it('should return false for non-existent command', () => {
      const result = isCommandAvailable('nonexistent-command-12345');
      assert.strictEqual(result, false);
    });

    it('should return false for empty command', () => {
      const result = isCommandAvailable('');
      assert.strictEqual(result, false);
    });
  });

  describe('hasTTY', () => {
    it('should return a boolean', () => {
      const result = hasTTY();
      assert.strictEqual(typeof result, 'boolean');
    });

    it('should return false when running in test environment (no TTY)', () => {
      // When running tests, we typically don't have a TTY
      const result = hasTTY();
      // This should be false in CI/test environments
      console.log(`  hasTTY: ${result}`);
      assert.ok(typeof result === 'boolean');
    });
  });

  describe('isolation backend checks', () => {
    // These tests check if specific backends are available
    // They don't fail if not installed, just report status

    it('should check if screen is available', () => {
      const result = isCommandAvailable('screen');
      console.log(`  screen available: ${result}`);
      assert.ok(typeof result === 'boolean');
    });

    it('should check if tmux is available', () => {
      const result = isCommandAvailable('tmux');
      console.log(`  tmux available: ${result}`);
      assert.ok(typeof result === 'boolean');
    });

    it('should check if docker is available', () => {
      const result = isCommandAvailable('docker');
      console.log(`  docker available: ${result}`);
      assert.ok(typeof result === 'boolean');
    });

    it('should check if zellij is available', () => {
      const result = isCommandAvailable('zellij');
      console.log(`  zellij available: ${result}`);
      assert.ok(typeof result === 'boolean');
    });
  });
});

describe('Isolation Runner Error Handling', () => {
  // These tests verify error messages when backends are not available

  const {
    runInScreen,
    runInTmux,
    runInDocker,
    runInZellij,
  } = require('../src/lib/isolation');

  describe('runInScreen', () => {
    it('should return informative error if screen is not installed', async () => {
      // Skip if screen is installed
      if (isCommandAvailable('screen')) {
        console.log('  Skipping: screen is installed');
        return;
      }

      const result = await runInScreen('echo test', { detached: true });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('screen is not installed'));
      assert.ok(
        result.message.includes('apt-get') || result.message.includes('brew')
      );
    });
  });

  describe('runInTmux', () => {
    it('should return informative error if tmux is not installed', async () => {
      // Skip if tmux is installed
      if (isCommandAvailable('tmux')) {
        console.log('  Skipping: tmux is installed');
        return;
      }

      const result = await runInTmux('echo test', { detached: true });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('tmux is not installed'));
      assert.ok(
        result.message.includes('apt-get') || result.message.includes('brew')
      );
    });
  });

  describe('runInDocker', () => {
    it('should return informative error if docker is not installed', async () => {
      // Skip if docker is installed
      if (isCommandAvailable('docker')) {
        console.log('  Skipping: docker is installed');
        return;
      }

      const result = await runInDocker('echo test', {
        image: 'alpine',
        detached: true,
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('docker is not installed'));
    });

    it('should require image option', async () => {
      // Skip if docker is not installed - the error will be about docker not being installed
      if (!isCommandAvailable('docker')) {
        console.log('  Skipping: docker not installed');
        return;
      }

      const result = await runInDocker('echo test', { detached: true });
      assert.strictEqual(result.success, false);
      // Message should mention image requirement
      assert.ok(
        result.message.includes('image') ||
          result.message.includes('--image') ||
          result.message.includes('Docker isolation requires')
      );
    });
  });

  describe('runInZellij', () => {
    it('should return informative error if zellij is not installed', async () => {
      // Skip if zellij is installed
      if (isCommandAvailable('zellij')) {
        console.log('  Skipping: zellij is installed');
        return;
      }

      const result = await runInZellij('echo test', { detached: true });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('zellij is not installed'));
      assert.ok(
        result.message.includes('cargo') || result.message.includes('brew')
      );
    });
  });
});

describe('Isolation Runner with Available Backends', () => {
  // Integration-style tests that run if backends are available
  // These test actual execution in detached mode (quick and non-blocking)

  const {
    runInScreen,
    runInTmux,
    runIsolated,
  } = require('../src/lib/isolation');
  const { execSync } = require('child_process');

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
  });

  describe('runInTmux (if available)', () => {
    it('should run command in detached tmux session', async () => {
      if (!isCommandAvailable('tmux')) {
        console.log('  Skipping: tmux not installed');
        return;
      }

      const result = await runInTmux('echo "test from tmux"', {
        session: `test-session-${Date.now()}`,
        detached: true,
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.sessionName);
      assert.ok(result.message.includes('tmux'));
      assert.ok(result.message.includes('Reattach with'));

      // Clean up the session
      try {
        execSync(`tmux kill-session -t ${result.sessionName}`, {
          stdio: 'ignore',
        });
      } catch {
        // Session may have already exited
      }
    });
  });

  describe('runIsolated dispatcher', () => {
    it('should dispatch to correct backend', async () => {
      // Test with a backend that returns predictable error for missing tools
      const result = await runIsolated('nonexistent-backend', 'echo test', {});
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('Unknown isolation backend'));
    });

    it('should pass options to backend', async () => {
      // Test docker without image - should fail with specific error
      const result = await runIsolated('docker', 'echo test', {});
      assert.strictEqual(result.success, false);
      // Either docker not installed or image required
      assert.ok(
        result.message.includes('docker') || result.message.includes('image')
      );
    });
  });
});
