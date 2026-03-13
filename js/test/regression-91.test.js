#!/usr/bin/env bun
/**
 * Regression tests for issue #91:
 * "`bash -i -c "nvm --version"` was interpreted as `bash -i -c nvm --version`,
 *  and executed inside bash, instead of directly"
 *
 * Two bugs were reported:
 *
 * Bug 1 — Quote stripping / wrong interpretation:
 *   `bash -i -c "nvm --version"` was treated as `bash -i -c nvm` with `--version`
 *   as $0. Caused by join(' ') collapsing the quoted argument, then the command
 *   being re-wrapped in an outer shell: `bash -i -c "bash -i -c nvm --version"`.
 *   The outer bash then parsed `nvm --version` as two separate words.
 *
 * Bug 2 — Executed inside bash (double-wrapping):
 *   Because isInteractiveShellCommand() returns false for any command with -c,
 *   the code wrapped `bash -i -c "nvm --version"` inside another `bash -i -c "..."`.
 *   This caused the sudo advisory message to print twice (one per bash invocation).
 *
 * Root cause:
 *   isInteractiveShellCommand() only returns true for bare shell invocations
 *   (no -c flag). Commands that ARE a shell invocation but include -c fell into the
 *   else-branch: `[shellToUse, shellInteractiveFlag, '-c', command]`, creating a
 *   shell-inside-shell. The fix adds isShellInvocationWithArgs() + buildShellWithArgsCmdArgs()
 *   to detect and pass such commands directly to Docker without additional wrapping.
 *
 * Reference: https://github.com/link-foundation/start/issues/91
 * Fixed in: PR #92
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const {
  isInteractiveShellCommand,
  isShellInvocationWithArgs,
  buildShellWithArgsCmdArgs,
} = require('../src/lib/isolation');

// Helper: mirrors the attached-mode command-args construction logic in runInDocker.
// Returns the argv array that would be passed to `docker run ... image <argv>`.
function buildAttachedCmdArgs(command, shellToUse = '/bin/bash') {
  const path = require('path');
  const shellName = shellToUse.split('/').pop();
  const shellInteractiveFlag =
    shellName === 'bash' || shellName === 'zsh' ? '-i' : null;
  const shellCmdArgs = shellInteractiveFlag
    ? [shellToUse, shellInteractiveFlag]
    : [shellToUse];

  if (isInteractiveShellCommand(command)) {
    // Bare shell: pass directly with explicit -i (issue #84 fix)
    const parts = command.trim().split(/\s+/);
    const bareFlag =
      path.basename(parts[0]) === 'bash' || path.basename(parts[0]) === 'zsh'
        ? '-i'
        : null;
    if (bareFlag && !parts.includes(bareFlag)) {
      return [parts[0], bareFlag, ...parts.slice(1)];
    }
    return parts;
  } else if (isShellInvocationWithArgs(command)) {
    // Shell with -c: pass directly as argv (issue #91 fix)
    return buildShellWithArgsCmdArgs(command);
  }
  return [...shellCmdArgs, '-c', command];
}

describe('isShellInvocationWithArgs (issue #91)', () => {
  it('should return true for "bash -i -c nvm --version"', () => {
    assert.strictEqual(
      isShellInvocationWithArgs('bash -i -c nvm --version'),
      true
    );
  });

  it('should return true for \'bash -c "echo hello"\'', () => {
    assert.strictEqual(isShellInvocationWithArgs('bash -c "echo hello"'), true);
  });

  it('should return true for "bash -c echo hello"', () => {
    assert.strictEqual(isShellInvocationWithArgs('bash -c echo hello'), true);
  });

  it('should return true for "zsh -c nvm --version"', () => {
    assert.strictEqual(isShellInvocationWithArgs('zsh -c nvm --version'), true);
  });

  it('should return true for "sh -c ls"', () => {
    assert.strictEqual(isShellInvocationWithArgs('sh -c ls'), true);
  });

  it('should return true for "/bin/bash -c echo hi"', () => {
    assert.strictEqual(isShellInvocationWithArgs('/bin/bash -c echo hi'), true);
  });

  it('should return false for bare "bash" (no -c)', () => {
    assert.strictEqual(isShellInvocationWithArgs('bash'), false);
  });

  it('should return false for "bash -i" (no -c)', () => {
    assert.strictEqual(isShellInvocationWithArgs('bash -i'), false);
  });

  it('should return false for "bash --norc" (no -c)', () => {
    assert.strictEqual(isShellInvocationWithArgs('bash --norc'), false);
  });

  it('should return false for non-shell commands', () => {
    assert.strictEqual(isShellInvocationWithArgs('nvm --version'), false);
    assert.strictEqual(isShellInvocationWithArgs('echo hello'), false);
    assert.strictEqual(isShellInvocationWithArgs('npm test'), false);
  });
});

describe('buildShellWithArgsCmdArgs (issue #91)', () => {
  it('should reconstruct "bash -i -c nvm --version" correctly', () => {
    const result = buildShellWithArgsCmdArgs('bash -i -c nvm --version');
    assert.deepStrictEqual(result, ['bash', '-i', '-c', 'nvm --version']);
  });

  it('should reconstruct "bash -c echo hello" correctly', () => {
    const result = buildShellWithArgsCmdArgs('bash -c echo hello');
    assert.deepStrictEqual(result, ['bash', '-c', 'echo hello']);
  });

  it('should handle single-word script "bash -c ls"', () => {
    const result = buildShellWithArgsCmdArgs('bash -c ls');
    assert.deepStrictEqual(result, ['bash', '-c', 'ls']);
  });

  it('should handle zsh with -c', () => {
    const result = buildShellWithArgsCmdArgs('zsh -c nvm --version');
    assert.deepStrictEqual(result, ['zsh', '-c', 'nvm --version']);
  });

  it('should handle /bin/bash -i -c with multi-word script', () => {
    const result = buildShellWithArgsCmdArgs(
      '/bin/bash -i -c node -e process.version'
    );
    assert.deepStrictEqual(result, [
      '/bin/bash',
      '-i',
      '-c',
      'node -e process.version',
    ]);
  });

  it('should not include -c argument inside script argument (no double -c)', () => {
    const result = buildShellWithArgsCmdArgs('bash -i -c nvm --version');
    // The script arg must be 'nvm --version', not '-c nvm --version'
    assert.strictEqual(result[result.length - 1], 'nvm --version');
    assert.strictEqual(result.indexOf('-c'), 2);
    assert.strictEqual(result.length, 4);
  });
});

describe('Regression: No Double-Wrapping for Shell With -c (issue #91)', () => {
  // Each test verifies that `bash -i -c "cmd"` style commands are NOT re-wrapped
  // in another outer shell -c invocation.
  //
  // Before fix: buildAttachedCmdArgs('bash -i -c nvm --version')
  //   → ['/bin/bash', '-i', '-c', 'bash -i -c nvm --version']   (WRONG: double-wrap)
  // After fix:  buildAttachedCmdArgs('bash -i -c nvm --version')
  //   → ['bash', '-i', '-c', 'nvm --version']                   (CORRECT: direct pass)

  it('should pass "bash -i -c nvm --version" directly without outer shell wrapper', () => {
    const args = buildAttachedCmdArgs('bash -i -c nvm --version');
    // Must start with 'bash', not with '/bin/bash' (the outer shellToUse)
    assert.strictEqual(args[0], 'bash');
    // Must not wrap in outer bash -i -c
    assert.ok(
      args.filter((a) => a === '-c').length === 1,
      `Must have exactly one -c flag, got: ${JSON.stringify(args)}`
    );
    // The script argument must be 'nvm --version' as one element
    assert.deepStrictEqual(
      args,
      ['bash', '-i', '-c', 'nvm --version'],
      `Expected ['bash', '-i', '-c', 'nvm --version'], got: ${JSON.stringify(args)}`
    );
  });

  it('should pass "zsh -c nvm --version" directly without outer shell wrapper', () => {
    const args = buildAttachedCmdArgs('zsh -c nvm --version', '/bin/zsh');
    assert.deepStrictEqual(args, ['zsh', '-c', 'nvm --version']);
    assert.ok(
      args.filter((a) => a === '-c').length === 1,
      'Must have exactly one -c flag'
    );
  });

  it('should pass "bash -c echo hello" directly', () => {
    const args = buildAttachedCmdArgs('bash -c echo hello');
    assert.deepStrictEqual(args, ['bash', '-c', 'echo hello']);
  });

  it('should not introduce a second bash layer (no shell-inside-shell)', () => {
    const args = buildAttachedCmdArgs('bash -i -c nvm --version');
    // The first element of the docker image command args must NOT be the outer shell
    // i.e., must not be ['/bin/bash', '-i', '-c', 'bash ...']
    assert.notStrictEqual(
      args[0],
      '/bin/bash',
      'Must not wrap in outer /bin/bash (shell-inside-shell)'
    );
    // Must not contain the original full command string as an argument
    assert.ok(
      !args.includes('bash -i -c nvm --version'),
      'Must not contain the full command string as a single argument (double-wrap)'
    );
  });

  it('should still handle bare "bash" with -i (regression guard for issue #84)', () => {
    const args = buildAttachedCmdArgs('bash');
    assert.deepStrictEqual(args, ['bash', '-i']);
    assert.ok(
      !args.includes('-c'),
      'Bare shell must not use -c (issue #84 guard)'
    );
  });

  it('should still wrap non-shell commands in outer shell -c (guard against over-broad fix)', () => {
    const args = buildAttachedCmdArgs('nvm --version', '/bin/bash');
    assert.deepStrictEqual(args, ['/bin/bash', '-i', '-c', 'nvm --version']);
    assert.ok(
      args.includes('-c'),
      'Non-shell commands must still use -c wrapper'
    );
  });

  it('should still wrap "npm test" in outer shell -c', () => {
    const args = buildAttachedCmdArgs('npm test', '/bin/bash');
    assert.deepStrictEqual(args, ['/bin/bash', '-i', '-c', 'npm test']);
  });
});

describe('isShellInvocationWithArgs is mutually exclusive with isInteractiveShellCommand', () => {
  // A command cannot be both a bare shell AND a shell-with-args; they are disjoint.
  const testCases = [
    'bash',
    'bash -i',
    'bash --norc',
    'bash -i -c nvm --version',
    'bash -c echo hi',
    'zsh -c ls',
    'nvm --version',
    'echo hello',
  ];

  for (const cmd of testCases) {
    it(`"${cmd}" is not both bare-shell and shell-with-args`, () => {
      const bare = isInteractiveShellCommand(cmd);
      const withArgs = isShellInvocationWithArgs(cmd);
      assert.ok(
        !(bare && withArgs),
        `"${cmd}" must not return true from both helpers simultaneously`
      );
    });
  }
});
