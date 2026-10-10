/** Copy only a command script into a stopped container, never its writable layer. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shellQuote } = require('./isolation-log-utils');

function commandHandoffPath(sessionName) {
  return `/.start-command-resume-${String(sessionName).replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

function buildCommandHandoffArgs(mainArgs, markerPath) {
  return [
    'sh',
    '-c',
    'p=$1; shift; if [ -f "$p" ]; then exec sh "$p"; fi; exec "$@"',
    'start-command-handoff',
    markerPath,
    ...mainArgs,
  ];
}

function buildCommandHandoffScript(command, options = {}) {
  const {
    isInteractiveShellCommand,
    isShellInvocationWithArgs,
    buildShellWithArgsCmdArgs,
    toShellWords,
  } = require('./shell-utils');
  if (
    !options.keepAlive &&
    (isInteractiveShellCommand(command) || isShellInvocationWithArgs(command))
  ) {
    const args = isShellInvocationWithArgs(command)
      ? buildShellWithArgsCmdArgs(command)
      : toShellWords(command);
    return `exec ${args.map(shellQuote).join(' ')}\n`;
  }
  if (!options.shell || options.shell === 'auto') {
    const effective = options.keepAlive
      ? `${command}; exec "$__START_COMMAND_HANDOFF_SHELL"`
      : command;
    return `__START_COMMAND_HANDOFF_SHELL=$(command -v bash || command -v zsh || command -v sh); export __START_COMMAND_HANDOFF_SHELL\ncase "$__START_COMMAND_HANDOFF_SHELL" in */bash|bash|*/zsh|zsh) exec "$__START_COMMAND_HANDOFF_SHELL" -i -c ${shellQuote(effective)};; *) exec "$__START_COMMAND_HANDOFF_SHELL" -c ${shellQuote(effective)};; esac\n`;
  }
  const shell = options.shell;
  const interactive = /(?:^|\/)(?:bash|zsh)$/.test(shell) ? ' -i' : '';
  const effective = options.keepAlive
    ? `${command}; exec ${shellQuote(shell)}`
    : command;
  return `exec ${shellQuote(shell)}${interactive} -c ${shellQuote(effective)}\n`;
}

function writeCommandHandoff(containerName, command, runner, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-handoff-'));
  const file = path.join(dir, 'command');
  try {
    fs.writeFileSync(file, buildCommandHandoffScript(command, options), {
      mode: 0o644,
    });
    fs.chmodSync(file, 0o644);
    return runner(require('./docker-cleanup').getDockerCommand(), [
      'cp',
      file,
      `${containerName}:${commandHandoffPath(containerName)}`,
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  commandHandoffPath,
  buildCommandHandoffArgs,
  buildCommandHandoffScript,
  writeCommandHandoff,
};
