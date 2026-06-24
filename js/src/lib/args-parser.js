/**
 * Argument Parser for start-command wrapper options
 *
 * Supports two syntax patterns:
 * 1. $ [wrapper-options] -- [command-options]
 * 2. $ [wrapper-options] command [command-options]
 *
 * Wrapper Options:
 * --isolated, --isolation, -i <backend> Run in isolated environment (screen, tmux, docker, ssh)
 * --attached, -a                   Run in attached mode (foreground)
 * --detached, -d                   Run in detached mode (background)
 * --session, -s <name>             Session name for isolation
 * --image <image>                  Docker image (optional, defaults to OS-matched image)
 * --volume, -v <host:container[:mode]> Docker bind mount/volume (repeatable, docker only)
 * --mount <mount-spec>             Docker --mount spec (repeatable, docker only)
 * --env, -e <KEY=VALUE>            Environment variable for docker container (repeatable, docker only)
 * --privileged                     Run docker container in privileged mode (docker only)
 * --endpoint <endpoint>            SSH endpoint (required for ssh isolation, e.g., user@host)
 * --isolated-user, -u [username]   Create isolated user with same permissions (auto-generated name if not specified)
 * --keep-user                      Keep isolated user after command completes (don't delete)
 * --keep-alive, -k                 Keep isolation environment alive after command exits
 * --auto-remove-docker-container   Always remove docker container after exit (compatibility alias)
 * --always-cleanup-container       Always remove docker container after exit (default)
 * --keep-container                 Keep docker container filesystem after exit
 * --keep-container-on-fail         Remove successful docker containers, keep failed ones
 * --shell <shell>                  Shell to use in isolation environments: auto, bash, zsh, sh (default: auto)
 * --use-command-stream             Use command-stream library for command execution (experimental)
 * --verbose                        Enable verbose/debug output (sets START_VERBOSE=1)
 * --status <uuid>                  Show status of a previous command execution by UUID
 * --list                           List all tracked command executions
 * --upload-log <uuid-or-session>    Upload the stored log for a tracked execution
 * --output-format <format>         Output format for status/list (links-notation, json, text)
 * --stop <uuid-or-session-name>     Ask a detached execution to stop gracefully
 * --terminate <uuid-or-session-name> Terminate a detached execution immediately
 * --cleanup                        Clean up stale "executing" records (processes that crashed or were killed)
 * --cleanup-dry-run                Show stale records that would be cleaned up (without actually cleaning)
 */

const { getDefaultDockerImage } = require('./docker-utils');
const { parseSequence, isSequence } = require('./sequence-parser');

// Debug mode from environment
const DEBUG =
  process.env.START_DEBUG === '1' || process.env.START_DEBUG === 'true';

/**
 * Valid isolation environments
 */
const VALID_BACKENDS = ['screen', 'tmux', 'docker', 'ssh'];

/**
 * Valid shell options for --shell
 */
const VALID_SHELLS = ['auto', 'bash', 'zsh', 'sh'];

/**
 * Maximum depth for isolation stacking
 */
const MAX_ISOLATION_DEPTH = 7;

/**
 * Valid output formats for --status
 */
const VALID_OUTPUT_FORMATS = ['links-notation', 'json', 'text'];

function hasValue(value) {
  return value !== null && value !== undefined;
}

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
 * Parse --isolated value, handling both single values and sequences
 * @param {string} value - Isolation value (e.g., "docker" or "screen ssh docker")
 * @param {object} options - Options object to populate
 */
function parseIsolatedValue(value, options) {
  if (isSequence(value)) {
    // Multi-value sequence (e.g., "screen ssh docker")
    const backends = parseSequence(value).map((v) =>
      v ? v.toLowerCase() : null
    );
    options.isolatedStack = backends;
    options.isolated = backends[0]; // Current level
  } else {
    // Single value (backward compatible)
    const backend = value.toLowerCase();
    options.isolated = backend;
    options.isolatedStack = [backend];
  }
}

/**
 * Parse --image value, handling both single values and sequences
 * @param {string} value - Image value (e.g., "ubuntu:22.04" or "_ _ ubuntu:22.04")
 * @param {object} options - Options object to populate
 */
function parseImageValue(value, options) {
  if (isSequence(value)) {
    // Multi-value sequence with placeholders
    const images = parseSequence(value);
    options.imageStack = images;
    options.image = images[0]; // Current level
  } else {
    // Single value - will be distributed later during validation
    options.image = value;
    options.imageStack = null; // Will be populated during validation
  }
}

