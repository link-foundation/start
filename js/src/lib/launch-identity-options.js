/**
 * Launch options about the identity of a new execution:
 *   --append-attempt    run as the next attempt of the tracked execution named
 *                       by --session-id instead of being refused (issue #229)
 *   --continues <id>    record that this execution continues an earlier one,
 *                       which `--status` and `--upload-log` follow (issue #231)
 *
 * Both only apply when a command is launched, not to the query modes.
 */
const { activeQueryModes } = require('./args-parser-queries');

function createLaunchIdentityOptionDefaults() {
  return {
    appendAttempt: false,
    continues: null,
  };
}

/**
 * Parse one launch identity option.
 * @param {string[]} args - Arguments array
 * @param {number} index - Current index
 * @param {object} options - Options object to populate
 * @returns {number} Number of arguments consumed (0 if not recognized)
 */
function parse(args, index, options) {
  const arg = args[index];
  if (arg === '--append-attempt') {
    options.appendAttempt = true;
    return 1;
  }
  if (arg === '--continues') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.continues = args[index + 1];
      return 2;
    }
    throw new Error(
      'Option --continues requires a UUID or session name argument'
    );
  }
  if (arg.startsWith('--continues=')) {
    const value = arg.slice('--continues='.length);
    if (!value) {
      throw new Error(
        'Option --continues requires a UUID or session name argument'
      );
    }
    options.continues = value;
    return 1;
  }
  return 0;
}

/**
 * Validate the launch identity options.
 * @param {object} options - Parsed wrapper options
 * @throws {Error} When the combination is not supported
 */
function validate(options) {
  const used = [
    ...(options.appendAttempt ? ['--append-attempt'] : []),
    ...(options.continues !== null && options.continues !== undefined
      ? ['--continues']
      : []),
  ];
  if (used.length === 0) {
    return;
  }
  if (activeQueryModes(options).length > 0) {
    throw new Error(`${used[0]} option is only valid when launching a command`);
  }
  if (options.appendAttempt && !options.sessionId) {
    throw new Error('--append-attempt option requires --session-id <uuid>');
  }
}

module.exports = {
  createLaunchIdentityOptionDefaults,
  parse,
  validate,
};
