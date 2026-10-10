const { describe, it, expect } = require('bun:test');
const { spawnSync } = require('child_process');
const {
  isInteractiveShellCommand,
  isShellInvocationWithArgs,
  buildShellWithArgsCmdArgs,
  buildDisplayCommand,
} = require('../src/lib/shell-utils');

describe('shell command semantics (#202)', () => {
  for (const operator of [';', '&&', '||', '|', '&', '>', '<', '\n']) {
    it(`keeps the whole command line when it contains ${JSON.stringify(operator)}`, () => {
      const command = `sh -c 'exit 7'${operator} echo after $?`;
      expect(isShellInvocationWithArgs(command)).toBe(false);
      expect(buildDisplayCommand(command)).toBe(command);
      expect(isInteractiveShellCommand(`sh ${operator} echo after`)).toBe(
        false
      );
    });
  }
  it('preserves the script, empty positional argv, quotes, and quoted operators', () => {
    const command = `sh -c 'printf "%s\\n" "$0" "$1" "$2"; echo "|"' a 'b c' ''`;
    expect(isShellInvocationWithArgs(command)).toBe(true);
    expect(buildShellWithArgsCmdArgs(command)).toEqual([
      'sh',
      '-c',
      'printf "%s\\n" "$0" "$1" "$2"; echo "|"',
      'a',
      'b c',
      '',
    ]);
  });
  it('does not classify a missing script or a script-file argument as -c', () => {
    expect(isShellInvocationWithArgs('sh -c')).toBe(false);
    expect(isShellInvocationWithArgs("sh file -c 'echo hi'")).toBe(false);
  });
  it('retains direct bash -i -c behavior from #91', () => {
    expect(buildShellWithArgsCmdArgs('bash -i -c "nvm --version"')).toEqual([
      'bash',
      '-i',
      '-c',
      'nvm --version',
    ]);
  });
  it('leaves outer expansions, comments and globbing to the shell', () => {
    for (const command of [
      'sh -c "echo $$"',
      'sh -c echo $HOME',
      'sh -c echo *',
      'sh -c echo # comment',
      'sh -c echo {a,b}',
      "sh -c 'echo hi'\u00a0arg",
      'sh -c echo \\\nhi',
    ]) {
      expect(isShellInvocationWithArgs(command)).toBe(false);
    }
  });
  it('preserves literal escapes within a directly executed script', () => {
    expect(buildShellWithArgsCmdArgs('sh -c "printf \\q"')).toEqual([
      'sh',
      '-c',
      'printf \\q',
    ]);
    expect(buildShellWithArgsCmdArgs('sh -c "echo \\$0" a')).toEqual([
      'sh',
      '-c',
      'echo $0',
      'a',
    ]);
    expect(buildShellWithArgsCmdArgs('sh -c echo a\\;b')).toEqual([
      'sh',
      '-c',
      'echo',
      'a;b',
    ]);
  });
  const run = process.platform === 'win32' ? it.skip : it;
  for (const [command, output, status] of [
    ["sh -c 'exit 7'; echo after $?", 'after 7', 0],
    ["sh -c 'echo $0 $1' a b", 'a b', 0],
    ["sh -c 'kill -9 $$'; exit $?", '', 137],
  ]) {
    run(`executes ${command} with the expected output and exit`, () => {
      const args = isShellInvocationWithArgs(command)
        ? buildShellWithArgsCmdArgs(command)
        : ['sh', '-c', command];
      const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
      expect(result.stdout.trim()).toBe(output);
      expect(result.status).toBe(status);
    });
  }
});
