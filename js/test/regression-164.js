/**
 * Regression tests for issue #164:
 * "Command argv is flattened with join(' '), so quoted arguments are re-parsed
 *  by the inner shell (`$ node -e \"console.log('hi')\"` fails)"
 *
 * Root cause:
 *   parseArgs() returned `commandArgs.join(' ')`, so every argument boundary and
 *   every quote the user typed was destroyed before the command reached
 *   `sh -c`. `node -e "console.log('hi')"` became `node -e console.log('hi')`
 *   (a syntax error), and `echo "a  b"` became `echo a  b` (re-split into two
 *   words). `buildShellWithArgsCmdArgs()` repaired only the `<shell> -c …`
 *   shape (issue #91) and only on the isolation code paths.
 *
 * Fix:
 *   parseArgs() rebuilds the command with buildCommandString(): a single
 *   argument is a shell script the user quoted as a whole and stays verbatim,
 *   while multiple arguments are each shell-quoted so the inner shell sees the
 *   argv the user typed.
 *
 * Reference: https://github.com/link-foundation/start/issues/164
 */

const { describe, it, expect } = require('bun:test');
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const { parseArgs } = require('../src/lib/args-parser');
const {
  buildCommandString,
  buildDisplayCommand,
  buildShellWithArgsCmdArgs,
  getCommandName,
  isInteractiveShellCommand,
  isShellInvocationWithArgs,
  quoteShellArg,
  splitShellWords,
} = require('../src/lib/shell-utils');

const CLI_PATH = path.join(__dirname, '../src/bin/cli.js');
const TEST_APP_FOLDER = path.join(
  os.tmpdir(),
  `regression-164-${process.pid}-${Date.now()}`
);

/** Run the CLI the way a shell would: one process argument per argv element. */
function runCli(argv) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: 'utf8',
    env: {
      ...process.env,
      START_APP_FOLDER: TEST_APP_FOLDER,
      START_DISABLE_AUTO_ISSUE: '1',
    },
    timeout: 20000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

/** The command output sits between the start block and the finish block. */
function commandOutput(stdout) {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line.startsWith('$ '));
  const finish = lines.findIndex((line) => line === '✓' || line === '✗');
  return lines.slice(start + 2, finish - 1).join('\n');
}

function displayedCommand(stdout) {
  return (stdout.split('\n').find((line) => line.startsWith('$ ')) || '').slice(
    2
  );
}

describe('parseArgs keeps argv boundaries (issue #164)', () => {
  it('quotes an argument that contains a shell metacharacter', () => {
    const { command, rawCommand } = parseArgs([
      'node',
      '-e',
      "console.log('hi')",
    ]);
    expect(command).toBe("node -e 'console.log('\\''hi'\\'')'");
    expect(rawCommand).toEqual(['node', '-e', "console.log('hi')"]);
  });

  it('quotes an argument that contains repeated spaces', () => {
    expect(parseArgs(['echo', 'a  b']).command).toBe("echo 'a  b'");
  });

  it('keeps a single argument verbatim so shell scripts still work', () => {
    expect(parseArgs(['ls | wc -l']).command).toBe('ls | wc -l');
  });

  it('leaves ordinary arguments unquoted', () => {
    expect(parseArgs(['git', 'log', '-1', '--pretty=%s']).command).toBe(
      'git log -1 --pretty=%s'
    );
  });

  it('keeps boundaries after the -- separator', () => {
    const { command } = parseArgs([
      '--isolated',
      'docker',
      '--',
      'git',
      'commit',
      '-m',
      'msg with spaces',
    ]);
    expect(command).toBe("git commit -m 'msg with spaces'");
  });

  it('returns an empty command when no command was given', () => {
    expect(parseArgs(['--list']).command).toBe('');
  });
});

