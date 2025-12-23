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

// Helper to run CLI
function runCLI(args = []) {
  return spawnSync('bun', [CLI_PATH, ...args], {
    encoding: 'utf8',
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

    assert.strictEqual(result.status, 0, 'Exit code should be 0');

    // Check for key elements in version output
    assert.ok(
      result.stdout.includes('start-command version:'),
      'Should display start-command version'
    );
    assert.ok(result.stdout.includes('OS:'), 'Should display OS');
    assert.ok(
      result.stdout.includes('OS Release:'),
      'Should display OS Release'
    );
    assert.ok(
      result.stdout.includes('Node Version:'),
      'Should display Node Version'
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
