#!/usr/bin/env bun
/**
 * Tests for --version flag behavior
 * Tests for issue #22: --version issues
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execSync, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

// Path to the CLI
const cliPath = path.resolve(__dirname, '../src/bin/cli.js');

/**
 * Helper to run the CLI command
 */
function runCli(args) {
  try {
    // Use '--' separator to ensure args are passed to the script, not consumed by bun
    // This is important for testing edge cases like passing '--' as an argument
    const result = spawnSync('bun', [cliPath, '--', ...args], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        START_DISABLE_AUTO_ISSUE: '1',
        START_DISABLE_LOG_UPLOAD: '1',
      },
    });
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.status,
      error: result.error,
    };
  } catch (error) {
    return {
      stdout: '',
      stderr: error.message,
      exitCode: 1,
      error,
    };
  }
}

describe('Version Flag Tests', () => {
  describe('Basic version flag', () => {
    it('should show version with --version', () => {
      const result = runCli(['--version']);
      assert.strictEqual(result.exitCode, 0, 'Exit code should be 0');
      assert.match(
        result.stdout,
        /start-command version:/,
        'Should show start-command version'
      );
    });

    it('should show version with -v', () => {
      const result = runCli(['-v']);
      assert.strictEqual(result.exitCode, 0, 'Exit code should be 0');
      assert.match(
        result.stdout,
        /start-command version:/,
        'Should show start-command version'
      );
    });

    it('should show version with --version -- (trailing separator)', () => {
      const result = runCli(['--version', '--']);
      assert.strictEqual(result.exitCode, 0, 'Exit code should be 0');
      assert.match(
        result.stdout,
        /start-command version:/,
        'Should show start-command version with trailing --'
      );
      assert.doesNotMatch(
        result.stderr,
        /No command provided/,
        'Should not show "No command provided" error'
      );
    });
  });

  describe('Runtime detection', () => {
    it('should show Bun version when running with Bun', () => {
      const result = runCli(['--version']);
      assert.strictEqual(result.exitCode, 0, 'Exit code should be 0');

      // When running with Bun, should show "Bun Version"
      if (typeof Bun !== 'undefined') {
        assert.match(
          result.stdout,
          /Bun Version:/,
          'Should show "Bun Version:" when running with Bun'
        );
        assert.doesNotMatch(
          result.stdout,
          /Node\.js Version:/,
          'Should not show "Node.js Version:" when running with Bun'
        );
      } else {
        // When running with Node.js, should show "Node.js Version"
        assert.match(
          result.stdout,
          /Node\.js Version:/,
          'Should show "Node.js Version:" when running with Node.js'
        );
      }
    });
  });

  describe('OS version detection', () => {
    it('should show OS information', () => {
      const result = runCli(['--version']);
      assert.strictEqual(result.exitCode, 0, 'Exit code should be 0');
      assert.match(result.stdout, /OS:/, 'Should show OS');
      assert.match(result.stdout, /OS Version:/, 'Should show OS Version');
    });

    it('should show macOS ProductVersion on darwin', () => {
      const result = runCli(['--version']);
      assert.strictEqual(result.exitCode, 0, 'Exit code should be 0');

      if (process.platform === 'darwin') {
        // Get the actual macOS version using sw_vers
        const macOSVersion = execSync('sw_vers -productVersion', {
          encoding: 'utf8',
        }).trim();

        // Version output should contain the ProductVersion, not the kernel version
        assert.match(
          result.stdout,
          new RegExp(`OS Version: ${macOSVersion.replace('.', '\\.')}`),
          `Should show macOS ProductVersion (${macOSVersion}), not kernel version`
        );

        // Should NOT show kernel version (which starts with 2x on modern macOS)
        const kernelVersion = os.release();
        if (kernelVersion.startsWith('2')) {
          assert.doesNotMatch(
            result.stdout,
            new RegExp(`OS Version: ${kernelVersion.replace('.', '\\.')}`),
            `Should not show kernel version (${kernelVersion})`
          );
        }
      }
    });
  });

  describe('Tool version detection', () => {
    it('should detect screen version if installed', () => {
      const result = runCli(['--version']);
      assert.strictEqual(result.exitCode, 0, 'Exit code should be 0');

      // Check if screen is actually installed
      try {
        const screenVersion = execSync('screen --version 2>&1', {
          encoding: 'utf8',
          timeout: 5000,
        });

        if (screenVersion) {
          // If screen is installed, it should not show "not installed"
          assert.doesNotMatch(
            result.stdout,
            /screen: not installed/,
            'Should not show "screen: not installed" when screen is available'
          );
          assert.match(
            result.stdout,
            /screen:/,
            'Should show screen version info'
          );
        }
      } catch {
        // Screen is not installed, should show "not installed"
        assert.match(
          result.stdout,
          /screen: not installed/,
          'Should show "screen: not installed" when screen is unavailable'
        );
      }
    });

    it('should detect tmux version if installed', () => {
      const result = runCli(['--version']);
      assert.strictEqual(result.exitCode, 0, 'Exit code should be 0');

      // Check if tmux is actually installed
      try {
        const tmuxVersion = execSync('tmux -V 2>&1', {
          encoding: 'utf8',
          timeout: 5000,
        });

        if (tmuxVersion) {
          // If tmux is installed, it should not show "not installed"
          assert.doesNotMatch(
            result.stdout,
            /tmux: not installed/,
            'Should not show "tmux: not installed" when tmux is available'
          );
        }
      } catch {
        // tmux is not installed, should show "not installed"
        assert.match(
          result.stdout,
          /tmux: not installed/,
          'Should show "tmux: not installed" when tmux is unavailable'
        );
      }
    });

    it('should detect docker version if installed', () => {
      const result = runCli(['--version']);
      assert.strictEqual(result.exitCode, 0, 'Exit code should be 0');

      // Check if docker is actually installed
      try {
        const dockerVersion = execSync('docker --version 2>&1', {
          encoding: 'utf8',
          timeout: 5000,
        });

        if (dockerVersion) {
          // If docker is installed, it should not show "not installed"
          assert.doesNotMatch(
            result.stdout,
            /docker: not installed/,
            'Should not show "docker: not installed" when docker is available'
          );
        }
      } catch {
        // docker is not installed, should show "not installed"
        assert.match(
          result.stdout,
          /docker: not installed/,
          'Should show "docker: not installed" when docker is unavailable'
        );
      }
    });
  });

  describe('Error cases', () => {
    it('should error with "No command provided" for $ --', () => {
      const result = runCli(['--']);
      assert.strictEqual(result.exitCode, 1, 'Exit code should be 1');
      const output = result.stdout + result.stderr;
      assert.match(
        output,
        /No command provided/,
        'Should show "No command provided" error for --'
      );
    });

    it('should error with "No command provided" for no args', () => {
      const result = runCli([]);
      assert.strictEqual(result.exitCode, 0, 'Should show usage and exit 0');
      assert.match(result.stdout, /Usage:/, 'Should show usage message');
    });
  });
});
