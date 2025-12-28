/**
 * Command-Stream Wrapper for start-command
 *
 * This module provides a bridge to the command-stream library, which uses ESM,
 * from the CommonJS-based start-command codebase.
 *
 * The command-stream library provides:
 * - Shell command execution with streaming support
 * - Synchronous and asynchronous execution modes
 * - Built-in virtual commands (echo, ls, pwd, cd, etc.)
 * - Real-time output capture
 */

// Debug mode from environment
const DEBUG =
  process.env.START_DEBUG === '1' || process.env.START_DEBUG === 'true';

// Cached command-stream module
let commandStream = null;

/**
 * Get the command-stream module (lazy-loaded)
 * @returns {Promise<object>} The command-stream module
 */
async function getCommandStream() {
  if (!commandStream) {
    commandStream = await import('command-stream');
  }
  return commandStream;
}

/**
 * Execute a shell command synchronously and return the result
 * Uses command-stream's $ function with .sync() for blocking execution.
 *
 * @param {string} command - The shell command to execute
 * @param {object} options - Options for command execution
 * @param {boolean} options.silent - If true, don't mirror output to console (default: true)
 * @param {boolean} options.captureOutput - If true, capture stdout/stderr (default: true)
 * @returns {Promise<{stdout: string, stderr: string, code: number}>} Command result
 */
async function execCommand(command, options = {}) {
  const { $ } = await getCommandStream();

  const silent = options.silent !== false;

  // Create a configured $ instance
  const $cmd = $({ mirror: !silent, capture: true });

  try {
    // Use sync() for synchronous execution
    const result = $cmd`${command}`.sync();

    return {
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
      code: result.code || 0,
    };
  } catch (err) {
    if (DEBUG) {
      console.log(`[DEBUG] execCommand error: ${err.message}`);
    }
    return {
      stdout: '',
      stderr: err.message || '',
      code: 1,
    };
  }
}

/**
 * Execute a shell command asynchronously and return the result
 *
 * @param {string} command - The shell command to execute
 * @param {object} options - Options for command execution
 * @param {boolean} options.silent - If true, don't mirror output to console (default: true)
 * @param {boolean} options.captureOutput - If true, capture stdout/stderr (default: true)
 * @returns {Promise<{stdout: string, stderr: string, code: number}>} Command result
 */
async function execCommandAsync(command, options = {}) {
  const { $ } = await getCommandStream();

  const silent = options.silent !== false;

  // Create a configured $ instance
  const $cmd = $({ mirror: !silent, capture: true });

  try {
    const result = await $cmd`${command}`;

    return {
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
      code: result.code || 0,
    };
  } catch (err) {
    if (DEBUG) {
      console.log(`[DEBUG] execCommandAsync error: ${err.message}`);
    }
    return {
      stdout: '',
      stderr: err.message || '',
      code: 1,
    };
  }
}

/**
 * Check if a command exists in the PATH
 *
 * @param {string} commandName - The command to check for
 * @returns {Promise<boolean>} True if the command exists
 */
async function commandExists(commandName) {
  const isWindows = process.platform === 'win32';
  const whichCmd = isWindows ? 'where' : 'which';

  const result = await execCommand(`${whichCmd} ${commandName}`);
  return result.code === 0;
}

/**
 * Get the path to a command
 *
 * @param {string} commandName - The command to find
 * @returns {Promise<string|null>} Path to the command or null if not found
 */
async function getCommandPath(commandName) {
  const isWindows = process.platform === 'win32';
  const whichCmd = isWindows ? 'where' : 'which';

  const result = await execCommand(`${whichCmd} ${commandName}`);
  if (result.code === 0 && result.stdout) {
    // On Windows, where returns multiple lines, take the first
    return result.stdout.split('\n')[0].trim();
  }
  return null;
}

/**
 * Get the version of a tool by running it with a version flag
 *
 * @param {string} toolName - Name of the tool
 * @param {string} versionFlag - Flag to get version (e.g., '--version', '-V')
 * @param {boolean} verbose - Whether to log verbose information
 * @returns {Promise<string|null>} Version string or null if not installed
 */
async function getToolVersion(toolName, versionFlag, verbose = false) {
  // First check if the tool exists
  const exists = await commandExists(toolName);
  if (!exists) {
    if (verbose) {
      console.log(`[verbose] ${toolName}: not found in PATH`);
    }
    return null;
  }

  // Get the version - command-stream handles the output capture
  const result = await execCommand(`${toolName} ${versionFlag}`);

  // Combine stdout and stderr since some tools output version to stderr
  const output = `${result.stdout}\n${result.stderr}`.trim();

  if (verbose) {
    console.log(
      `[verbose] ${toolName} ${versionFlag}: exit=${result.code}, output="${output.substring(0, 100)}"`
    );
  }

  if (!output) {
    return null;
  }

  // Return the first line of output
  const firstLine = output.split('\n')[0];
  return firstLine || null;
}

/**
 * Run a command with real-time output streaming
 * This returns a ProcessRunner that can be used for advanced control.
 *
 * @param {string} command - The shell command to execute
 * @param {object} options - Options for command execution
 * @param {boolean} options.mirror - If true, mirror output to console (default: true)
 * @param {boolean} options.capture - If true, capture output (default: true)
 * @param {string} options.stdin - Input to pass to the command
 * @param {string} options.cwd - Working directory
 * @param {object} options.env - Environment variables
 * @returns {Promise<ProcessRunner>} The process runner for the command
 */
async function runCommand(command, options = {}) {
  const { $ } = await getCommandStream();

  const $cmd = $({
    mirror: options.mirror !== false,
    capture: options.capture !== false,
    stdin: options.stdin,
    cwd: options.cwd,
    env: options.env,
  });

  // Return the process runner
  return $cmd`${command}`;
}

/**
 * Run a command with event handlers for stdout, stderr, and exit
 *
 * @param {string} command - The shell command to execute
 * @param {object} handlers - Event handlers
 * @param {function} handlers.onStdout - Called with stdout data chunks
 * @param {function} handlers.onStderr - Called with stderr data chunks
 * @param {function} handlers.onExit - Called when command exits with {code, stdout, stderr}
 * @param {object} options - Additional options
 * @param {boolean} options.mirror - If true, also mirror output to console
 * @returns {Promise<void>}
 */
async function runWithHandlers(command, handlers = {}, options = {}) {
  const { $ } = await getCommandStream();

  const { onStdout, onStderr, onExit } = handlers;

  const $cmd = $({
    mirror: options.mirror === true,
    capture: true,
  });

  const runner = $cmd`${command}`;

  // Set up event handlers
  if (onStdout) {
    runner.on('stdout', onStdout);
  }
  if (onStderr) {
    runner.on('stderr', onStderr);
  }
  if (onExit) {
    runner.on('end', onExit);
  }

  // Start the command
  runner.start();

  // Wait for completion
  return await runner;
}

module.exports = {
  getCommandStream,
  execCommand,
  execCommandAsync,
  commandExists,
  getCommandPath,
  getToolVersion,
  runCommand,
  runWithHandlers,
};
