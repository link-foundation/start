/**
 * Query and control option parsing for the start-command wrapper.
 *
 * These options never launch a new command from scratch: they address an
 * already tracked execution by UUID or session name. They are kept in their own
 * module so `args-parser.js` stays focused on the launch options.
 *
 * Query modes:   --status, --list [--running]
 * Control modes: --upload-log, --stop, --terminate, --attach [--read-only],
 *                --resume [-- <command>], --resume-all, --cleanup
 */

/**
 * Valid output formats for --status/--list and the machine-readable
 * --resume/--resume-all summaries.
 */
const VALID_OUTPUT_FORMATS = ['links-notation', 'json', 'text'];

/**
 * Default values for every query/control option.
 * @returns {object} Fresh defaults (never share the same object between parses)
 */
function createQueryOptionDefaults() {
  return {
    status: null, // UUID/session name to show status for
    list: false, // List all tracked execution records
    running: false, // Restrict --list to executions that are still running
    uploadLog: null, // UUID/session name whose stored log should be uploaded
    outputFormat: null, // Output format (links-notation, json, text)
    stop: null, // UUID/session name to stop gracefully
    terminate: null, // UUID/session name to terminate immediately
    attach: null, // UUID/session name whose terminal should be attached
    readOnly: false, // Follow --attach output without forwarding stdin
    resume: null, // UUID/session name to resume (optionally with a new command)
    resumeAll: false, // Re-attach/resume every execution still marked running
    cleanup: false, // Clean up stale "executing" records
    cleanupDryRun: false, // Show what would be cleaned without cleaning
  };
}

/**
 * Options that take a `<uuid-or-session-name>` argument, mapped to the wrapper
 * option they populate.
 */
const IDENTIFIER_OPTIONS = {
  '--status': 'status',
  '--upload-log': 'uploadLog',
  '--stop': 'stop',
  '--terminate': 'terminate',
  '--attach': 'attach',
  '--resume': 'resume',
};

/**
 * Boolean flags with no argument.
 */
const FLAG_OPTIONS = {
  '--list': (options) => {
    options.list = true;
  },
  '--running': (options) => {
    options.running = true;
  },
  '--read-only': (options) => {
    options.readOnly = true;
  },
  '--resume-all': (options) => {
    options.resumeAll = true;
  },
  '--cleanup': (options) => {
    options.cleanup = true;
  },
  '--cleanup-dry-run': (options) => {
    options.cleanup = true;
    options.cleanupDryRun = true;
  },
};

function hasValue(value) {
  return value !== null && value !== undefined;
}

/**
 * Parse a single query/control option.
 * @param {string[]} args - Arguments array
 * @param {number} index - Current index
 * @param {object} options - Options object to populate
 * @returns {number} Number of arguments consumed (0 if not recognized)
 */
function parseQueryOption(args, index, options) {
  const arg = args[index];

  const flag = FLAG_OPTIONS[arg];
  if (flag) {
    flag(options);
    return 1;
  }

  const identifierKey = IDENTIFIER_OPTIONS[arg];
  if (identifierKey) {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options[identifierKey] = args[index + 1];
      return 2;
    }
    throw new Error(`Option ${arg} requires a UUID or session name argument`);
  }

  for (const [name, key] of Object.entries(IDENTIFIER_OPTIONS)) {
    const prefix = `${name}=`;
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      if (!value) {
        throw new Error(
          `Option ${name} requires a UUID or session name argument`
        );
      }
      options[key] = value;
      return 1;
    }
  }

  // --output-format <format>
  if (arg === '--output-format') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.outputFormat = args[index + 1].toLowerCase();
      return 2;
    }
    throw new Error(`Option ${arg} requires a format argument`);
  }

  // --output-format=<value>
  if (arg.startsWith('--output-format=')) {
    options.outputFormat = arg.split('=')[1].toLowerCase();
    return 1;
  }

  return 0;
}

/**
 * Modes that address one stored execution and therefore cannot be combined.
 * @param {object} options - Parsed wrapper options
 * @returns {string[]} Names of the modes that are active
 */
function activeQueryModes(options) {
  const modes = [];
  if (hasValue(options.status)) {
    modes.push('--status');
  }
  if (options.list) {
    modes.push('--list');
  }
  if (hasValue(options.uploadLog)) {
    modes.push('--upload-log');
  }
  if (hasValue(options.stop)) {
    modes.push('--stop');
  }
  if (hasValue(options.terminate)) {
    modes.push('--terminate');
  }
  if (hasValue(options.attach)) {
    modes.push('--attach');
  }
  if (hasValue(options.resume)) {
    modes.push('--resume');
  }
  if (options.resumeAll) {
    modes.push('--resume-all');
  }
  if (options.cleanup) {
    modes.push('--cleanup');
  }
  return modes;
}

/**
 * Formats are only meaningful for modes that print a machine-readable report.
 */
const OUTPUT_FORMAT_MODES = ['--status', '--list', '--resume', '--resume-all'];

/**
 * Validate query/control options.
 * @param {object} options - Parsed wrapper options
 * @throws {Error} When the combination is not supported
 */
function validateQueryOptions(options) {
  if (hasValue(options.outputFormat)) {
    if (!VALID_OUTPUT_FORMATS.includes(options.outputFormat)) {
      throw new Error(
        `Invalid output format: "${options.outputFormat}". Valid options are: ${VALID_OUTPUT_FORMATS.join(', ')}`
      );
    }
  }

  const modes = activeQueryModes(options);

  if (modes.length > 1) {
    throw new Error(
      'Cannot combine --status, --list, --upload-log, --stop, --terminate, --attach, --resume, --resume-all, or --cleanup in the same invocation'
    );
  }

  if (
    hasValue(options.outputFormat) &&
    !modes.some((mode) => OUTPUT_FORMAT_MODES.includes(mode))
  ) {
    throw new Error(
      '--output-format option is only valid with --status, --list, --resume, or --resume-all'
    );
  }

  if (options.running && !options.list) {
    throw new Error('--running option is only valid with --list');
  }

  if (options.readOnly && !hasValue(options.attach)) {
    throw new Error('--read-only option is only valid with --attach');
  }
}

module.exports = {
  VALID_OUTPUT_FORMATS,
  activeQueryModes,
  createQueryOptionDefaults,
  parseQueryOption,
  validateQueryOptions,
};
