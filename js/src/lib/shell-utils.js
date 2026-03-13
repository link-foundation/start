/** Shell command detection and argument-building utilities for start-command */

const path = require('path');

const SHELL_NAMES = ['bash', 'zsh', 'sh', 'fish', 'ksh', 'csh', 'tcsh', 'dash'];

/** True if command is a bare shell invocation (no -c); avoids bash-inside-bash (issue #84). */
function isInteractiveShellCommand(command) {
  const parts = command.trim().split(/\s+/);
  return SHELL_NAMES.includes(path.basename(parts[0])) && !parts.includes('-c');
}

/** True if command is a shell invocation with -c (e.g. `bash -i -c "cmd"`); avoids double-wrapping (issue #91). */
function isShellInvocationWithArgs(command) {
  const parts = command.trim().split(/\s+/);
  return SHELL_NAMES.includes(path.basename(parts[0])) && parts.includes('-c');
}

/** Build argv for shell-with-c command; everything after -c is one argument (reverses commandArgs.join(' ')). */
function buildShellWithArgsCmdArgs(command) {
  const parts = command.trim().split(/\s+/);
  const cIdx = parts.indexOf('-c');
  if (cIdx === -1) {
    return parts;
  }
  const scriptArg = parts.slice(cIdx + 1).join(' ');
  return scriptArg.length > 0
    ? [...parts.slice(0, cIdx + 1), scriptArg]
    : parts.slice(0, cIdx + 1);
}

/** Build a display string for a command, quoting arguments that contain spaces (issue #91). */
function buildDisplayCommand(command) {
  if (!isShellInvocationWithArgs(command)) {
    return command;
  }
  const argv = buildShellWithArgsCmdArgs(command);
  return argv.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');
}

module.exports = {
  SHELL_NAMES,
  isInteractiveShellCommand,
  isShellInvocationWithArgs,
  buildShellWithArgsCmdArgs,
  buildDisplayCommand,
};
