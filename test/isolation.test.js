#!/usr/bin/env bun
/**
 * Unit tests for the isolation module
 * Tests command availability checking and session name generation
 * Note: Actual isolation execution tests are integration tests that require the tools to be installed
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const {
  isCommandAvailable,
  hasTTY,
  getScreenVersion,
  supportsLogfileOption,
  resetScreenVersionCache,
} = require('../src/lib/isolation');

describe('Isolation Module', () => {
  describe('wrapCommandWithUser', () => {
    const { wrapCommandWithUser } = require('../src/lib/isolation');

    it('should return command unchanged when user is null', () => {
      const command = 'echo hello';
      const result = wrapCommandWithUser(command, null);
      assert.strictEqual(result, command);
    });

    it('should wrap command with sudo when user is specified', () => {
      const command = 'echo hello';
      const result = wrapCommandWithUser(command, 'john');
      assert.ok(result.includes('sudo'));
      assert.ok(result.includes('-u john'));
      assert.ok(result.includes('echo hello'));
    });

    it('should escape single quotes in command', () => {
      const command = "echo 'hello'";
      const result = wrapCommandWithUser(command, 'www-data');
      // Should escape quotes properly for shell
      assert.ok(result.includes('sudo'));
      assert.ok(result.includes('-u www-data'));
    });

    it('should use non-interactive sudo', () => {
      const command = 'npm start';
      const result = wrapCommandWithUser(command, 'john');
      // Should include -n flag for non-interactive
      assert.ok(result.includes('sudo -n'));
    });
  });

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
  });

  describe('getScreenVersion', () => {
    it('should return version object or null', () => {
      // Reset cache before testing
      resetScreenVersionCache();
      const version = getScreenVersion();

      if (isCommandAvailable('screen')) {
        // If screen is installed, we should get a version object
        assert.ok(
          version !== null,
          'Should return version object when screen is installed'
        );
        assert.ok(typeof version.major === 'number', 'major should be number');
        assert.ok(typeof version.minor === 'number', 'minor should be number');
        assert.ok(typeof version.patch === 'number', 'patch should be number');
        console.log(
          `  Detected screen version: ${version.major}.${version.minor}.${version.patch}`
        );
      } else {
        // If screen is not installed, we should get null
        assert.strictEqual(
          version,
          null,
          'Should return null when screen is not installed'
        );
        console.log('  screen not installed, version is null');
      }
    });

    it('should cache the version result', () => {
      // Reset cache first
      resetScreenVersionCache();

      // Call twice
      const version1 = getScreenVersion();
      const version2 = getScreenVersion();

      // Results should be identical (same object reference if cached)
      assert.strictEqual(
        version1,
        version2,
        'Cached version should return same object'
      );
    });
  });

  describe('supportsLogfileOption', () => {
    it('should return boolean', () => {
      // Reset cache before testing
      resetScreenVersionCache();
      const result = supportsLogfileOption();
      assert.ok(typeof result === 'boolean', 'Should return a boolean');
      console.log(`  supportsLogfileOption: ${result}`);
    });

    it('should return true for screen >= 4.5.1', () => {
      // This tests the logic by checking the current system
      resetScreenVersionCache();
      const version = getScreenVersion();

      if (version) {
        const expected =
          version.major > 4 ||
          (version.major === 4 && version.minor > 5) ||
          (version.major === 4 && version.minor === 5 && version.patch >= 1);
        const result = supportsLogfileOption();
        assert.strictEqual(
          result,
          expected,
          `Version ${version.major}.${version.minor}.${version.patch} should ${expected ? 'support' : 'not support'} -Logfile`
        );
        console.log(
          `  Version ${version.major}.${version.minor}.${version.patch}: -Logfile supported = ${result}`
        );
      } else {
        // If no version detected, should return false (fallback to safe method)
        const result = supportsLogfileOption();
        assert.strictEqual(
          result,
          false,
          'Should return false when version cannot be detected'
        );
      }
    });
  });
});

describe('Isolation Runner Error Handling', () => {
  // These tests verify error messages when backends are not available

  const {
    runInScreen,
    runInTmux,
    runInDocker,
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
});

describe('Isolation Keep-Alive Behavior', () => {
  // Tests for the --keep-alive option behavior
  // These test the message output and options handling

  const {
    runInScreen,
    runInTmux,
    runInDocker,
  } = require('../src/lib/isolation');
  const { execSync } = require('child_process');

  describe('runInScreen keep-alive messages', () => {
    it('should include auto-exit message by default in detached mode', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      const result = await runInScreen('echo test', {
        session: `test-autoexit-${Date.now()}`,
        detached: true,
        keepAlive: false,
      });

      assert.strictEqual(result.success, true);
      assert.ok(
        result.message.includes('exit automatically'),
        'Message should indicate auto-exit behavior'
      );

      // Clean up
      try {
        execSync(`screen -S ${result.sessionName} -X quit`, {
          stdio: 'ignore',
        });
      } catch {
        // Session may have already exited
      }
    });

    it('should include keep-alive message when keepAlive is true', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      const result = await runInScreen('echo test', {
        session: `test-keepalive-${Date.now()}`,
        detached: true,
        keepAlive: true,
      });

      assert.strictEqual(result.success, true);
      assert.ok(
        result.message.includes('stay alive'),
        'Message should indicate keep-alive behavior'
      );

      // Clean up
      try {
        execSync(`screen -S ${result.sessionName} -X quit`, {
          stdio: 'ignore',
        });
      } catch {
        // Ignore cleanup errors
      }
    });
  });

  describe('runInTmux keep-alive messages', () => {
    it('should include auto-exit message by default in detached mode', async () => {
      if (!isCommandAvailable('tmux')) {
        console.log('  Skipping: tmux not installed');
        return;
      }

      const result = await runInTmux('echo test', {
        session: `test-autoexit-${Date.now()}`,
        detached: true,
        keepAlive: false,
      });

      assert.strictEqual(result.success, true);
      assert.ok(
        result.message.includes('exit automatically'),
        'Message should indicate auto-exit behavior'
      );

      // Clean up
      try {
        execSync(`tmux kill-session -t ${result.sessionName}`, {
          stdio: 'ignore',
        });
      } catch {
        // Session may have already exited
      }
    });

    it('should include keep-alive message when keepAlive is true', async () => {
      if (!isCommandAvailable('tmux')) {
        console.log('  Skipping: tmux not installed');
        return;
      }

      const result = await runInTmux('echo test', {
        session: `test-keepalive-${Date.now()}`,
        detached: true,
        keepAlive: true,
      });

      assert.strictEqual(result.success, true);
      assert.ok(
        result.message.includes('stay alive'),
        'Message should indicate keep-alive behavior'
      );

      // Clean up
      try {
        execSync(`tmux kill-session -t ${result.sessionName}`, {
          stdio: 'ignore',
        });
      } catch {
        // Ignore cleanup errors
      }
    });
  });

  describe('runInDocker keep-alive messages', () => {
    // Helper function to check if docker daemon is running
    function isDockerRunning() {
      if (!isCommandAvailable('docker')) {
        return false;
      }
      try {
        // Try to ping the docker daemon
        execSync('docker info', { stdio: 'ignore', timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    }

    it('should include auto-exit message by default in detached mode', async () => {
      if (!isDockerRunning()) {
        console.log('  Skipping: docker not available or daemon not running');
        return;
      }

      const containerName = `test-autoexit-${Date.now()}`;
      const result = await runInDocker('echo test', {
        image: 'alpine:latest',
        session: containerName,
        detached: true,
        keepAlive: false,
      });

      assert.strictEqual(result.success, true);
      assert.ok(
        result.message.includes('exit automatically'),
        'Message should indicate auto-exit behavior'
      );

      // Clean up
      try {
        execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
      } catch {
        // Container may have already been removed
      }
    });

    it('should include keep-alive message when keepAlive is true', async () => {
      if (!isDockerRunning()) {
        console.log('  Skipping: docker not available or daemon not running');
        return;
      }

      const containerName = `test-keepalive-${Date.now()}`;
      const result = await runInDocker('echo test', {
        image: 'alpine:latest',
        session: containerName,
        detached: true,
        keepAlive: true,
      });

      assert.strictEqual(result.success, true);
      assert.ok(
        result.message.includes('stay alive'),
        'Message should indicate keep-alive behavior'
      );

      // Clean up
      try {
        execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
      } catch {
        // Ignore cleanup errors
      }
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

    it('should capture output from commands with quoted strings (issue #25)', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      // This is the exact scenario from issue #25:
      // $ --isolated screen --verbose -- echo "hello"
      // Previously failed because of shell quoting issues with execSync
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

      // Test more complex quoting scenarios
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

      // This test verifies that attached mode always uses log capture,
      // ensuring output is never lost even for quick commands.
      // This is the core fix for issue #25 where output was lost on macOS
      // because screen's virtual terminal was destroyed before output could be seen.
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
