/**
 * Argument Parser for start-command wrapper options
 *
 * Supports two syntax patterns:
 * 1. $ [wrapper-options] -- [command-options]
 * 2. $ [wrapper-options] command [command-options]
 *
 * Wrapper Options:
 * --isolated, -i <backend>         Run in isolated environment (screen, tmux, docker, ssh)
 * --attached, -a                   Run in attached mode (foreground)
 * --detached, -d                   Run in detached mode (background)
 * --session, -s <name>             Session name for isolation
 * --image <image>                  Docker image (required for docker isolation)
 * --endpoint <endpoint>            SSH endpoint (required for ssh isolation, e.g., user@host)
 * --isolated-user, -u [username]   Create isolated user with same permissions (auto-generated name if not specified)
 * --keep-user                      Keep isolated user after command completes (don't delete)
 * --keep-alive, -k                 Keep isolation environment alive after command exits
 * --auto-remove-docker-container   Automatically remove docker container after exit (disabled by default)
 * --use-command-stream             Use command-stream library for command execution (experimental)
 * --status <uuid>                  Show status of a previous command execution by UUID
 * --output-format <format>         Output format for status (links-notation, json, text)
 */

// Debug mode from environment
const DEBUG =
  process.env.START_DEBUG === '1' || process.env.START_DEBUG === 'true';

/**
 * Valid isolation backends
 */
const VALID_BACKENDS = ['screen', 'tmux', 'docker', 'ssh'];

/**
 * Valid output formats for --status
 */
const VALID_OUTPUT_FORMATS = ['links-notation', 'json', 'text'];

/**
 * UUID v4 regex pattern for validation
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Check if a string is a valid UUID v4
 * @param {string} str - String to validate
 * @returns {boolean} True if valid UUID v4
 */
function isValidUUID(str) {
  return UUID_REGEX.test(str);
}

/**
 * Generate a UUID v4
 * @returns {string} A new UUID v4 string
 */