describe('buildCommandString and quoteShellArg (issue #164)', () => {
  it('returns an empty string for empty argv', () => {
    expect(buildCommandString([])).toBe('');
  });

  it('escapes embedded single quotes', () => {
    expect(quoteShellArg("it's")).toBe("'it'\\''s'");
  });

  it('quotes an empty argument so it survives as an argument', () => {
    expect(buildCommandString(['echo', ''])).toBe("echo ''");
  });

  it('round-trips through splitShellWords', () => {
    const argv = ['node', '-e', "console.log('a  b')", 'x$y', ''];
    expect(splitShellWords(buildCommandString(argv))).toEqual(argv);
  });
});

describe('splitShellWords (issue #164)', () => {
  it('splits on unquoted whitespace', () => {
    expect(splitShellWords('echo a b')).toEqual(['echo', 'a', 'b']);
  });

  it('keeps double-quoted words together', () => {
    expect(splitShellWords('echo "a  b"')).toEqual(['echo', 'a  b']);
  });

  it('keeps single-quoted words together', () => {
    expect(splitShellWords("echo 'a  b'")).toEqual(['echo', 'a  b']);
  });

  it('honours backslash escapes', () => {
    expect(splitShellWords('echo a\\ b')).toEqual(['echo', 'a b']);
  });

  it('returns null when quoting is unbalanced', () => {
    expect(splitShellWords('echo "a')).toBe(null);
  });
});

describe('shell detection stays correct for quoted commands (issue #164)', () => {
  it('still detects a bare shell invocation', () => {
    expect(isInteractiveShellCommand('bash')).toBe(true);
    expect(isInteractiveShellCommand("bash -c 'echo hi'")).toBe(false);
  });

  it('detects a shell invocation whose script argument is quoted', () => {
    expect(isShellInvocationWithArgs("bash -c 'echo hi'")).toBe(true);
  });

  it('passes the quoted script through as a single argv element', () => {
    expect(buildShellWithArgsCmdArgs("bash -i -c 'nvm --version'")).toEqual([
      'bash',
      '-i',
      '-c',
      'nvm --version',
    ]);
  });

  it('reads the command name from the first shell word', () => {
    expect(getCommandName("'my command' --flag")).toBe('my command');
  });
});

describe('buildDisplayCommand shows the argv the user typed (issue #164)', () => {
  it('re-quotes an argument that was quoted by the parser', () => {
    expect(buildDisplayCommand(parseArgs(['echo', 'a  b']).command)).toBe(
      'echo "a  b"'
    );
  });

  it('re-quotes an argument containing shell metacharacters', () => {
    expect(
      buildDisplayCommand(
        parseArgs(['node', '-e', "console.log('hi')"]).command
      )
    ).toBe('node -e "console.log(\'hi\')"');
  });

  it('shows a single-argument shell script verbatim', () => {
    expect(buildDisplayCommand('ls | wc -l')).toBe('ls | wc -l');
  });
});

describe('CLI end to end (issue #164)', () => {
  it('runs node -e with a quoted script', () => {
    const result = runCli(['node', '-e', "console.log('hi')"]);
    expect(result.exitCode).toBe(0);
    expect(commandOutput(result.stdout)).toBe('hi');
  });

  it('preserves repeated spaces inside a quoted argument', () => {
    const result = runCli(['echo', 'a  b']);
    expect(result.exitCode).toBe(0);
    expect(commandOutput(result.stdout)).toBe('a  b');
  });

  it('keeps `bash -c` scripts intact on the direct path (issue #91 shape)', () => {
    const result = runCli(['bash', '-c', 'echo hello world']);
    expect(result.exitCode).toBe(0);
    expect(commandOutput(result.stdout)).toBe('hello world');
  });

  it('keeps arithmetic expansion inside `bash -c` intact', () => {
    const result = runCli(['bash', '-c', 'echo $((1+1))']);
    expect(result.exitCode).toBe(0);
    expect(commandOutput(result.stdout)).toBe('2');
  });

  it('still runs a single quoted argument as a shell script', () => {
    const result = runCli(['echo one | tr a-z A-Z']);
    expect(result.exitCode).toBe(0);
    expect(commandOutput(result.stdout)).toBe('ONE');
  });

  it('displays the command with the quoting the user typed', () => {
    const result = runCli(['echo', 'a  b']);
    expect(displayedCommand(result.stdout)).toBe('echo "a  b"');
  });
});