/**
 * Parse --endpoint value, handling both single values and sequences
 * @param {string} value - Endpoint value (e.g., "user@host" or "_ user@host1 _ user@host2")
 * @param {object} options - Options object to populate
 */
function parseEndpointValue(value, options) {
  if (isSequence(value)) {
    // Multi-value sequence with placeholders
    const endpoints = parseSequence(value);
    options.endpointStack = endpoints;
    options.endpoint = endpoints[0]; // Current level
  } else {
    // Single value - will be distributed later during validation
    options.endpoint = value;
    options.endpointStack = null; // Will be populated during validation
  }
}

/**
 * Parse command line arguments into wrapper options and command
 * @param {string[]} args - Array of command line arguments
 * @returns {{wrapperOptions: object, command: string, rawCommand: string[]}}
 */
function parseArgs(args) {
  const wrapperOptions = {
    isolated: null, // Isolation environment: screen, tmux, docker, ssh (current level)
    isolatedStack: null, // Full isolation stack for multi-level isolation (e.g., ["screen", "ssh", "docker"])
    attached: false, // Run in attached mode
    detached: false, // Run in detached mode
    session: null, // Session name (current level)
    sessionStack: null, // Session names for each level
    sessionId: null, // Session ID (UUID) for tracking - auto-generated if not provided
    image: null, // Docker image (current level)
    imageStack: null, // Docker images for each level (with nulls for non-docker levels)
    volumes: [], // Docker bind mounts/volumes (-v/--volume), applied to docker levels
    mounts: [], // Docker --mount specs, applied to docker levels
    env: [], // Docker environment variables (-e/--env, KEY=VALUE), applied to docker levels
    privileged: false, // Run docker container in privileged mode
    endpoint: null, // SSH endpoint (current level, e.g., user@host)
    endpointStack: null, // SSH endpoints for each level (with nulls for non-ssh levels)
    user: false, // Create isolated user
    userName: null, // Optional custom username for isolated user
    keepUser: false, // Keep isolated user after command completes (don't delete)
    keepAlive: false, // Keep environment alive after command exits
    autoRemoveDockerContainer: false, // Always remove docker container after exit (compatibility alias)
    alwaysCleanupContainer: false, // Explicitly request default always-cleanup docker policy
    keepContainer: false, // Keep docker container filesystem after exit
    keepContainerOnFail: false, // Keep docker container filesystem only when command fails
    shell: 'auto', // Shell to use in isolation environments: auto, bash, zsh, sh
    useCommandStream: false, // Use command-stream library for command execution
    status: null, // UUID to show status for
    list: false, // List all tracked execution records
    uploadLog: null, // UUID/session name whose stored log should be uploaded
    outputFormat: null, // Output format for status/list (links-notation, json, text)
    stop: null, // UUID/session name to stop gracefully
    terminate: null, // UUID/session name to terminate immediately
    cleanup: false, // Clean up stale "executing" records
    cleanupDryRun: false, // Show what would be cleaned without actually cleaning
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
          throw new Error(`Unknown wrapper option: ${arg}`);
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
      if (args[i].startsWith('-')) {
        throw new Error(`Unknown wrapper option: ${args[i]}`);
      }
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

  // --isolated, --isolation, or -i
  if (arg === '--isolated' || arg === '--isolation' || arg === '-i') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      const value = args[index + 1];
      parseIsolatedValue(value, options);
      return 2;
    } else {
      throw new Error(
        `Option ${arg} requires a backend argument (screen, tmux, docker, ssh)`
      );
    }
  }

  // --isolated=<value> or --isolation=<value>
  if (arg.startsWith('--isolated=') || arg.startsWith('--isolation=')) {
    const value = arg.split('=')[1];
    parseIsolatedValue(value, options);
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

  // --image (for docker) - supports sequence for stacked isolation
  if (arg === '--image') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      const value = args[index + 1];
      parseImageValue(value, options);
      return 2;
    } else {
      throw new Error(`Option ${arg} requires an image name argument`);
    }
  }

  // --image=<value>
  if (arg.startsWith('--image=')) {
    const value = arg.split('=')[1];
    parseImageValue(value, options);
    return 1;
  }

  // --volume or -v (for docker) - repeatable bind mount / volume
  if (arg === '--volume' || arg === '-v') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.volumes.push(args[index + 1]);
      return 2;
    } else {
      throw new Error(
        `Option ${arg} requires a volume argument (host:container[:mode])`
      );
    }
  }

  // --volume=<value> or -v=<value>
  if (arg.startsWith('--volume=') || arg.startsWith('-v=')) {
    options.volumes.push(arg.slice(arg.indexOf('=') + 1));
    return 1;
  }

  // --mount (for docker) - repeatable mount spec
  if (arg === '--mount') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.mounts.push(args[index + 1]);
      return 2;
    } else {
      throw new Error(`Option ${arg} requires a mount spec argument`);
    }
  }

  // --mount=<value>
  if (arg.startsWith('--mount=')) {
    options.mounts.push(arg.slice('--mount='.length));
    return 1;
  }

  // --env or -e (for docker) - repeatable environment variable
  if (arg === '--env' || arg === '-e') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.env.push(args[index + 1]);
      return 2;
    } else {
      throw new Error(`Option ${arg} requires a KEY=VALUE argument`);
    }
  }

  // --env=<value> or -e=<value>
  if (arg.startsWith('--env=') || arg.startsWith('-e=')) {
    options.env.push(arg.slice(arg.indexOf('=') + 1));
    return 1;
  }

  // --privileged (for docker)
  if (arg === '--privileged') {
    options.privileged = true;
    return 1;
  }

  // --endpoint (for ssh) - supports sequence for stacked isolation
  if (arg === '--endpoint') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      const value = args[index + 1];
      parseEndpointValue(value, options);
      return 2;
    } else {
      throw new Error(`Option ${arg} requires an endpoint argument`);
    }
  }

  // --endpoint=<value>
  if (arg.startsWith('--endpoint=')) {
    const value = arg.split('=')[1];
    parseEndpointValue(value, options);
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

  // --always-cleanup-container
  if (arg === '--always-cleanup-container') {
    options.alwaysCleanupContainer = true;
    return 1;
  }

  // --keep-container
  if (arg === '--keep-container') {
    options.keepContainer = true;
    return 1;
  }

  // --keep-container-on-fail
  if (arg === '--keep-container-on-fail') {
    options.keepContainerOnFail = true;
    return 1;
  }

  // --shell <shell>
  if (arg === '--shell') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.shell = args[index + 1].toLowerCase();
      return 2;
    } else {
      throw new Error(
        `Option ${arg} requires a shell argument (auto, bash, zsh, sh)`
      );
    }
  }

  // --shell=<value>
  if (arg.startsWith('--shell=')) {
    options.shell = arg.split('=')[1].toLowerCase();
    return 1;
  }

  // --use-command-stream
  if (arg === '--use-command-stream') {
    options.useCommandStream = true;
    return 1;
  }

  // --verbose (enable verbose/debug output, sets START_VERBOSE env var)
  if (arg === '--verbose') {
    process.env.START_VERBOSE = '1';
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

  // --status <uuid-or-session-name>
  if (arg === '--status') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.status = args[index + 1];
      return 2;
    } else {
      throw new Error(`Option ${arg} requires a UUID or session name argument`);
    }
  }

  // --status=<value>
  if (arg.startsWith('--status=')) {
    const value = arg.slice('--status='.length);
    if (!value) {
      throw new Error(
        `Option --status requires a UUID or session name argument`
      );
    }
    options.status = value;
    return 1;
  }

  // --upload-log <uuid-or-session-name>
  if (arg === '--upload-log') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.uploadLog = args[index + 1];
      return 2;
    } else {
      throw new Error(`Option ${arg} requires a UUID or session name argument`);
    }
  }

  // --upload-log=<value>
  if (arg.startsWith('--upload-log=')) {
    const value = arg.slice('--upload-log='.length);
    if (!value) {
      throw new Error(
        `Option --upload-log requires a UUID or session name argument`
      );
    }
    options.uploadLog = value;
    return 1;
  }

  // --stop <uuid-or-session-name>
  if (arg === '--stop') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.stop = args[index + 1];
      return 2;
    } else {
      throw new Error(`Option ${arg} requires a UUID or session name argument`);
    }
  }

  // --stop=<value>
  if (arg.startsWith('--stop=')) {
    const value = arg.slice('--stop='.length);
    if (!value) {
      throw new Error(`Option --stop requires a UUID or session name argument`);
    }
    options.stop = value;
    return 1;
  }

  // --terminate <uuid-or-session-name>
  if (arg === '--terminate') {
    if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      options.terminate = args[index + 1];
      return 2;
    } else {
      throw new Error(`Option ${arg} requires a UUID or session name argument`);
    }
  }

  // --terminate=<value>
  if (arg.startsWith('--terminate=')) {
    const value = arg.slice('--terminate='.length);
    if (!value) {
      throw new Error(
        `Option --terminate requires a UUID or session name argument`
      );
    }
    options.terminate = value;
    return 1;
  }

  // --list
  if (arg === '--list') {
    options.list = true;
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

  // --cleanup
  if (arg === '--cleanup') {
    options.cleanup = true;
    return 1;
  }

  // --cleanup-dry-run
  if (arg === '--cleanup-dry-run') {
    options.cleanup = true;
    options.cleanupDryRun = true;
    return 1;
  }

  // Not a recognized wrapper option
  return 0;
}