function generateUUID() {
  // Try to use Node.js/Bun crypto module
  try {
    const crypto = require('crypto');
    return crypto.randomUUID();
  } catch {
    // Fallback for environments without crypto.randomUUID
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

/**
 * Parse command line arguments into wrapper options and command
 * @param {string[]} args - Array of command line arguments
 * @returns {{wrapperOptions: object, command: string, rawCommand: string[]}}
 */
function parseArgs(args) {
  const wrapperOptions = {
    isolated: null, // Isolation backend: screen, tmux, docker, ssh
    attached: false, // Run in attached mode
    detached: false, // Run in detached mode
    session: null, // Session name
    sessionId: null, // Session ID (UUID) for tracking - auto-generated if not provided
    image: null, // Docker image
    endpoint: null, // SSH endpoint (e.g., user@host)
    user: false, // Create isolated user
    userName: null, // Optional custom username for isolated user
    keepUser: false, // Keep isolated user after command completes (don't delete)
    keepAlive: false, // Keep environment alive after command exits
    autoRemoveDockerContainer: false, // Auto-remove docker container after exit
    useCommandStream: false, // Use command-stream library for command execution
    status: null, // UUID to show status for
    outputFormat: null, // Output format for status (links-notation, json, text)
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

  // --endpoint (for ssh)
  if (arg === '--endpoint') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.endpoint = args[index + 1];
      return 2;
    } else {
      throw new Error(`Option ${arg} requires an endpoint argument`);
    }
  }

  // --endpoint=<value>
  if (arg.startsWith('--endpoint=')) {
    options.endpoint = arg.split('=')[1];
    return 1;
  }

  // --isolated-user or -u [optional-username] - creates isolated user with same permissions
  if (arg === '--isolated-user' || arg === '-u') {
    options.user = true;
    // Check if next arg is an optional username (not starting with -)
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      // Check if next arg looks like a username (not a command)
      const nextArg = args[index + 1];
      // If next arg matches username format, consume it
      if (/^[a-zA-Z0-9_-]+$/.test(nextArg) && nextArg.length <= 32) {
        options.userName = nextArg;
        return 2;
      }
    }
    return 1;
  }

  // --isolated-user=<value>
  if (arg.startsWith('--isolated-user=')) {
    options.user = true;
    options.userName = arg.split('=')[1];
    return 1;
  }

  // --keep-user - keep isolated user after command completes
  if (arg === '--keep-user') {
    options.keepUser = true;
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

  // --use-command-stream
  if (arg === '--use-command-stream') {
    options.useCommandStream = true;
    return 1;
  }

  // --session-id or --session-name (alias) <uuid>
  if (arg === '--session-id' || arg === '--session-name') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.sessionId = args[index + 1];
      return 2;
    } else {
      throw new Error(`Option ${arg} requires a UUID argument`);
    }
  }

  // --session-id=<value> or --session-name=<value>
  if (arg.startsWith('--session-id=') || arg.startsWith('--session-name=')) {
    options.sessionId = arg.split('=')[1];
    return 1;
  }

  // --status <uuid>
  if (arg === '--status') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.status = args[index + 1];
      return 2;
    } else {
      throw new Error(`Option ${arg} requires a UUID argument`);
    }
  }

  // --status=<value>
  if (arg.startsWith('--status=')) {
    options.status = arg.split('=')[1];
    return 1;
  }

  // --output-format <format>
  if (arg === '--output-format') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.outputFormat = args[index + 1].toLowerCase();
      return 2;
    } else {
      throw new Error(`Option ${arg} requires a format argument`);
    }
  }

  // --output-format=<value>
  if (arg.startsWith('--output-format=')) {
    options.outputFormat = arg.split('=')[1].toLowerCase();
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

    // SSH requires --endpoint
    if (options.isolated === 'ssh' && !options.endpoint) {
      throw new Error(
        'SSH isolation requires --endpoint option to specify the remote server (e.g., user@host)'
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

  // Endpoint is only valid with ssh
  if (options.endpoint && options.isolated !== 'ssh') {
    throw new Error('--endpoint option is only valid with --isolated ssh');
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

  // User isolation validation
  if (options.user) {
    // User isolation is not supported with Docker (Docker has its own user mechanism)
    if (options.isolated === 'docker') {
      throw new Error(
        '--isolated-user is not supported with Docker isolation. Docker uses its own user namespace for isolation.'
      );
    }
    // Validate custom username if provided
    if (options.userName) {
      if (!/^[a-zA-Z0-9_-]+$/.test(options.userName)) {
        throw new Error(
          `Invalid username format for --isolated-user: "${options.userName}". Username should contain only letters, numbers, hyphens, and underscores.`
        );
      }
      if (options.userName.length > 32) {
        throw new Error(
          `Username too long for --isolated-user: "${options.userName}". Maximum length is 32 characters.`
        );
      }
    }
  }

  // Keep-user validation
  if (options.keepUser && !options.user) {
    throw new Error('--keep-user option is only valid with --isolated-user');
  }

  // Validate output format
  if (options.outputFormat !== null && options.outputFormat !== undefined) {
    if (!VALID_OUTPUT_FORMATS.includes(options.outputFormat)) {
      throw new Error(
        `Invalid output format: "${options.outputFormat}". Valid options are: ${VALID_OUTPUT_FORMATS.join(', ')}`
      );
    }
  }

  // Output format is only valid with --status
  if (options.outputFormat && !options.status) {
    throw new Error('--output-format option is only valid with --status');
  }

  // Validate session ID is a valid UUID if provided
  if (options.sessionId !== null && options.sessionId !== undefined) {
    if (!isValidUUID(options.sessionId)) {
      throw new Error(
        `Invalid session ID: "${options.sessionId}". Session ID must be a valid UUID v4.`
      );
    }
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
  isValidUUID,
  generateUUID,
  VALID_BACKENDS,
  VALID_OUTPUT_FORMATS,
};
