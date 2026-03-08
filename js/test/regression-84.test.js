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
 * Reference: https://github.com/link-foundation/start/issues/84
 * Fixed in: PR #85 (v0.24.1) via isInteractiveShellCommand()
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
