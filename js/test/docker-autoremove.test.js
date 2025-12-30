#!/usr/bin/env bun
/**
 * Tests for Docker auto-remove container feature
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { isCommandAvailable } = require('../src/lib/isolation');
const { runInDocker } = require('../src/lib/isolation');
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

describe('Docker Auto-Remove Container Feature', () => {
  // These tests verify the --auto-remove-docker-container option
  // which automatically removes the container after exit (disabled by default)

  describe('auto-remove enabled', () => {
    it('should automatically remove container when autoRemoveDockerContainer is true', async () => {
      if (!isDockerRunning()) {
        console.log('  Skipping: docker not available or daemon not running');
        return;
      }

      const containerName = `test-autoremove-${Date.now()}`;

      // Run command with autoRemoveDockerContainer enabled
      const result = await runInDocker('echo "test" && sleep 0.5', {
        image: 'alpine:latest',
        session: containerName,
        detached: true,
        keepAlive: false,
        autoRemoveDockerContainer: true,
      });

      assert.strictEqual(result.success, true);
      assert.ok(
        result.message.includes('automatically removed'),
        'Message should indicate auto-removal'
      );

      // Wait for container to finish and be removed
      const containerRemoved = await waitFor(() => {
        try {
          execSync(`docker inspect -f '{{.State.Status}}' ${containerName}`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          return false; // Container still exists
        } catch {
          return true; // Container does not exist (removed)
        }
      }, 10000);

      assert.ok(
        containerRemoved,
        'Container should be automatically removed after exit with --auto-remove-docker-container'
      );

      // Double-check with docker ps -a that container is completely removed
      try {
        const allContainers = execSync('docker ps -a', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        assert.ok(
          !allContainers.includes(containerName),
          'Container should NOT appear in docker ps -a (completely removed)'
        );
        console.log(
          '  ✓ Docker container auto-removed after exit (filesystem not preserved)'
        );
      } catch (err) {
        assert.fail(`Failed to verify container removal: ${err.message}`);
      }

      // No cleanup needed - container should already be removed
    });
  });

  describe('auto-remove disabled (default)', () => {
    it('should preserve container filesystem by default (without autoRemoveDockerContainer)', async () => {
      if (!isDockerRunning()) {
        console.log('  Skipping: docker not available or daemon not running');
        return;
      }

      const containerName = `test-preserve-${Date.now()}`;

      // Run command without autoRemoveDockerContainer
      const result = await runInDocker('echo "test" && sleep 0.1', {
        image: 'alpine:latest',
        session: containerName,
        detached: true,
        keepAlive: false,
        autoRemoveDockerContainer: false,
      });

      assert.strictEqual(result.success, true);
      assert.ok(
        result.message.includes('filesystem will be preserved'),
        'Message should indicate filesystem preservation'
      );

      // Wait for container to exit
      await waitFor(() => {
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

      // Container should still exist (in exited state)
      try {
        const allContainers = execSync('docker ps -a', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        assert.ok(
          allContainers.includes(containerName),
          'Container should appear in docker ps -a (filesystem preserved)'
        );
        console.log(
          '  ✓ Docker container filesystem preserved by default (can be re-entered)'
        );
      } catch (err) {
        assert.fail(`Failed to verify container preservation: ${err.message}`);
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
