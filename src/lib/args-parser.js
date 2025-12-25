/**
 * Argument Parser for start-command wrapper options
 *
 * Supports two syntax patterns:
 * 1. $ [wrapper-options] -- [command-options]
 * 2. $ [wrapper-options] command [command-options]
 *
 * Wrapper Options:
 * --isolated, -i <backend>         Run in isolated environment (screen, tmux, docker)
 * --attached, -a                   Run in attached mode (foreground)
 * --detached, -d                   Run in detached mode (background)
 * --session, -s <name>             Session name for isolation
 * --image <image>                  Docker image (required for docker isolation)
 * --user <username>                Run command as specified user
 * --keep-alive, -k                 Keep isolation environment alive after command exits
 * --auto-remove-docker-container   Automatically remove docker container after exit (disabled by default)
 */

// Debug mode from environment
const DEBUG =
  process.env.START_DEBUG === '1' || process.env.START_DEBUG === 'true';

/**
 * Valid isolation backends
 */
const VALID_BACKENDS = ['screen', 'tmux', 'docker'];

/**
 * Parse command line arguments into wrapper options and command
 * @param {string[]} args - Array of command line arguments
 * @returns {{wrapperOptions: object, command: string, rawCommand: string[]}}
 */
function parseArgs(args) {
  const wrapperOptions = {
    isolated: null, // Isolation backend: screen, tmux, docker
    attached: false, // Run in attached mode
    detached: false, // Run in detached mode
    session: null, // Session name
    image: null, // Docker image
    user: null, // User to run command as
    keepAlive: false, // Keep environment alive after command exits
    autoRemoveDockerContainer: false, // Auto-remove docker container after exit
  };

  let commandArgs = [];
  let i = 0;

  // Find the separator '--' or detect where command starts
  const separatorIndex = args.indexOf('--');

  if (separatorIndex !== -1) {
    // Pattern 1: explicit separator
    const wrapperArgs = args.slice(0, separatorIndex);
    commandArgs = args.slice(separatorIndex + 1);

    parseWrapperArgs(wrapperArgs, wrapperOptions);
  } else {
    // Pattern 2: parse until we hit a non-option argument
    while (i < args.length) {
      const arg = args[i];

      if (arg.startsWith('-')) {
        const consumed = parseOption(args, i, wrapperOptions);
        if (consumed === 0) {
          // Unknown option, treat rest as command
          commandArgs = args.slice(i);
          break;
        }
        i += consumed;
      } else {
        // Non-option argument, rest is command
        commandArgs = args.slice(i);
        break;
      }
    }
  }

  // Validate options
  validateOptions(wrapperOptions);

  return {
    wrapperOptions,
    command: commandArgs.join(' '),
    rawCommand: commandArgs,
  };
}

/**
 * Parse wrapper arguments
 * @param {string[]} args - Wrapper arguments
 * @param {object} options - Options object to populate
 */
function parseWrapperArgs(args, options) {
  let i = 0;
  while (i < args.length) {
    const consumed = parseOption(args, i, options);
    if (consumed === 0) {
      if (DEBUG) {
        console.warn(`Unknown wrapper option: ${args[i]}`);
      }
      i++;
    } else {
      i += consumed;
    }
  }
}

/**
 * Parse a single option from args array
 * @param {string[]} args - Arguments array
 * @param {number} index - Current index
 * @param {object} options - Options object to populate
 * @returns {number} Number of arguments consumed (0 if not recognized)
 */
