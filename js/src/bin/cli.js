#!/usr/bin/env bun

const { spawn, execSync, spawnSync } = require('child_process');
const process = require('process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Import modules
const { processCommand } = require('../lib/substitution');
const {
  parseArgs,
  hasIsolation,
  getEffectiveMode,
} = require('../lib/args-parser');
const {
  runIsolated,
  runAsIsolatedUser,
  getTimestamp,
  createLogHeader,
  createLogFooter,
  writeLogFile,
  createLogPath,
} = require('../lib/isolation');
const {
  createIsolatedUser,
  deleteUser,
  hasSudoAccess,
  getCurrentUserGroups,
} = require('../lib/user-manager');
const { handleFailure } = require('../lib/failure-handler');

// Configuration from environment variables
const config = {
  // Disable automatic issue creation (useful for testing)
  disableAutoIssue:
    process.env.START_DISABLE_AUTO_ISSUE === '1' ||
    process.env.START_DISABLE_AUTO_ISSUE === 'true',
  // Disable log upload
  disableLogUpload:
    process.env.START_DISABLE_LOG_UPLOAD === '1' ||
    process.env.START_DISABLE_LOG_UPLOAD === 'true',
  // Custom log directory (defaults to OS temp)
  logDir: process.env.START_LOG_DIR || null,
  // Verbose mode
  verbose:
    process.env.START_VERBOSE === '1' || process.env.START_VERBOSE === 'true',
  // Disable substitutions/aliases
  disableSubstitutions:
    process.env.START_DISABLE_SUBSTITUTIONS === '1' ||
    process.env.START_DISABLE_SUBSTITUTIONS === 'true',
  // Custom substitutions file path
  substitutionsPath: process.env.START_SUBSTITUTIONS_PATH || null,
  // Use command-stream library for command execution (experimental)
  useCommandStream:
    process.env.START_USE_COMMAND_STREAM === '1' ||
    process.env.START_USE_COMMAND_STREAM === 'true',
};

// Get all arguments passed after the command
const args = process.argv.slice(2);

// Handle --version flag
// Support: $ --version, $ -v, $ --version --
// The trailing -- should be ignored for version check
// Also support --verbose flag for debugging: $ --version --verbose
const hasVersionFlag =
  args.length >= 1 && (args[0] === '--version' || args[0] === '-v');

// Check for --verbose flag in version context
const hasVerboseWithVersion =
  hasVersionFlag &&
  args.some((arg) => arg === '--verbose' || arg === '--debug');

// Determine if this is a version-only call
// Allow: --version, -v, --version --, --version --verbose, etc.
const versionRelatedArgs = ['--version', '-v', '--', '--verbose', '--debug'];
const isVersionOnly =
  hasVersionFlag &&
  args.every(
    (arg) => versionRelatedArgs.includes(arg) || arg === args[0] // Allow the version flag itself
  );

if (hasVersionFlag && isVersionOnly) {
  printVersion(hasVerboseWithVersion || config.verbose);
  process.exit(0);
}

if (args.length === 0) {
  printUsage();
  process.exit(0);
}

// Parse wrapper options and command
let parsedArgs;
try {
  parsedArgs = parseArgs(args);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

const { wrapperOptions, command: parsedCommand } = parsedArgs;

// Check if no command was provided
if (!parsedCommand || parsedCommand.trim() === '') {
  console.error('Error: No command provided');
  printUsage();
  process.exit(1);
}

// Process through substitution engine (unless disabled)
let command = parsedCommand;
let substitutionResult = null;

if (!config.disableSubstitutions) {
  substitutionResult = processCommand(parsedCommand, {
    customLinoPath: config.substitutionsPath,
    verbose: config.verbose,
  });

  if (substitutionResult.matched) {
    command = substitutionResult.command;
    if (config.verbose) {
      console.log(`[Substitution] "${parsedCommand}" -> "${command}"`);
      console.log('');
    }
  }
}

// Determine if we should use command-stream
// Can be enabled via --use-command-stream flag or START_USE_COMMAND_STREAM env var
const useCommandStream =
  wrapperOptions.useCommandStream || config.useCommandStream;

// Main execution
(async () => {
  // Check if running in isolation mode or with user isolation
  if (hasIsolation(wrapperOptions) || wrapperOptions.user) {
    await runWithIsolation(wrapperOptions, command, useCommandStream);
  } else {
    if (useCommandStream) {
      await runDirectWithCommandStream(
        command,
        parsedCommand,
        substitutionResult
      );
    } else {
      await runDirect(command);
    }
  }
})();

/**
 * Print version information
 * @param {boolean} verbose - Whether to show verbose debugging info
 */
function printVersion(verbose = false) {
  // Get package version
  const packageJson = require('../../../../package.json');
  const startCommandVersion = packageJson.version;

  console.log(`start-command version: ${startCommandVersion}`);
  console.log('');

  // Get runtime information (Bun or Node.js)
  const runtime = typeof Bun !== 'undefined' ? 'Bun' : 'Node.js';
  const runtimeVersion =
    typeof Bun !== 'undefined' ? Bun.version : process.version;

  // Get OS information
  console.log(`OS: ${process.platform}`);

  // Get OS version (use sw_vers on macOS for user-friendly version)
  let osVersion = os.release();
  if (process.platform === 'darwin') {
    try {
      osVersion = execSync('sw_vers -productVersion', {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      if (verbose) {
        console.log(`[verbose] macOS version from sw_vers: ${osVersion}`);
      }
    } catch {
      // Fallback to kernel version if sw_vers fails
      osVersion = os.release();
      if (verbose) {
        console.log(
          `[verbose] sw_vers failed, using kernel version: ${osVersion}`
        );
      }
    }
  }

  console.log(`OS Version: ${osVersion}`);
  console.log(`${runtime} Version: ${runtimeVersion}`);
  console.log(`Architecture: ${process.arch}`);
  console.log('');

  // Check for installed isolation tools
  console.log('Isolation tools:');

  if (verbose) {
    console.log('[verbose] Checking isolation tools...');
  }

  // Check screen (use -v flag for compatibility with older versions)
  const screenVersion = getToolVersion('screen', '-v', verbose);
  if (screenVersion) {
    console.log(`  screen: ${screenVersion}`);
  } else {
    console.log('  screen: not installed');
  }

  // Check tmux
  const tmuxVersion = getToolVersion('tmux', '-V', verbose);
  if (tmuxVersion) {
    console.log(`  tmux: ${tmuxVersion}`);
  } else {
    console.log('  tmux: not installed');
  }

  // Check docker
  const dockerVersion = getToolVersion('docker', '--version', verbose);
  if (dockerVersion) {
    console.log(`  docker: ${dockerVersion}`);
  } else {
    console.log('  docker: not installed');
  }
}

/**
 * Get version of an installed tool
 * @param {string} toolName - Name of the tool
 * @param {string} versionFlag - Flag to get version (e.g., '--version', '-V')
 * @param {boolean} verbose - Whether to log verbose information
 * @returns {string|null} Version string or null if not installed
 */
function getToolVersion(toolName, versionFlag, verbose = false) {
  const isWindows = process.platform === 'win32';
  const whichCmd = isWindows ? 'where' : 'which';

  // First, check if the tool exists in PATH
  try {
    execSync(`${whichCmd} ${toolName}`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Tool not found in PATH
    if (verbose) {
      console.log(`[verbose] ${toolName}: not found in PATH`);
    }
    return null;
  }

  // Tool exists, try to get version using spawnSync
  // This captures output regardless of exit code (some tools like older screen
  // versions return non-zero exit code even when showing version successfully)
  const result = spawnSync(toolName, [versionFlag], {
    encoding: 'utf8',
    timeout: 5000,
    shell: false,
  });

  // Combine stdout and stderr (some tools output version to stderr)
  const output = ((result.stdout || '') + (result.stderr || '')).trim();

  if (verbose) {
    console.log(
      `[verbose] ${toolName} ${versionFlag}: exit=${result.status}, output="${output.substring(0, 100)}"`
    );
  }

  if (!output) {
    return null;
  }

  // Return the first line of output
  const firstLine = output.split('\n')[0];
  return firstLine || null;
}

/** Print usage information */
function printUsage() {
  console.log(`Usage: $ [options] [--] <command> [args...]
       $ <command> [args...]

Options:
  --isolated, -i <env>  Run in isolated environment (screen, tmux, docker, ssh)
  --attached, -a        Run in attached mode (foreground)
  --detached, -d        Run in detached mode (background)
  --session, -s <name>  Session name for isolation
  --image <image>       Docker image (required for docker isolation)
  --endpoint <endpoint> SSH endpoint (required for ssh isolation, e.g., user@host)
  --isolated-user, -u [name]  Create isolated user with same permissions
  --keep-user           Keep isolated user after command completes
  --keep-alive, -k      Keep isolation environment alive after command exits
  --auto-remove-docker-container  Auto-remove docker container after exit
  --use-command-stream  Use command-stream library for execution (experimental)
  --version, -v         Show version information

Examples:
  $ echo "Hello World"
  $ bun test
  $ --isolated tmux -- bun start
  $ -i screen -d bun start
  $ --isolated docker --image oven/bun:latest -- bun install
  $ --isolated ssh --endpoint user@remote.server -- ls -la
  $ --isolated-user -- npm test            # Create isolated user
  $ -u myuser -- npm start                 # Custom username
  $ -i screen --isolated-user -- npm test  # Combine with process isolation
  $ --isolated-user --keep-user -- npm start
  $ --use-command-stream echo "Hello"      # Use command-stream library`);
  console.log('');
  console.log('Piping with $:');
  console.log('  echo "hi" | $ agent       # Preferred - pipe TO $ command');
  console.log(
    '  $ \'echo "hi" | agent\'   # Alternative - quote entire pipeline'
  );
  console.log('');
  console.log('Quoting for special characters:');
  console.log("  $ 'npm test && npm build' # Wrap for logical operators");
  console.log("  $ 'cat file > output.txt' # Wrap for redirections");
  console.log('');
  console.log('Features:');
  console.log('  - Logs all output to temporary directory');
  console.log('  - Displays timestamps and exit codes');
  console.log(
    '  - Auto-reports failures for NPM packages (when gh is available)'
  );
  console.log('  - Natural language command aliases (via substitutions.lino)');
  console.log('  - Process isolation via screen, tmux, or docker');
  console.log('');
  console.log('Alias examples:');
  console.log('  $ install lodash npm package           -> npm install lodash');
  console.log(
    '  $ install 4.17.21 version of lodash npm package -> npm install lodash@4.17.21'
  );
  console.log(
    '  $ clone https://github.com/user/repo repository -> git clone https://github.com/user/repo'
  );
}

/**
 * Run command in isolation mode
 * @param {object} options - Wrapper options
 * @param {string} cmd - Command to execute
 * @param {boolean} useCommandStream - Whether to use command-stream for isolation
 */
async function runWithIsolation(options, cmd, useCommandStream = false) {
  const environment = options.isolated;
  const mode = getEffectiveMode(options);
  const startTime = getTimestamp();

  // Create log file path
  const logFilePath = createLogPath(environment || 'direct');

  // Get session name (will be generated by runIsolated if not provided)
  const sessionName =
    options.session ||
    `${environment || 'start'}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  // Handle --isolated-user option: create a new user with same permissions
  let createdUser = null;

  if (options.user) {
    // Check for sudo access
    if (!hasSudoAccess()) {
      console.error(
        'Error: --isolated-user requires sudo access without password.'
      );
      console.error(
        'Configure NOPASSWD in sudoers or run with appropriate permissions.'
      );
      process.exit(1);
    }

    // Get current user groups to show what will be inherited
    const currentGroups = getCurrentUserGroups();
    const importantGroups = ['sudo', 'docker', 'wheel', 'admin'].filter((g) =>
      currentGroups.includes(g)
    );

    console.log(`[User Isolation] Creating new user with same permissions...`);
    if (importantGroups.length > 0) {
      console.log(
        `[User Isolation] Inheriting groups: ${importantGroups.join(', ')}`
      );
    }

    // Create the isolated user
    const userResult = createIsolatedUser(options.userName);
    if (!userResult.success) {
      console.error(
        `Error: Failed to create isolated user: ${userResult.message}`
      );
      process.exit(1);
    }

    createdUser = userResult.username;
    console.log(`[User Isolation] Created user: ${createdUser}`);
    if (userResult.groups && userResult.groups.length > 0) {
      console.log(
        `[User Isolation] User groups: ${userResult.groups.join(', ')}`
      );
    }
    if (options.keepUser) {
      console.log(`[User Isolation] User will be kept after command completes`);
    }
    console.log('');
  }

  // Print start message (unified format)
  console.log(`[${startTime}] Starting: ${cmd}`);
  console.log('');

  // Log isolation info
  if (environment) {
    console.log(`[Isolation] Environment: ${environment}, Mode: ${mode}`);
  }
  if (options.session) {
    console.log(`[Isolation] Session: ${options.session}`);
  }
  if (options.image) {
    console.log(`[Isolation] Image: ${options.image}`);
  }
  if (options.endpoint) {
    console.log(`[Isolation] Endpoint: ${options.endpoint}`);
  }
  if (createdUser) {
    console.log(`[Isolation] User: ${createdUser} (isolated)`);
  }
  if (useCommandStream) {
    console.log(`[Isolation] Using command-stream library`);
  }
  console.log('');

  // Create log content
  let logContent = createLogHeader({
    command: cmd,
    environment: environment || 'direct',
    mode,
    sessionName,
    image: options.image,
    user: createdUser,
    startTime,
  });

  let result;

  if (environment) {
    // Run in isolation backend (screen, tmux, docker, ssh)
    // Note: Isolation backends currently use native spawn/execSync
    // Future: Add command-stream support with raw() function for multiplexers
    result = await runIsolated(environment, cmd, {
      session: options.session,
      image: options.image,
      endpoint: options.endpoint,
      detached: mode === 'detached',
      user: createdUser,
      keepAlive: options.keepAlive,
      autoRemoveDockerContainer: options.autoRemoveDockerContainer,
    });
  } else if (createdUser) {
    // Run directly as the created user (no isolation backend)
    result = await runAsIsolatedUser(cmd, createdUser);
  } else {
    // This shouldn't happen in isolation mode, but handle gracefully
    result = { success: false, message: 'No isolation configuration provided' };
  }

  // Get exit code
  const exitCode =
    result.exitCode !== undefined ? result.exitCode : result.success ? 0 : 1;
  const endTime = getTimestamp();

  // Add result to log content
  logContent += `${result.message}\n`;
  logContent += createLogFooter(endTime, exitCode);

  // Write log file
  writeLogFile(logFilePath, logContent);

  // Print result and footer (unified format)
  console.log('');
  console.log(result.message);
  console.log('');
  console.log(`[${endTime}] Finished`);
  console.log(`Exit code: ${exitCode}`);
  console.log(`Log saved: ${logFilePath}`);

  // Cleanup: delete the created user if we created one (unless --keep-user)
  if (createdUser && !options.keepUser) {
    console.log('');
    console.log(`[User Isolation] Cleaning up user: ${createdUser}`);
    const deleteResult = deleteUser(createdUser, { removeHome: true });
    if (deleteResult.success) {
      console.log(`[User Isolation] User deleted successfully`);
    } else {
      console.log(`[User Isolation] Warning: ${deleteResult.message}`);
    }
  } else if (createdUser && options.keepUser) {
    console.log('');
    console.log(
      `[User Isolation] Keeping user: ${createdUser} (use 'sudo userdel -r ${createdUser}' to delete)`
    );
  }

  process.exit(exitCode);
}

/**
 * Run command directly (without isolation) - original synchronous version
 * @param {string} cmd - Command to execute
 */
function runDirect(cmd) {
  // Get the command name (first word of the actual command to execute)
  const commandName = cmd.split(' ')[0];

  // Determine the shell based on the platform
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'powershell.exe' : process.env.SHELL || '/bin/sh';
  const shellArgs = isWindows ? ['-Command', cmd] : ['-c', cmd];

  // Setup logging
  const logDir = config.logDir || os.tmpdir();
  const logFilename = generateLogFilename();
  const logFilePath = path.join(logDir, logFilename);

  let logContent = '';
  const startTime = getTimestamp();

  // Get runtime information
  const runtime = typeof Bun !== 'undefined' ? 'Bun' : 'Node.js';
  const runtimeVersion =
    typeof Bun !== 'undefined' ? Bun.version : process.version;

  // Log header
  logContent += `=== Start Command Log ===\n`;
  logContent += `Timestamp: ${startTime}\n`;
  if (substitutionResult && substitutionResult.matched) {
    logContent += `Original Input: ${parsedCommand}\n`;
    logContent += `Substituted Command: ${cmd}\n`;
    logContent += `Pattern Matched: ${substitutionResult.rule.pattern}\n`;
  } else {
    logContent += `Command: ${cmd}\n`;
  }
  logContent += `Shell: ${shell}\n`;
  logContent += `Platform: ${process.platform}\n`;
  logContent += `${runtime} Version: ${runtimeVersion}\n`;
  logContent += `Working Directory: ${process.cwd()}\n`;
  logContent += `${'='.repeat(50)}\n\n`;

  // Print start message to console
  if (substitutionResult && substitutionResult.matched) {
    console.log(`[${startTime}] Input: ${parsedCommand}`);
    console.log(`[${startTime}] Executing: ${cmd}`);
  } else {
    console.log(`[${startTime}] Starting: ${cmd}`);
  }
  console.log('');

  // Execute the command with captured output
  const child = spawn(shell, shellArgs, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false,
  });

  // Capture stdout
  child.stdout.on('data', (data) => {
    const text = data.toString();
    process.stdout.write(text);
    logContent += text;
  });

  // Capture stderr
  child.stderr.on('data', (data) => {
    const text = data.toString();
    process.stderr.write(text);
    logContent += text;
  });

  // Handle process exit
  child.on('exit', (code) => {
    const exitCode = code || 0;
    const endTime = getTimestamp();

    // Log footer
    logContent += `\n${'='.repeat(50)}\n`;
    logContent += `Finished: ${endTime}\n`;
    logContent += `Exit Code: ${exitCode}\n`;

    // Write log file
    try {
      fs.writeFileSync(logFilePath, logContent, 'utf8');
    } catch (err) {
      console.error(`\nWarning: Could not save log file: ${err.message}`);
    }

    // Print footer to console
    console.log('');
    console.log(`[${endTime}] Finished`);
    console.log(`Exit code: ${exitCode}`);
    console.log(`Log saved: ${logFilePath}`);

    // If command failed, try to auto-report
    if (exitCode !== 0) {
      handleFailure(config, commandName, cmd, exitCode, logFilePath);
    }

    process.exit(exitCode);
  });

  // Handle spawn errors
  child.on('error', (err) => {
    const endTime = getTimestamp();
    const errorMessage = `Error executing command: ${err.message}`;

    logContent += `\n${errorMessage}\n`;
    logContent += `\n${'='.repeat(50)}\n`;
    logContent += `Finished: ${endTime}\n`;
    logContent += `Exit Code: 1\n`;

    // Write log file
    try {
      fs.writeFileSync(logFilePath, logContent, 'utf8');
    } catch (writeErr) {
      console.error(`\nWarning: Could not save log file: ${writeErr.message}`);
    }

    console.error(`\n${errorMessage}`);
    console.log('');
    console.log(`[${endTime}] Finished`);
    console.log(`Exit code: 1`);
    console.log(`Log saved: ${logFilePath}`);

    handleFailure(config, commandName, cmd, 1, logFilePath);

    process.exit(1);
  });
}

/**
 * Run command directly using command-stream library (experimental)
 * @param {string} cmd - Command to execute
 * @param {string} parsedCmd - Original parsed command
 * @param {object} subResult - Result from substitution engine
 */
async function runDirectWithCommandStream(cmd, parsedCmd, subResult) {
  // Lazy load command-stream
  const { getCommandStream } = require('../lib/command-stream');
  const { $, raw } = await getCommandStream();

  // Get the command name (first word of the actual command to execute)
  const commandName = cmd.split(' ')[0];

  // Determine the shell based on the platform
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'powershell.exe' : process.env.SHELL || '/bin/sh';

  // Setup logging
  const logDir = config.logDir || os.tmpdir();
  const logFilename = generateLogFilename();
  const logFilePath = path.join(logDir, logFilename);

  let logContent = '';
  const startTime = getTimestamp();

  // Get runtime information
  const runtime = typeof Bun !== 'undefined' ? 'Bun' : 'Node.js';
  const runtimeVersion =
    typeof Bun !== 'undefined' ? Bun.version : process.version;

  // Log header
  logContent += `=== Start Command Log ===\n`;
  logContent += `Timestamp: ${startTime}\n`;
  logContent += `Execution Mode: command-stream\n`;
  if (subResult && subResult.matched) {
    logContent += `Original Input: ${parsedCmd}\n`;
    logContent += `Substituted Command: ${cmd}\n`;
    logContent += `Pattern Matched: ${subResult.rule.pattern}\n`;
  } else {
    logContent += `Command: ${cmd}\n`;
  }
  logContent += `Shell: ${shell}\n`;
  logContent += `Platform: ${process.platform}\n`;
  logContent += `${runtime} Version: ${runtimeVersion}\n`;
  logContent += `Working Directory: ${process.cwd()}\n`;
  logContent += `${'='.repeat(50)}\n\n`;

  // Print start message to console
  if (subResult && subResult.matched) {
    console.log(`[${startTime}] Input: ${parsedCmd}`);
    console.log(`[${startTime}] Executing: ${cmd}`);
  } else {
    console.log(`[${startTime}] Starting: ${cmd}`);
  }
  console.log('[command-stream] Using command-stream library');
  console.log('');

  // Execute the command using command-stream with real-time output
  // Using mirror: true to show output in real-time, capture: true to collect it
  // Using raw() to avoid auto-escaping that might interfere with complex shell commands
  const $cmd = $({ mirror: true, capture: true });

  let exitCode = 0;
  try {
    // Use raw() to pass the command without auto-escaping
    // This is important for complex commands with pipes, redirects, etc.
    const result = await $cmd`${raw(cmd)}`;
    exitCode = result.code || 0;

    // Collect output for log
    if (result.stdout) {
      logContent += result.stdout;
    }
    if (result.stderr) {
      logContent += result.stderr;
    }
  } catch (err) {
    exitCode = err.code || 1;
    const errorMessage = `Error executing command: ${err.message}`;
    logContent += `\n${errorMessage}\n`;
    console.error(`\n${errorMessage}`);
  }

  const endTime = getTimestamp();

  // Log footer
  logContent += `\n${'='.repeat(50)}\n`;
  logContent += `Finished: ${endTime}\n`;
  logContent += `Exit Code: ${exitCode}\n`;

  // Write log file
  try {
    fs.writeFileSync(logFilePath, logContent, 'utf8');
  } catch (err) {
    console.error(`\nWarning: Could not save log file: ${err.message}`);
  }

  // Print footer to console
  console.log('');
  console.log(`[${endTime}] Finished`);
  console.log(`Exit code: ${exitCode}`);
  console.log(`Log saved: ${logFilePath}`);

  // If command failed, try to auto-report
  if (exitCode !== 0) {
    handleFailure(config, commandName, cmd, exitCode, logFilePath);
  }

  process.exit(exitCode);
}

/**
 * Generate unique log filename for direct execution
 * @returns {string} Log filename
 */
function generateLogFilename() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `start-command-${timestamp}-${random}.log`;
}
