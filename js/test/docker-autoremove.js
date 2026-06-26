#!/usr/bin/env bun
/**
 * Tests for Docker container cleanup behavior
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isCommandAvailable } = require('../src/lib/isolation');
const { runInDocker } = require('../src/lib/isolation');
const { execSync } = require('child_process');
const {
  DOCKER_CONTAINER_CLEANUP_POLICY,
  buildDetachedDockerCompletionScript,
  getDockerContainerCleanupPolicy,
  shouldCleanupDockerContainer,
} = require('../src/lib/docker-cleanup');

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

// Use the canRunLinuxDockerImages function from isolation module
// to properly detect if Linux containers can run (handles Windows containers mode)
const { canRunLinuxDockerImages } = require('../src/lib/isolation');
const DOCKER_TEST_TIMEOUT = 20000;

describe('Docker Container Cleanup Policy', () => {
  // These tests verify that docker isolation removes finished containers by
  // default while still providing explicit flags to keep them for investigation.

  describe('cleanup decisions', () => {
    it('should keep abnormal containers under the default policy', () => {
      const policy = getDockerContainerCleanupPolicy({});
      assert.strictEqual(policy, DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT);
      assert.strictEqual(shouldCleanupDockerContainer(policy, 0, false), true);
      assert.strictEqual(shouldCleanupDockerContainer(policy, 7, false), false);
      assert.strictEqual(shouldCleanupDockerContainer(policy, 0, true), false);
    });

    it('should keep OOM-killed containers with keepContainerOnFail', () => {
      const policy = getDockerContainerCleanupPolicy({
        keepContainerOnFail: true,
      });
      assert.strictEqual(policy, DOCKER_CONTAINER_CLEANUP_POLICY.KEEP_ON_FAIL);
      assert.strictEqual(shouldCleanupDockerContainer(policy, 0, false), true);
      assert.strictEqual(shouldCleanupDockerContainer(policy, 0, true), false);
    });

    it('should honor explicit always-cleanup policy', () => {
      const policy = getDockerContainerCleanupPolicy({
        alwaysCleanupContainer: true,
      });
      assert.strictEqual(policy, DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS);
      assert.strictEqual(shouldCleanupDockerContainer(policy, 7, false), true);
      assert.strictEqual(shouldCleanupDockerContainer(policy, 0, true), true);
    });

    it('should make the detached watcher inspect OOMKilled before default cleanup', () => {
      const script = buildDetachedDockerCompletionScript(
        'issue144-container',
        DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT,
        '/tmp/issue144.log'
      );
      assert.match(script, /\.State\.ExitCode.*\.State\.OOMKilled/);
      assert.match(script, /__start_command_oom/);
      assert.match(script, /Container kept for investigation/);
      assert.match(script, /docker rm -f/);
      assert.match(script, /issue144-container/);
    });
  });

  describe('auto-remove enabled', () => {
    it(
      'should automatically remove container when autoRemoveDockerContainer is true',
      { timeout: DOCKER_TEST_TIMEOUT },
      async () => {
        if (!canRunLinuxDockerImages()) {
          console.log(
            '  Skipping: docker not available, daemon not running, or Linux containers not supported'
          );
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
          result.message.includes('will be removed'),
          'Message should indicate cleanup'
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
      }
    );
  });

  describe('default cleanup', () => {
    it(
      'should remove container filesystem by default',
      { timeout: DOCKER_TEST_TIMEOUT },
      async () => {
        if (!canRunLinuxDockerImages()) {
          console.log(
            '  Skipping: docker not available, daemon not running, or Linux containers not supported'
          );
          return;
        }

        const containerName = `test-default-cleanup-${Date.now()}`;

        // Run command without any cleanup flag. The default should still remove
        // the container after the command finishes.
        const result = await runInDocker('echo "test" && sleep 0.1', {
          image: 'alpine:latest',
          session: containerName,
          detached: true,
          keepAlive: false,
          autoRemoveDockerContainer: false,
        });

        assert.strictEqual(result.success, true);
        assert.ok(
          result.message.includes('will be removed'),
          'Message should indicate default cleanup'
        );

        const containerRemoved = await waitFor(() => {
          try {
            execSync(`docker inspect -f '{{.State.Status}}' ${containerName}`, {
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            return false;
          } catch {
            return true;
          }
        }, 10000);

        assert.ok(
          containerRemoved,
          'Container should be removed after exit by default'
        );

        try {
          const allContainers = execSync('docker ps -a', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          assert.ok(
            !allContainers.includes(containerName),
            'Container should NOT appear in docker ps -a after default cleanup'
          );
        } catch (err) {
          assert.fail(`Failed to verify container cleanup: ${err.message}`);
        }
      }
    );
  });

  describe('keep-container opt-out', () => {
    it(
      'should preserve container filesystem when keepContainer is true',
      { timeout: DOCKER_TEST_TIMEOUT },
      async () => {
        if (!canRunLinuxDockerImages()) {
          console.log(
            '  Skipping: docker not available, daemon not running, or Linux containers not supported'
          );
          return;
        }

        const containerName = `test-keep-container-${Date.now()}`;

        const result = await runInDocker('echo "test" && sleep 0.1', {
          image: 'alpine:latest',
          session: containerName,
          detached: true,
          keepAlive: false,
          keepContainer: true,
        });

        assert.strictEqual(result.success, true);
        assert.ok(
          result.message.includes('Container kept for investigation'),
          'Message should explain that the container is kept'
        );
        assert.ok(
          result.message.includes(`docker rm -f ${containerName}`),
          'Message should include cleanup command'
        );

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

        assert.ok(containerExited, 'Container should remain in exited state');

        try {
          execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
        } catch {
          // Ignore cleanup errors
        }
      }
    );

    it(
      'should preserve failed containers when keepContainerOnFail is true',
      { timeout: DOCKER_TEST_TIMEOUT },
      async () => {
        if (!canRunLinuxDockerImages()) {
          console.log(
            '  Skipping: docker not available, daemon not running, or Linux containers not supported'
          );
          return;
        }

        const containerName = `test-keep-on-fail-${Date.now()}`;

        const result = await runInDocker('echo "test" && exit 7', {
          image: 'alpine:latest',
          session: containerName,
          detached: true,
          keepAlive: false,
          keepContainerOnFail: true,
        });

        assert.strictEqual(result.success, true);
        assert.ok(
          result.message.includes(
            'Container will be kept if the command fails'
          ),
          'Message should describe failure retention'
        );
        assert.ok(
          result.message.includes(`docker rm -f ${containerName}`),
          'Message should include cleanup command'
        );

        const containerExited = await waitFor(() => {
          try {
            const status = execSync(
              `docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' ${containerName}`,
              {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
              }
            ).trim();
            return status === 'exited 7';
          } catch {
            return false;
          }
        }, 10000);

        assert.ok(containerExited, 'Failed container should be preserved');

        try {
          execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
        } catch {
          // Ignore cleanup errors
        }
      }
    );
  });

  describe('attached mode logging', () => {
    it(
      'should write attached docker output to the provided host log path',
      { timeout: DOCKER_TEST_TIMEOUT },
      async () => {
        if (!canRunLinuxDockerImages()) {
          console.log(
            '  Skipping: docker not available, daemon not running, or Linux containers not supported'
          );
          return;
        }

        const containerName = `test-attached-log-${Date.now()}`;
        const logPath = path.join(
          os.tmpdir(),
          `start-attached-docker-${process.pid}-${Date.now()}.log`
        );
        fs.writeFileSync(logPath, '=== test log header ===\n');

        try {
          const result = await runInDocker("printf 'attached-log-line\\n'", {
            image: 'alpine:latest',
            session: containerName,
            detached: false,
            keepAlive: false,
            logPath,
          });

          assert.strictEqual(result.success, true);
          assert.ok(
            result.message.includes('Container removed after completion'),
            'Attached container should be removed after completion by default'
          );

          const contents = fs.readFileSync(logPath, 'utf8');
          assert.ok(
            contents.includes('attached-log-line'),
            `Attached docker output should be written to host log, got:\n${contents}`
          );

          const containerRemoved = await waitFor(() => {
            try {
              execSync(
                `docker inspect -f '{{.State.Status}}' ${containerName}`,
                {
                  encoding: 'utf8',
                  stdio: ['pipe', 'pipe', 'pipe'],
                }
              );
              return false;
            } catch {
              return true;
            }
          }, 10000);
          assert.ok(containerRemoved, 'Attached container should be removed');
        } finally {
          try {
            execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
          } catch {
            // Ignore cleanup errors
          }
          fs.rmSync(logPath, { force: true });
        }
      }
    );
  });
});
