#!/usr/bin/env bun
/**
 * Resource cleanup tests for isolation module
 * Tests that verify isolation environments release resources after command execution
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { isCommandAvailable } = require('../src/lib/isolation');

describe('Isolation Resource Cleanup Verification', () => {
  // These tests verify that isolation environments release resources after command execution
  // This ensures uniform behavior across all backends where resources are freed by default

  const {
    runInScreen,
    runInTmux,
    runInDocker,
  } = require('../src/lib/isolation');
  const { execSync } = require('child_process');

  // Helper to wait for a condition with timeout
  async function waitFor(conditionFn, timeout = 5000, interval = 100) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (conditionFn()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return false;
  }

  describe('screen resource cleanup', () => {
    it('should not list screen session after command completes (auto-exit by default)', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      const sessionName = `test-cleanup-screen-${Date.now()}`;

      // Run a quick command in detached mode
      const result = await runInScreen('echo "test" && sleep 0.1', {
        session: sessionName,
        detached: true,
        keepAlive: false,
      });

      assert.strictEqual(result.success, true);

      // Wait for the session to exit naturally (should happen quickly)
      const sessionGone = await waitFor(() => {
        try {
          const sessions = execSync('screen -ls', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          return !sessions.includes(sessionName);
        } catch {
          // screen -ls returns non-zero when no sessions exist
          return true;
        }
      }, 10000);

      assert.ok(
        sessionGone,
        'Screen session should not be in the list after command completes (auto-exit by default)'
      );

      // Double-check with screen -ls to verify no active session
      try {
        const sessions = execSync('screen -ls', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        assert.ok(
          !sessions.includes(sessionName),
          'Session should not appear in screen -ls output'
        );
        console.log('  ✓ Screen session auto-exited and resources released');
      } catch {
        // screen -ls returns non-zero when no sessions - this is expected
        console.log(
          '  ✓ Screen session auto-exited (no sessions found in screen -ls)'
        );
      }
    });

    it('should keep screen session alive when keepAlive is true', async () => {
      if (!isCommandAvailable('screen')) {
        console.log('  Skipping: screen not installed');
        return;
      }

      const sessionName = `test-keepalive-screen-${Date.now()}`;

      // Run command with keepAlive enabled
      const result = await runInScreen('echo "test"', {
        session: sessionName,
        detached: true,
        keepAlive: true,
      });

      assert.strictEqual(result.success, true);

      // Wait a bit for the command to complete
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Session should still exist
      try {
        const sessions = execSync('screen -ls', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        assert.ok(
          sessions.includes(sessionName),
          'Session should still be alive with keepAlive=true'
        );
        console.log(
          '  ✓ Screen session kept alive as expected with --keep-alive'
        );
      } catch {
        assert.fail(
          'screen -ls should show the session when keepAlive is true'
        );
      }

      // Clean up
      try {
        execSync(`screen -S ${sessionName} -X quit`, { stdio: 'ignore' });
      } catch {
        // Ignore cleanup errors
      }
    });
  });

  describe('tmux resource cleanup', () => {
    it('should not list tmux session after command completes (auto-exit by default)', async () => {
      if (!isCommandAvailable('tmux')) {
        console.log('  Skipping: tmux not installed');
        return;
      }

      const sessionName = `test-cleanup-tmux-${Date.now()}`;

      // Run a quick command in detached mode
      const result = await runInTmux('echo "test" && sleep 0.1', {
        session: sessionName,
        detached: true,
        keepAlive: false,
      });

      assert.strictEqual(result.success, true);

      // Wait for the session to exit naturally
      const sessionGone = await waitFor(() => {
        try {
          const sessions = execSync('tmux ls', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          return !sessions.includes(sessionName);
        } catch {
          // tmux ls returns non-zero when no sessions exist
          return true;
        }
      }, 10000);

      assert.ok(
        sessionGone,
        'Tmux session should not be in the list after command completes (auto-exit by default)'
      );

      // Double-check with tmux ls
      try {
        const sessions = execSync('tmux ls', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        assert.ok(
          !sessions.includes(sessionName),
          'Session should not appear in tmux ls output'
        );
        console.log('  ✓ Tmux session auto-exited and resources released');
      } catch {
        // tmux ls returns non-zero when no sessions - this is expected
        console.log(
          '  ✓ Tmux session auto-exited (no sessions found in tmux ls)'
        );
      }
    });

    it('should keep tmux session alive when keepAlive is true', async () => {
      if (!isCommandAvailable('tmux')) {
        console.log('  Skipping: tmux not installed');
        return;
      }

      const sessionName = `test-keepalive-tmux-${Date.now()}`;

      // Run command with keepAlive enabled
      const result = await runInTmux('echo "test"', {
        session: sessionName,
        detached: true,
        keepAlive: true,
      });

      assert.strictEqual(result.success, true);

      // Wait a bit for the command to complete
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Session should still exist
      try {
        const sessions = execSync('tmux ls', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        assert.ok(
          sessions.includes(sessionName),
          'Session should still be alive with keepAlive=true'
        );
        console.log(
          '  ✓ Tmux session kept alive as expected with --keep-alive'
        );
      } catch {
        assert.fail('tmux ls should show the session when keepAlive is true');
      }

      // Clean up
      try {
        execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'ignore' });
      } catch {
        // Ignore cleanup errors
      }
    });
  });

  describe('docker resource cleanup', () => {
    // Helper function to check if docker daemon is running
    function isDockerRunning() {
      if (!isCommandAvailable('docker')) {
        return false;
      }
      try {
        execSync('docker info', { stdio: 'ignore', timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    }

    it('should show docker container as exited after command completes (auto-exit by default)', async () => {
      if (!isDockerRunning()) {
        console.log('  Skipping: docker not available or daemon not running');
        return;
      }

      const containerName = `test-cleanup-docker-${Date.now()}`;

      // Run a quick command in detached mode
      const result = await runInDocker('echo "test" && sleep 0.1', {
        image: 'alpine:latest',
        session: containerName,
        detached: true,
        keepAlive: false,
      });

      assert.strictEqual(result.success, true);

      // Wait for the container to exit
      const containerExited = await waitFor(() => {
        try {
          const status = execSync(
            `docker inspect -f '{{.State.Status}}' ${containerName}`,
            {
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe'],
            }
          ).trim();
          return status === 'exited';
        } catch {
          return false;
        }
      }, 10000);

      assert.ok(
        containerExited,
        'Docker container should be in exited state after command completes (auto-exit by default)'
      );

      // Verify with docker ps -a that container is exited (not running)
      try {
        const allContainers = execSync('docker ps -a', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        assert.ok(
          allContainers.includes(containerName),
          'Container should appear in docker ps -a'
        );

        const runningContainers = execSync('docker ps', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        assert.ok(
          !runningContainers.includes(containerName),
          'Container should NOT appear in docker ps (not running)'
        );
        console.log(
          '  ✓ Docker container auto-exited and stopped (resources released, filesystem preserved)'
        );
      } catch (err) {
        assert.fail(`Failed to verify container status: ${err.message}`);
      }

      // Clean up
      try {
        execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should keep docker container running when keepAlive is true', async () => {
      if (!isDockerRunning()) {
        console.log('  Skipping: docker not available or daemon not running');
        return;
      }

      const containerName = `test-keepalive-docker-${Date.now()}`;

      // Run command with keepAlive enabled
      const result = await runInDocker('echo "test"', {
        image: 'alpine:latest',
        session: containerName,
        detached: true,
        keepAlive: true,
      });

      assert.strictEqual(result.success, true);

      // Wait a bit for the command to complete
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Container should still be running
      try {
        const status = execSync(
          `docker inspect -f '{{.State.Status}}' ${containerName}`,
          {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        ).trim();
        assert.strictEqual(
          status,
          'running',
          'Container should still be running with keepAlive=true'
        );
        console.log(
          '  ✓ Docker container kept running as expected with --keep-alive'
        );
      } catch (err) {
        assert.fail(`Failed to verify container is running: ${err.message}`);
      }

      // Clean up
      try {
        execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
      } catch {
        // Ignore cleanup errors
      }
    });
  });
});
