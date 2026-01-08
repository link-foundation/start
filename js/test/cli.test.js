#!/usr/bin/env bun
/**
 * Unit tests for the CLI
 * Tests version flag and basic CLI behavior
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Path to the CLI script
const CLI_PATH = path.join(__dirname, '../src/bin/cli.js');

// Timeout for CLI operations - longer on Windows due to cold-start latency
const CLI_TIMEOUT = process.platform === 'win32' ? 30000 : 10000;

// Helper to run CLI with timeout
function runCLI(args = []) {
  return spawnSync('bun', [CLI_PATH, ...args], {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT,
    env: {
      ...process.env,
      START_DISABLE_AUTO_ISSUE: '1',
      START_DISABLE_LOG_UPLOAD: '1',
    },
  });
}

describe('CLI version flag', () => {
  it('should display version with --version', () => {
    const result = runCLI(['--version']);

    // Check if process was killed (e.g., due to timeout)
    assert.notStrictEqual(
      result.status,
      null,
      `Process should complete (was killed with signal: ${result.signal})`
    );
    assert.strictEqual(result.status, 0, 'Exit code should be 0');

    // Check for key elements in version output
    assert.ok(
      result.stdout.includes('start-command version:'),
      'Should display start-command version'
    );
    assert.ok(result.stdout.includes('OS:'), 'Should display OS');
    assert.ok(
      result.stdout.includes('OS Version:'),
      'Should display OS Version'
    );
    // Check for either Bun or Node.js version depending on runtime
    const hasBunVersion = result.stdout.includes('Bun Version:');
    const hasNodeVersion = result.stdout.includes('Node.js Version:');
    assert.ok(
      hasBunVersion || hasNodeVersion,
      'Should display Bun Version or Node.js Version'
    );
    assert.ok(
      result.stdout.includes('Architecture:'),
      'Should display Architecture'
    );
    assert.ok(
      result.stdout.includes('Isolation tools:'),
      'Should display Isolation tools section'
    );
    assert.ok(
      result.stdout.includes('screen:'),
      'Should check for screen installation'
    );
    assert.ok(
      result.stdout.includes('tmux:'),
      'Should check for tmux installation'
    );
    assert.ok(
      result.stdout.includes('docker:'),
      'Should check for docker installation'
    );
  });

  it('should display version with -v', () => {
    const result = runCLI(['-v']);

    assert.strictEqual(result.status, 0, 'Exit code should be 0');
    assert.ok(
      result.stdout.includes('start-command version:'),
      'Should display start-command version'
    );
  });

  it('should show correct package version', () => {
    const result = runCLI(['--version']);
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')
    );

    assert.ok(
      result.stdout.includes(`start-command version: ${packageJson.version}`),
      `Should display version ${packageJson.version}`
    );
  });
});

describe('CLI basic behavior', () => {
  it('should show usage when no arguments provided', () => {
    const result = runCLI([]);

    assert.strictEqual(result.status, 0, 'Exit code should be 0');
    assert.ok(result.stdout.includes('Usage:'), 'Should display usage');
    assert.ok(
      result.stdout.includes('--version'),
      'Usage should mention --version flag'
    );
  });

  it('should show usage when no command provided after --', () => {
    const result = runCLI(['--']);

    assert.strictEqual(result.status, 0, 'Exit code should be 0');
    assert.ok(result.stdout.includes('Usage:'), 'Should display usage');
  });
});

describe('CLI isolation output (issue #67)', () => {
  const { isCommandAvailable } = require('../src/lib/isolation');

  it('should display screen session name when using screen isolation', async () => {
    if (!isCommandAvailable('screen')) {
      console.log('  Skipping: screen not installed');
      return;
    }

    const result = runCLI(['-i', 'screen', '--', 'echo', 'hello']);

    // The output should contain the screen session name (in format screen-timestamp-random)
    // Check that the session UUID is displayed
    assert.ok(
      result.stdout.includes('│ session'),
      'Should display session UUID'
    );
    // Check that screen isolation info is displayed
    assert.ok(
      result.stdout.includes('│ isolation screen'),
      'Should display screen isolation'
    );
    // Check that the actual screen session name is displayed (issue #67 fix)
    assert.ok(
      result.stdout.includes('│ screen    screen-'),
      'Should display actual screen session name for reconnection (issue #67)'
    );
  });

  it('should display tmux session name when using tmux isolation', async () => {
    if (!isCommandAvailable('tmux')) {
      console.log('  Skipping: tmux not installed');
      return;
    }

    const result = runCLI(['-i', 'tmux', '--', 'echo', 'hello']);

    // The output should contain the tmux session name
    assert.ok(
      result.stdout.includes('│ session'),
      'Should display session UUID'
    );
    assert.ok(
      result.stdout.includes('│ isolation tmux'),
      'Should display tmux isolation'
    );
    // Check that the actual tmux session name is displayed (issue #67 fix)
    assert.ok(
      result.stdout.includes('│ tmux      tmux-'),
      'Should display actual tmux session name for reconnection (issue #67)'
    );
  });

  it('should display docker container name when using docker isolation', async () => {
    const { canRunLinuxDockerImages } = require('../src/lib/isolation');

    if (!canRunLinuxDockerImages()) {
      console.log(
        '  Skipping: docker not available or cannot run Linux images'
      );
      return;
    }

    const result = runCLI([
      '-i',
      'docker',
      '--image',
      'alpine:latest',
      '--',
      'echo',
      'hello',
    ]);

    // The output should contain the docker container name
    assert.ok(
      result.stdout.includes('│ session'),
      'Should display session UUID'
    );
    assert.ok(
      result.stdout.includes('│ isolation docker'),
      'Should display docker isolation'
    );
    assert.ok(
      result.stdout.includes('│ image     alpine:latest'),
      'Should display docker image'
    );
    // Check that the actual container name is displayed (issue #67 fix)
    assert.ok(
      result.stdout.includes('│ container docker-'),
      'Should display actual container name for reconnection (issue #67)'
    );
  });
});
