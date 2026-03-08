#!/usr/bin/env bun
/**
 * Regression tests for issue #84: "We should not run bash inside bash"
 *
 * These tests guard against the shell-inside-shell regression where
 * `$ --isolated docker -- bash` caused:
 *   docker run ... image /bin/bash -i -c bash   (WRONG: bash inside bash)
 * instead of:
 *   docker run ... image bash                    (CORRECT: bare shell)
 *
 * The same regression applies to zsh, sh, and all other isolation backends.
 *
 * Also tests the post-fix regression hint: when a bare shell exits with code 1
 * quickly (< 3s), a helpful hint suggests `bash --norc` as a workaround for
 * containers whose .bashrc causes bash to exit non-zero (issue #84, second comment).
 *
 * Reference: https://github.com/link-foundation/start/issues/84
 * Fixed in: PR #85 (v0.24.1) via isInteractiveShellCommand()
 * Hint added in: PR #87 for the post-fix regression (broken .bashrc in sandbox)
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { isInteractiveShellCommand } = require('../src/lib/isolation');

// Helper: mirrors the command-args construction logic used in
// runInDocker (attached + detached), runInScreen, and runInSsh.
// If this helper returns args containing '-c' for a bare shell command,
// the shell-inside-shell bug is present.
function buildCmdArgs(command, shellToUse = '/bin/bash') {
  const shellName = shellToUse.split('/').pop();
  const shellInteractiveFlag =
    shellName === 'bash' || shellName === 'zsh' ? '-i' : null;
  const shellArgs = shellInteractiveFlag
    ? [shellToUse, shellInteractiveFlag]
    : [shellToUse];
  return isInteractiveShellCommand(command)
    ? command.trim().split(/\s+/)
    : [...shellArgs, '-c', command];
}

describe('isInteractiveShellCommand additional cases (issue #84)', () => {
  // These cover edge cases not in the base isInteractiveShellCommand test suite.

  // Workaround: bash --norc skips .bashrc sourcing (post-fix regression workaround)
  it('should return true for "bash --norc"', () => {
    assert.strictEqual(isInteractiveShellCommand('bash --norc'), true);
  });

  it('should return true for "zsh --no-rcs"', () => {
    assert.strictEqual(isInteractiveShellCommand('zsh --no-rcs'), true);
  });

  it('should return true for "bash -i" (interactive flag, no -c)', () => {
    assert.strictEqual(isInteractiveShellCommand('bash -i'), true);
  });

  it('should return true for "fish"', () => {
    assert.strictEqual(isInteractiveShellCommand('fish'), true);
  });

  it('should return true for "dash"', () => {
    assert.strictEqual(isInteractiveShellCommand('dash'), true);
  });

  it('should return true for "/usr/local/bin/bash"', () => {
    assert.strictEqual(isInteractiveShellCommand('/usr/local/bin/bash'), true);
  });

  it('should return false for \'bash -c "echo hello"\'', () => {
    assert.strictEqual(
      isInteractiveShellCommand('bash -c "echo hello"'),
      false
    );
  });
});

describe('Regression: No Shell-Inside-Shell (issue #84)', () => {
  // Each test verifies that the command-arg construction logic does NOT
  // wrap a bare shell invocation inside another shell with `-c`.
  //
  // Before fix: buildCmdArgs('bash') → ['/bin/bash', '-i', '-c', 'bash']
  // After fix:  buildCmdArgs('bash') → ['bash']

  it('should pass "bash" directly, not wrap in shell -c', () => {
    const args = buildCmdArgs('bash');
    assert.deepStrictEqual(
      args,
      ['bash'],
      `Expected ["bash"], got: ${JSON.stringify(args)}`
    );
    assert.ok(
      !args.includes('-c'),
      'Must not contain -c flag (shell-inside-shell)'
    );
  });

  it('should pass "zsh" directly, not wrap in shell -c', () => {
    const args = buildCmdArgs('zsh');
    assert.deepStrictEqual(args, ['zsh']);
    assert.ok(
      !args.includes('-c'),
      'Must not contain -c flag (shell-inside-shell)'
    );
  });

  it('should pass "sh" directly, not wrap in shell -c', () => {
    const args = buildCmdArgs('sh', 'sh');
    assert.deepStrictEqual(args, ['sh']);
    assert.ok(
      !args.includes('-c'),
      'Must not contain -c flag (shell-inside-shell)'
    );
  });

  it('should pass "/bin/bash" directly, not wrap in shell -c', () => {
    const args = buildCmdArgs('/bin/bash');
    assert.deepStrictEqual(args, ['/bin/bash']);
    assert.ok(
      !args.includes('-c'),
      'Must not contain -c flag (shell-inside-shell)'
    );
  });

  it('should pass "bash --norc" directly (workaround for broken .bashrc)', () => {
    const args = buildCmdArgs('bash --norc');
    assert.deepStrictEqual(args, ['bash', '--norc']);
    assert.ok(!args.includes('-c'), 'Must not contain -c flag');
  });

  it('should pass "bash -l" directly (login shell)', () => {
    const args = buildCmdArgs('bash -l');
    assert.deepStrictEqual(args, ['bash', '-l']);
    assert.ok(!args.includes('-c'), 'Must not contain -c flag');
  });

  it('should still wrap non-shell commands in shell -c (guard against over-broad fix)', () => {
    const args = buildCmdArgs('echo hello', '/bin/bash');
    assert.deepStrictEqual(args, ['/bin/bash', '-i', '-c', 'echo hello']);
    assert.ok(
      args.includes('-c'),
      'Non-shell commands must still use -c wrapper'
    );
  });

  it('should still wrap "npm test" in shell -c (guard against over-broad fix)', () => {
    const args = buildCmdArgs('npm test', '/bin/bash');
    assert.deepStrictEqual(args, ['/bin/bash', '-i', '-c', 'npm test']);
    assert.ok(
      args.includes('-c'),
      'Non-shell commands must still use -c wrapper'
    );
  });

  it('should not treat "bash -c something" as bare shell', () => {
    // bash -c ... has -c, so isInteractiveShellCommand returns false
    // The command gets wrapped: ['/bin/bash', '-i', '-c', 'bash -c "echo hi"']
    const args = buildCmdArgs('bash -c "echo hi"', '/bin/bash');
    assert.ok(
      args.includes('-c'),
      'bash -c commands should be treated as regular commands'
    );
  });
});

describe('Post-fix regression hint: --norc suggestion (issue #84)', () => {
  // These tests verify the hint logic that recommends --norc when a bare shell
  // exits quickly with code 1 (e.g., broken .bashrc in konard/sandbox image).
  // The hint is shown in runInDocker attached mode when:
  //   isBareShell && code !== 0 && durationMs < 3000

  // Helper mirrors the hint construction logic in isolation.js runInDocker.
  const path = require('path');
  function buildHint(command) {
    const shellName = command.trim().split(/\s+/)[0];
    const noRcFlag = path.basename(shellName) === 'zsh' ? '--no-rcs' : '--norc';
    return (
      `Hint: The shell exited immediately — its startup file (.bashrc/.zshrc) may have errors.\n` +
      `Try skipping startup files: ${shellName} ${noRcFlag}`
    );
  }

  it('should suggest --norc for bare bash that exits quickly', () => {
    const hint = buildHint('bash');
    assert.ok(hint.includes('--norc'), 'Hint must include --norc for bash');
    assert.ok(
      hint.includes('bash --norc'),
      'Hint must show the full corrected command'
    );
    assert.ok(
      hint.includes('startup file'),
      'Hint must explain why the shell exited'
    );
  });

  it('should suggest --no-rcs for bare zsh that exits quickly', () => {
    const hint = buildHint('zsh');
    assert.ok(hint.includes('--no-rcs'), 'Hint must include --no-rcs for zsh');
    assert.ok(
      hint.includes('zsh --no-rcs'),
      'Hint must show the full corrected command'
    );
  });

  it('should suggest --norc for /bin/bash path that exits quickly', () => {
    const hint = buildHint('/bin/bash');
    assert.ok(
      hint.includes('/bin/bash --norc'),
      'Hint must include full path with --norc'
    );
  });

  it('should suggest --norc for bare sh that exits quickly', () => {
    const hint = buildHint('sh');
    assert.ok(hint.includes('sh --norc'), 'Hint must suggest --norc for sh');
  });

  it('should confirm workaround: bash --norc is detected as bare shell', () => {
    // The workaround (bash --norc) must still be recognized as a bare shell
    // so it gets passed directly to docker without -c wrapping
    assert.strictEqual(
      isInteractiveShellCommand('bash --norc'),
      true,
      'bash --norc must be a bare shell (no -c wrapping)'
    );
    assert.strictEqual(
      isInteractiveShellCommand('zsh --no-rcs'),
      true,
      'zsh --no-rcs must be a bare shell (no -c wrapping)'
    );
  });
});