/**
 * Throw if docker runtime options (--volume, --mount, --env, --privileged)
 * are present but the isolation configuration does not include docker.
 * @param {object} options - Parsed options
 * @throws {Error} If a docker-only option is set without docker isolation
 */
function validateDockerRuntimeOptionsRequireDocker(options) {
  if (options.volumes && options.volumes.length > 0) {
    throw new Error(
      '--volume option is only valid when isolation stack includes docker'
    );
  }
  if (options.mounts && options.mounts.length > 0) {
    throw new Error(
      '--mount option is only valid when isolation stack includes docker'
    );
  }
  if (options.env && options.env.length > 0) {
    throw new Error(
      '--env option is only valid when isolation stack includes docker'
    );
  }
  if (options.privileged) {
    throw new Error(
      '--privileged option is only valid when isolation stack includes docker'
    );
  }
}

function validateDockerCleanupOptions(options, hasDocker) {
  const cleanupFlags = [
    ['--auto-remove-docker-container', options.autoRemoveDockerContainer],
    ['--always-cleanup-container', options.alwaysCleanupContainer],
    ['--keep-container', options.keepContainer],
    ['--keep-container-on-fail', options.keepContainerOnFail],
  ];

  for (const [flag, enabled] of cleanupFlags) {
    if (enabled && !hasDocker) {
      throw new Error(
        `${flag} option is only valid when isolation stack includes docker`
      );
    }
  }

  const selectedPolicies = [
    options.autoRemoveDockerContainer || options.alwaysCleanupContainer,
    options.keepContainer,
    options.keepContainerOnFail,
  ].filter(Boolean).length;

  if (selectedPolicies > 1) {
    throw new Error(
      'Cannot combine docker container cleanup policies. Choose only one of --always-cleanup-container, --keep-container, or --keep-container-on-fail.'
    );
  }
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

  // Validate isolation environment (with stacking support)
  if (options.isolated !== null) {
    const stack = options.isolatedStack || [options.isolated];
    const stackDepth = stack.length;

    // Check depth limit
    if (stackDepth > MAX_ISOLATION_DEPTH) {
      throw new Error(
        `Isolation stack too deep: ${stackDepth} levels (max: ${MAX_ISOLATION_DEPTH})`
      );
    }

    // Validate each backend in the stack
    for (const backend of stack) {
      if (backend && !VALID_BACKENDS.includes(backend)) {
        throw new Error(
          `Invalid isolation environment: "${backend}". Valid options are: ${VALID_BACKENDS.join(', ')}`
        );
      }
    }

    // Distribute single option values across stack if needed
    if (options.image && !options.imageStack) {
      // Single image value - replicate for all levels
      options.imageStack = Array(stackDepth).fill(options.image);
    }

    if (options.endpoint && !options.endpointStack) {
      // Single endpoint value - replicate for all levels
      options.endpointStack = Array(stackDepth).fill(options.endpoint);
    }

    // Validate stack lengths match
    if (options.imageStack && options.imageStack.length !== stackDepth) {
      throw new Error(
        `--image has ${options.imageStack.length} value(s) but isolation stack has ${stackDepth} level(s). ` +
          `Use underscores (_) as placeholders for levels that don't need this option.`
      );
    }

    if (options.endpointStack && options.endpointStack.length !== stackDepth) {
      throw new Error(
        `--endpoint has ${options.endpointStack.length} value(s) but isolation stack has ${stackDepth} level(s). ` +
          `Use underscores (_) as placeholders for levels that don't need this option.`
      );
    }

    // Validate each level has required options
    for (let i = 0; i < stackDepth; i++) {
      const backend = stack[i];

      // Docker uses --image or defaults to OS-matched image
      if (backend === 'docker') {
        const image = options.imageStack
          ? options.imageStack[i]
          : options.image;
        if (!image) {
          // Apply default image
          if (!options.imageStack) {
            options.imageStack = Array(stackDepth).fill(null);
          }
          options.imageStack[i] = getDefaultDockerImage();
        }
      }

      // SSH requires --endpoint
      if (backend === 'ssh') {
        const endpoint = options.endpointStack
          ? options.endpointStack[i]
          : options.endpoint;
        if (!endpoint) {
          throw new Error(
            `SSH isolation at level ${i + 1} requires --endpoint option. ` +
              `Use a sequence like --endpoint "_ user@host _" to specify endpoints for specific levels.`
          );
        }
      }
    }

    // Set current level values for backward compatibility
    options.image = options.imageStack ? options.imageStack[0] : options.image;
    options.endpoint = options.endpointStack
      ? options.endpointStack[0]
      : options.endpoint;

    // Validate option compatibility with current level (for backward compatible error messages)
    const currentBackend = stack[0];

    // Image is only valid if stack contains docker
    if (options.image && !stack.includes('docker')) {
      throw new Error(
        '--image option is only valid when isolation stack includes docker'
      );
    }

    // Endpoint is only valid if stack contains ssh
    if (options.endpoint && !stack.includes('ssh')) {
      throw new Error(
        '--endpoint option is only valid when isolation stack includes ssh'
      );
    }

    validateDockerCleanupOptions(options, stack.includes('docker'));

    // Docker runtime options (--volume, --mount, --env, --privileged) require docker
    if (!stack.includes('docker')) {
      validateDockerRuntimeOptionsRequireDocker(options);
    }

    // User isolation is not supported with Docker as first level
    if (options.user && currentBackend === 'docker') {
      throw new Error(
        '--isolated-user is not supported with Docker as the first isolation level. ' +
          'Docker uses its own user namespace for isolation.'
      );
    }
  } else {
    // Validate options that require isolation when no isolation is specified
    validateDockerCleanupOptions(options, false);
    if (options.image) {
      throw new Error(
        '--image option is only valid when isolation stack includes docker'
      );
    }
    if (options.endpoint) {
      throw new Error(
        '--endpoint option is only valid when isolation stack includes ssh'
      );
    }
    validateDockerRuntimeOptionsRequireDocker(options);
  }

  // Session name is only valid with isolation
  if (options.session && !options.isolated) {
    throw new Error('--session option is only valid with --isolated');
  }

  // Keep-alive is only valid with isolation
  if (options.keepAlive && !options.isolated) {
    throw new Error('--keep-alive option is only valid with --isolated');
  }

  // User isolation validation
  if (options.user) {
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
  if (hasValue(options.outputFormat)) {
    if (!VALID_OUTPUT_FORMATS.includes(options.outputFormat)) {
      throw new Error(
        `Invalid output format: "${options.outputFormat}". Valid options are: ${VALID_OUTPUT_FORMATS.join(', ')}`
      );
    }
  }

  // Query/control modes are mutually exclusive
  const queryModes = [
    hasValue(options.status),
    options.list,
    hasValue(options.uploadLog),
    hasValue(options.stop),
    hasValue(options.terminate),
    options.cleanup,
  ].filter(Boolean).length;

  if (queryModes > 1) {
    throw new Error(
      'Cannot combine --status, --list, --upload-log, --stop, --terminate, or --cleanup in the same invocation'
    );
  }

  // Output format is only valid with read-only query modes
  if (options.outputFormat && !options.status && !options.list) {
    throw new Error(
      '--output-format option is only valid with --status or --list'
    );
  }

  // Validate shell option
  if (options.shell !== null && options.shell !== undefined) {
    if (!VALID_SHELLS.includes(options.shell)) {
      throw new Error(
        `Invalid shell: "${options.shell}". Valid options are: ${VALID_SHELLS.join(', ')}`
      );
    }
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

/**
 * Check if isolation stack has multiple levels
 * @param {object} options - Parsed wrapper options
 * @returns {boolean} True if multiple isolation levels
 */
function hasStackedIsolation(options) {
  return options.isolatedStack && options.isolatedStack.length > 1;
}

module.exports = {
  parseArgs,
  validateOptions,
  generateSessionName,
  hasIsolation,
  hasStackedIsolation,
  getEffectiveMode,
  isValidUUID,
  generateUUID,
  VALID_BACKENDS,
  VALID_OUTPUT_FORMATS,
  VALID_SHELLS,
  MAX_ISOLATION_DEPTH,
};