function parseOption(args, index, options) {
  const arg = args[index];

  // --isolated or -i
  if (arg === '--isolated' || arg === '-i') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.isolated = args[index + 1].toLowerCase();
      return 2;
    } else {
      throw new Error(
        `Option ${arg} requires a backend argument (screen, tmux, docker)`
      );
    }
  }

  // --isolated=<value>
  if (arg.startsWith('--isolated=')) {
    options.isolated = arg.split('=')[1].toLowerCase();
    return 1;
  }

  // --attached or -a
  if (arg === '--attached' || arg === '-a') {
    options.attached = true;
    return 1;
  }

  // --detached or -d
  if (arg === '--detached' || arg === '-d') {
    options.detached = true;
    return 1;
  }

  // --session or -s
  if (arg === '--session' || arg === '-s') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.session = args[index + 1];
      return 2;
    } else {
      throw new Error(`Option ${arg} requires a session name argument`);
    }
  }

  // --session=<value>
  if (arg.startsWith('--session=')) {
    options.session = arg.split('=')[1];
    return 1;
  }

  // --image (for docker)
  if (arg === '--image') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.image = args[index + 1];
      return 2;
    } else {
      throw new Error(`Option ${arg} requires an image name argument`);
    }
  }

  // --image=<value>
  if (arg.startsWith('--image=')) {
    options.image = arg.split('=')[1];
    return 1;
  }

  // --user
  if (arg === '--user') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.user = args[index + 1];
      return 2;
    } else {
      throw new Error(`Option ${arg} requires a username argument`);
    }
  }

  // --user=<value>
  if (arg.startsWith('--user=')) {
    options.user = arg.split('=')[1];
    return 1;
  }

  // --keep-alive or -k
  if (arg === '--keep-alive' || arg === '-k') {
    options.keepAlive = true;
    return 1;
  }

  // --auto-remove-docker-container
  if (arg === '--auto-remove-docker-container') {
    options.autoRemoveDockerContainer = true;
    return 1;
  }

  // Not a recognized wrapper option
  return 0;
}

/**
 * Validate parsed options
 * @param {object} options - Parsed options
 * @throws {Error} If options are invalid
 */
function validateOptions(options) {
  // Check attached and detached conflict
  if (options.attached && options.detached) {
    throw new Error(
      'Cannot use both --attached and --detached at the same time. Please choose only one mode.'
    );
  }

  // Validate isolation backend
  if (options.isolated !== null) {
    if (!VALID_BACKENDS.includes(options.isolated)) {
      throw new Error(
        `Invalid isolation backend: "${options.isolated}". Valid options are: ${VALID_BACKENDS.join(', ')}`
      );
    }

    // Docker requires --image
    if (options.isolated === 'docker' && !options.image) {
      throw new Error(
        'Docker isolation requires --image option to specify the container image'
      );
    }
  }

  // Session name is only valid with isolation
  if (options.session && !options.isolated) {
    throw new Error('--session option is only valid with --isolated');
  }

  // Image is only valid with docker
  if (options.image && options.isolated !== 'docker') {
    throw new Error('--image option is only valid with --isolated docker');
  }

  // User validation
  if (options.user) {
    // Validate username format (basic check) - allow colons for docker UID:GID format
    if (!/^[a-zA-Z0-9_:-]+$/.test(options.user)) {
      throw new Error(
        `Invalid username format: "${options.user}". Username should contain only letters, numbers, hyphens, underscores, and colons (for UID:GID).`
      );
    }
  }

  // Keep-alive is only valid with isolation
  if (options.keepAlive && !options.isolated) {
    throw new Error('--keep-alive option is only valid with --isolated');
  }

  // Auto-remove-docker-container is only valid with docker isolation
  if (options.autoRemoveDockerContainer && options.isolated !== 'docker') {
    throw new Error(
      '--auto-remove-docker-container option is only valid with --isolated docker'
    );
  }
}

/**
 * Generate a unique session name
 * @param {string} [prefix='start'] - Prefix for the session name
 * @returns {string} Generated session name
 */
function generateSessionName(prefix = 'start') {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Check if any isolation options are present
 * @param {object} options - Parsed wrapper options
 * @returns {boolean} True if isolation is requested
 */
function hasIsolation(options) {
  return options.isolated !== null;
}

/**
 * Get the effective mode for isolation
 * Multiplexers default to attached, docker defaults to attached
 * @param {object} options - Parsed wrapper options
 * @returns {'attached'|'detached'} The effective mode
 */
function getEffectiveMode(options) {
  if (options.detached) {
    return 'detached';
  }
  // Default to attached for all backends
  return 'attached';
}

module.exports = {
  parseArgs,
  validateOptions,
  generateSessionName,
  hasIsolation,
  getEffectiveMode,
  VALID_BACKENDS,
};
