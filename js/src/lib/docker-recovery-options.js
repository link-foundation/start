/**
 * Parse and validate the launch-time recovery options (issue #176):
 *   --on-kill-resume <N>        resume up to N times when the main process is
 *                               killed (exit 137 / OOMKilled)
 *   --recovery-command <cmd>    command to run in the same container on resume
 *                               (without it, the original command is re-run)
 */

function parseOnKillResumeValue(value) {
  const text = String(value).trim();
  const count = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(count) || count < 1) {
    throw new Error(
      `Invalid --on-kill-resume value: "${value}". Expected a positive integer.`
    );
  }
  return count;
}

function parseDockerRecoveryOption(args, index, options) {
  const arg = args[index];
  if (arg === '--on-kill-resume' || arg === '--recovery-command') {
    if (index + 1 >= args.length || args[index + 1].startsWith('-')) {
      const value = arg === '--on-kill-resume' ? 'count' : 'command';
      throw new Error(`Option ${arg} requires a ${value} argument`);
    }
    if (arg === '--on-kill-resume') {
      options.onKillResume = parseOnKillResumeValue(args[index + 1]);
    } else {
      options.recoveryCommand = args[index + 1];
    }
    return 2;
  }
  if (arg.startsWith('--on-kill-resume=')) {
    options.onKillResume = parseOnKillResumeValue(
      arg.slice('--on-kill-resume='.length)
    );
    return 1;
  }
  if (arg.startsWith('--recovery-command=')) {
    options.recoveryCommand = arg.slice('--recovery-command='.length);
    return 1;
  }
  return 0;
}

/**
 * Recovery is driven by the detached docker completion watcher, so it needs a
 * detached session whose only isolation level is docker. A recovery command on
 * its own implies one attempt.
 * @param {object} options - Parsed options
 * @throws {Error} If the recovery options are used where they cannot work
 */
function validateDockerRecoveryOptions(options) {
  if (
    options.recoveryCommand !== null &&
    options.recoveryCommand !== undefined
  ) {
    if (String(options.recoveryCommand).trim() === '') {
      throw new Error('--recovery-command requires a non-empty command');
    }
    options.onKillResume ??= 1;
  }
  if (!options.onKillResume) {
    return;
  }
  const flag = options.recoveryCommand
    ? '--recovery-command'
    : '--on-kill-resume';
  const stack = options.isolatedStack || [options.isolated];
  if (!options.isolated || stack.length !== 1 || stack[0] !== 'docker') {
    throw new Error(
      `${flag} option is only valid with --isolated docker as the only isolation level`
    );
  }
  if (!options.detached) {
    throw new Error(`${flag} option requires --detached`);
  }
}

module.exports = {
  parse: parseDockerRecoveryOption,
  validate: validateDockerRecoveryOptions,
};
