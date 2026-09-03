/** Shell command detection and argument-building utilities for start-command */

const path = require('path');

const SHELL_NAMES = ['bash', 'zsh', 'sh', 'fish', 'ksh', 'csh', 'tcsh', 'dash'];

/** Argument characters that a POSIX shell reads literally, so they need no quoting. */
const SAFE_ARG_PATTERN = /^[A-Za-z0-9_@%+=:,./^-]+$/;

/** Quote one argv element so a POSIX shell parses it back as exactly that element (issue #164). */
function quoteShellArg(arg) {
  const value = String(arg);
  return SAFE_ARG_PATTERN.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Rebuild a shell command line from the argv the user typed (issue #164).
 * A single element is a shell script the user quoted as a whole (`$ "ls | wc -l"`)
 * and is kept verbatim; multiple elements were split by the outer shell, so each
 * one is quoted to survive the inner shell unchanged.
 * @param {string[]} argv - Command arguments
 * @returns {string} Command line for `sh -c`
 */
function buildCommandString(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return '';
  }
  return argv.length === 1 ? argv[0] : argv.map(quoteShellArg).join(' ');
}

/**
 * Split a command line into shell words, honouring quotes and backslash escapes.
 * @param {string} command - Command line
 * @returns {string[]|null} Words, or null when quoting is unbalanced
 */
function splitShellWords(command) {
  const words = [];
  let current = '';
  let started = false;
  let quote = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === null && /\s/.test(char)) {
      if (started) {
        words.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    started = true;
    if (char === '\\' && quote !== "'") {
      if (i + 1 >= command.length) {
        return null;
      }
      current += command[++i];
      continue;
    }
    if (quote === null && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    current += char;
  }

  if (quote !== null) {
    return null;
  }
  if (started) {
    words.push(current);
  }
  return words;
}

/** Split a command into words, falling back to whitespace splitting when quoting is unbalanced. */
function toShellWords(command) {
  return (
    splitShellWords(command) ?? command.trim().split(/\s+/).filter(Boolean)
  );
}

/** True if command is a bare shell invocation (no -c); avoids bash-inside-bash (issue #84). */
function isInteractiveShellCommand(command) {
  const parts = toShellWords(command);
  return (
    parts.length > 0 &&
    SHELL_NAMES.includes(path.basename(parts[0])) &&
    !parts.includes('-c')
  );
}

/** True if command is a shell invocation with -c (e.g. `bash -i -c "cmd"`); avoids double-wrapping (issue #91). */
function isShellInvocationWithArgs(command) {
  const parts = toShellWords(command);
  return (
    parts.length > 0 &&
    SHELL_NAMES.includes(path.basename(parts[0])) &&
    parts.includes('-c')
  );
}

/** Build argv for shell-with-c command; everything after -c is one script argument. */
function buildShellWithArgsCmdArgs(command) {
  const parts = toShellWords(command);
  const cIdx = parts.indexOf('-c');
  if (cIdx === -1) {
    return parts;
  }
  const scriptArg = parts.slice(cIdx + 1).join(' ');
  return scriptArg.length > 0
    ? [...parts.slice(0, cIdx + 1), scriptArg]
    : parts.slice(0, cIdx + 1);
}

/** Quote an argument for display only, keeping the user-facing double-quoted form (issue #91). */
function quoteForDisplay(arg) {
  if (SAFE_ARG_PATTERN.test(arg)) {
    return arg;
  }
  return arg.includes('"') ? `'${arg}'` : `"${arg}"`;
}

/**
 * Build a display string that shows the argument boundaries the user typed
 * (issues #91, #164). A command the user quoted as one shell script is shown
 * verbatim, because its metacharacters are meant for the shell, not for display.
 * @param {string} command - Command line
 * @returns {string} Display string
 */
function buildDisplayCommand(command) {
  if (isShellInvocationWithArgs(command)) {
    return buildShellWithArgsCmdArgs(command).map(quoteForDisplay).join(' ');
  }
  const words = splitShellWords(command);
  if (!words || buildCommandString(words) !== command) {
    return command;
  }
  return words.map(quoteForDisplay).join(' ');
}

/** First word of a command line, used for failure reports and log headers. */
function getCommandName(command) {
  const parts = toShellWords(command);
  return parts.length > 0 ? parts[0] : '';
}

module.exports = {
  SHELL_NAMES,
  quoteShellArg,
  buildCommandString,
  splitShellWords,
  isInteractiveShellCommand,
  isShellInvocationWithArgs,
  buildShellWithArgsCmdArgs,
  buildDisplayCommand,
  getCommandName,
};
