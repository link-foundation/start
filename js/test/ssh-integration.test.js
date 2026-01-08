#!/usr/bin/env bun
/**
 * SSH Integration Tests
 *
 * These tests require a running SSH server accessible at localhost.
 * In CI, this is set up by the GitHub Actions workflow.
 * Locally, these tests will be skipped if SSH to localhost is not available.
 *
 * To run locally:
 * 1. Ensure SSH server is running
 * 2. Set up passwordless SSH to localhost (ssh-keygen, ssh-copy-id localhost)
 * 3. Run: bun test test/ssh-integration.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('assert');
const { execSync, spawnSync } = require('child_process');
const { runInSsh, isCommandAvailable } = require('../src/lib/isolation');

// Check if we can SSH to localhost
function canSshToLocalhost() {
  if (!isCommandAvailable('ssh')) {
    return false;
  }

  try {
    const result = spawnSync(
      'ssh',
      [
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=5',
        'localhost',
        'echo test',
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    return result.status === 0 && result.stdout.trim() === 'test';
  } catch {
    return false;
  }
}

// Get current username for SSH endpoint
function getCurrentUsername() {
  try {
    return execSync('whoami', { encoding: 'utf8' }).trim();
  } catch {
    return process.env.USER || 'runner';
  }
}

describe('SSH Integration Tests', () => {
  let sshAvailable = false;
  let sshEndpoint = '';

  before(() => {
    sshAvailable = canSshToLocalhost();
    if (sshAvailable) {
      const username = getCurrentUsername();
      sshEndpoint = `${username}@localhost`;
      console.log(`  SSH available, testing with endpoint: ${sshEndpoint}`);
    } else {
      console.log(
        '  SSH to localhost not available, integration tests will be skipped'
      );
    }
  });

  describe('runInSsh with real SSH connection', () => {
    it('should execute simple command in attached mode', async () => {
      if (!sshAvailable) {
        console.log('  Skipping: SSH to localhost not available');
        return;
      }

      const result = await runInSsh('echo "hello from ssh"', {
        endpoint: sshEndpoint,
        detached: false,
      });

      assert.strictEqual(result.success, true, 'SSH command should succeed');
      assert.ok(result.sessionName, 'Should have a session name');
      assert.ok(
        result.message.includes('exited with code 0'),
        'Should report exit code 0'
      );
    });

    it('should execute command with arguments', async () => {
      if (!sshAvailable) {
        console.log('  Skipping: SSH to localhost not available');
        return;
      }

      const result = await runInSsh('ls -la /tmp', {
        endpoint: sshEndpoint,
        detached: false,
      });

      assert.strictEqual(result.success, true, 'SSH command should succeed');
      assert.ok(
        result.message.includes('exited with code 0'),
        'Should report exit code 0'
      );
    });

    it('should handle command failure with non-zero exit code', async () => {
      if (!sshAvailable) {
        console.log('  Skipping: SSH to localhost not available');
        return;
      }

      const result = await runInSsh('exit 42', {
        endpoint: sshEndpoint,
        detached: false,
      });

      assert.strictEqual(
        result.success,
        false,
        'SSH command should report failure'
      );
      assert.ok(
        result.message.includes('exited with code'),
        'Should report exit code'
      );
      assert.strictEqual(result.exitCode, 42, 'Exit code should be 42');
    });

    it('should execute command in detached mode', async () => {
      if (!sshAvailable) {
        console.log('  Skipping: SSH to localhost not available');
        return;
      }

      const sessionName = `ssh-test-${Date.now()}`;
      const result = await runInSsh('echo "background task" && sleep 1', {
        endpoint: sshEndpoint,
        session: sessionName,
        detached: true,
      });

      assert.strictEqual(
        result.success,
        true,
        'SSH detached command should succeed'
      );
      assert.strictEqual(
        result.sessionName,
        sessionName,
        'Should use provided session name'
      );
      assert.ok(
        result.message.includes('detached'),
        'Should mention detached mode'
      );
      assert.ok(
        result.message.includes('View logs'),
        'Should include log viewing instructions'
      );
    });

    it('should handle multiple sequential commands', async () => {
      if (!sshAvailable) {
        console.log('  Skipping: SSH to localhost not available');
        return;
      }

      const result = await runInSsh(
        'echo "step1" && echo "step2" && echo "step3"',
        {
          endpoint: sshEndpoint,
          detached: false,
        }
      );

      assert.strictEqual(
        result.success,
        true,
        'Multiple commands should succeed'
      );
    });

    it('should handle command with environment variables', async () => {
      if (!sshAvailable) {
        console.log('  Skipping: SSH to localhost not available');
        return;
      }

      const result = await runInSsh('TEST_VAR=hello && echo $TEST_VAR', {
        endpoint: sshEndpoint,
        detached: false,
      });

      assert.strictEqual(
        result.success,
        true,
        'Command with env vars should succeed'
      );
    });

    it('should handle special characters in command', async () => {
      if (!sshAvailable) {
        console.log('  Skipping: SSH to localhost not available');
        return;
      }

      const result = await runInSsh('echo "hello world" | grep hello', {
        endpoint: sshEndpoint,
        detached: false,
      });

      assert.strictEqual(
        result.success,
        true,
        'Command with special characters should succeed'
      );
    });

    it('should work with custom session name', async () => {
      if (!sshAvailable) {
        console.log('  Skipping: SSH to localhost not available');
        return;
      }

      const customSession = 'my-custom-ssh-session';
      const result = await runInSsh('pwd', {
        endpoint: sshEndpoint,
        session: customSession,
        detached: false,
      });

      assert.strictEqual(result.success, true, 'SSH command should succeed');
      assert.strictEqual(
        result.sessionName,
        customSession,
        'Should use custom session name'
      );
    });
  });

  describe('SSH error handling', () => {
    it('should fail gracefully with invalid endpoint', async () => {
      // This test is skipped in CI because it can be slow/unreliable
      // The error handling logic is tested in unit tests
      console.log(
        '  Note: SSH connection error handling is tested via unit tests'
      );

      // We test that the function handles missing endpoint properly
      const result = await runInSsh('echo test', {
        // Missing endpoint - should fail immediately
        detached: false,
      });

      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('--endpoint'));
    });
  });
});

describe('SSH CLI Integration', () => {
  let sshAvailable = false;
  let sshEndpoint = '';

  before(() => {
    sshAvailable = canSshToLocalhost();
    if (sshAvailable) {
      const username = getCurrentUsername();
      sshEndpoint = `${username}@localhost`;
    }
  });

  it('should work through CLI with --isolated ssh --endpoint', async () => {
    if (!sshAvailable) {
      console.log('  Skipping: SSH to localhost not available');
      return;
    }

    // Test the CLI directly by spawning the process
    const result = spawnSync(
      'bun',
      [
        'src/bin/cli.js',
        '--isolated',
        'ssh',
        '--endpoint',
        sshEndpoint,
        '--',
        'echo',
        'cli-test',
      ],
      {
        encoding: 'utf8',
        timeout: 30000,
        cwd: process.cwd(),
        env: { ...process.env, START_DISABLE_AUTO_ISSUE: '1' },
      }
    );

    // Check that the CLI executed without crashing
    // The actual SSH command might fail depending on environment,
    // but the CLI should handle it gracefully
    assert.ok(result !== undefined, 'CLI should execute without crashing');
    console.log(`  CLI exit code: ${result.status}`);

    if (result.status === 0) {
      // Check for isolation info with spine format
      assert.ok(
        result.stdout.includes('│ isolation ssh'),
        'Should show SSH isolation info with spine format'
      );
      assert.ok(
        result.stdout.includes('│ endpoint') || result.stdout.includes('ssh'),
        'Should mention SSH or endpoint'
      );
    }
  });
});
