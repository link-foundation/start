/**
 * Isolation Runners for start-command
 *
 * Provides execution of commands in various isolated environments:
 * - screen: GNU Screen terminal multiplexer
 * - tmux: tmux terminal multiplexer
 * - docker: Docker containers
 */

const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateSessionName } = require('./args-parser');

const setTimeout = globalThis.setTimeout;

// Debug mode from environment
const DEBUG =
  process.env.START_DEBUG === '1' || process.env.START_DEBUG === 'true';

// Cache for screen version detection
let cachedScreenVersion = null;
let screenVersionChecked = false;

/**
 * Get the installed screen version
 * @returns {{major: number, minor: number, patch: number}|null} Version object or null if detection fails
 */
function getScreenVersion() {
  if (screenVersionChecked) {
    return cachedScreenVersion;
  }

  screenVersionChecked = true;

  try {
    const output = execSync('screen --version', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Match patterns like "4.09.01", "4.00.03", "4.5.1"
    const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
    if (match) {
      cachedScreenVersion = {
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: parseInt(match[3], 10),
      };

      if (DEBUG) {
        console.log(
          `[DEBUG] Detected screen version: ${cachedScreenVersion.major}.${cachedScreenVersion.minor}.${cachedScreenVersion.patch}`
        );
      }

      return cachedScreenVersion;
    }
  } catch {
    if (DEBUG) {
      console.log('[DEBUG] Could not detect screen version');
    }
  }

  return null;
}

/**
 * Check if screen supports the -Logfile option
 * The -Logfile option was introduced in GNU Screen 4.5.1
 * @returns {boolean} True if -Logfile is supported
 */
function supportsLogfileOption() {
  const version = getScreenVersion();
  if (!version) {
    // If we can't detect version, assume older version and use fallback
    return false;
  }

  // -Logfile was added in 4.5.1
  // Compare: version >= 4.5.1
  if (version.major > 4) {
    return true;
  }
  if (version.major < 4) {
    return false;
  }
  // major === 4
  if (version.minor > 5) {
    return true;
  }
  if (version.minor < 5) {
    return false;
  }
  // minor === 5
  return version.patch >= 1;
}

/**
 * Check if a command is available on the system
 * @param {string} command - Command to check
 * @returns {boolean} True if command is available
 */
function isCommandAvailable(command) {
  try {
    const isWindows = process.platform === 'win32';
    const checkCmd = isWindows ? 'where' : 'which';
    execSync(`${checkCmd} ${command}`, { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the shell to use for command execution
 * @returns {{shell: string, shellArgs: string[]}} Shell path and args
 */
function getShell() {
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'cmd.exe' : process.env.SHELL || '/bin/sh';
  const shellArg = isWindows ? '/c' : '-c';
  return { shell, shellArg };
}

/**
 * Check if the current process has a TTY attached
 * @returns {boolean} True if TTY is available
 */
function hasTTY() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Wrap command with sudo -u if user option is specified
 * @param {string} command - Original command
 * @param {string|null} user - Username to run as (or null)
 * @returns {string} Wrapped command
 */
function wrapCommandWithUser(command, user) {
  if (!user) {
    return command;
  }
  // Use sudo -u to run command as specified user
  // -E preserves environment variables
  // -n ensures non-interactive (fails if password required)
  return `sudo -n -u ${user} sh -c '${command.replace(/'/g, "'\\''")}'`;
}

/**
 * Run command in GNU Screen using detached mode with log capture
 * This is a workaround for environments without TTY
 *
 * Supports two methods based on screen version:
 * - screen >= 4.5.1: Uses -L -Logfile option for native log capture
 * - screen < 4.5.1: Uses tee command within the wrapped command for output capture
 *
 * @param {string} command - Command to execute
 * @param {string} sessionName - Session name
 * @param {object} shellInfo - Shell info from getShell()
 * @param {string|null} user - Username to run command as (optional)
 * @returns {Promise<{success: boolean, sessionName: string, message: string, output: string}>}
 */
function runScreenWithLogCapture(command, sessionName, shellInfo, user = null) {
  const { shell, shellArg } = shellInfo;
  const logFile = path.join(os.tmpdir(), `screen-output-${sessionName}.log`);

  // Check if screen supports -Logfile option (added in 4.5.1)
  const useNativeLogging = supportsLogfileOption();

  return new Promise((resolve) => {
    try {
      let screenArgs;
      // Wrap command with user switch if specified
      let effectiveCommand = wrapCommandWithUser(command, user);

      if (useNativeLogging) {
        // Modern screen (>= 4.5.1): Use -L -Logfile option for native log capture
        // screen -dmS <session> -L -Logfile <logfile> <shell> -c '<command>'
        screenArgs = [
          '-dmS',
          sessionName,
          '-L',
          '-Logfile',
          logFile,
          shell,
          shellArg,
          effectiveCommand,
        ];

        if (DEBUG) {
          console.log(
            `[DEBUG] Running screen with native log capture (-Logfile): screen ${screenArgs.join(' ')}`
          );
        }
      } else {
        // Older screen (< 4.5.1, e.g., macOS bundled 4.0.3): Use tee fallback
        // Wrap the command to capture output using tee
        // The parentheses ensure proper grouping of the command and its stderr
        effectiveCommand = `(${effectiveCommand}) 2>&1 | tee "${logFile}"`;
        screenArgs = ['-dmS', sessionName, shell, shellArg, effectiveCommand];

        if (DEBUG) {
          console.log(
            `[DEBUG] Running screen with tee fallback (older screen version): screen ${screenArgs.join(' ')}`
          );
        }
      }

      // Use spawnSync with array arguments to avoid shell quoting issues
      // This is critical for commands containing quotes (e.g., echo "hello")
      // Using execSync with a constructed string would break on nested quotes
      // See issue #25 for details
      const result = spawnSync('screen', screenArgs, {
        stdio: 'inherit',
      });

      if (result.error) {
        throw result.error;
      }

      // Poll for session completion
      const checkInterval = 100; // ms
      const maxWait = 300000; // 5 minutes max
      let waited = 0;

      const checkCompletion = () => {
        try {
          // Check if session still exists
          const sessions = execSync('screen -ls', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          if (!sessions.includes(sessionName)) {
            // Session ended, read output
            let output = '';
            try {
              output = fs.readFileSync(logFile, 'utf8');
              // Display the output
              if (output.trim()) {
                process.stdout.write(output);
              }
            } catch {
              // Log file might not exist if command was very quick
            }

            // Clean up log file
            try {
              fs.unlinkSync(logFile);
            } catch {
              // Ignore cleanup errors
            }

            resolve({
              success: true,
              sessionName,
              message: `Screen session "${sessionName}" exited with code 0`,
              exitCode: 0,
              output,
            });
            return;
          }

          waited += checkInterval;
          if (waited >= maxWait) {
            resolve({
              success: false,
              sessionName,
              message: `Screen session "${sessionName}" timed out after ${maxWait / 1000} seconds`,
              exitCode: 1,
            });
            return;
          }

          setTimeout(checkCompletion, checkInterval);
        } catch {
          // screen -ls failed, session probably ended
          let output = '';
          try {
            output = fs.readFileSync(logFile, 'utf8');
            if (output.trim()) {
              process.stdout.write(output);
            }
          } catch {
            // Ignore
          }

          try {
            fs.unlinkSync(logFile);
          } catch {
            // Ignore
          }

          resolve({
            success: true,
            sessionName,
            message: `Screen session "${sessionName}" exited with code 0`,
            exitCode: 0,
            output,
          });
        }
      };

      // Start checking after a brief delay
      setTimeout(checkCompletion, checkInterval);
    } catch (err) {
      resolve({
        success: false,
        sessionName,
        message: `Failed to run in screen: ${err.message}`,
      });
    }
  });
}

/**
 * Run command in GNU Screen
 * @param {string} command - Command to execute
 * @param {object} options - Options (session, detached, user, keepAlive)
 * @returns {Promise<{success: boolean, sessionName: string, message: string}>}
 */
function runInScreen(command, options = {}) {
  if (!isCommandAvailable('screen')) {
    return Promise.resolve({
      success: false,
      sessionName: null,
      message:
        'screen is not installed. Install it with: sudo apt-get install screen (Debian/Ubuntu) or brew install screen (macOS)',
    });
  }

  const sessionName = options.session || generateSessionName('screen');
  const shellInfo = getShell();
  const { shell, shellArg } = shellInfo;

  try {
    // Wrap command with user switch if specified
    let effectiveCommand = wrapCommandWithUser(command, options.user);

    if (options.detached) {
      // Detached mode: screen -dmS <session> <shell> -c '<command>'
      // By default (keepAlive=false), the session will exit after command completes
      // With keepAlive=true, we start a shell that runs the command but stays alive

      if (options.keepAlive) {
        // With keep-alive: run command, then keep shell open
        effectiveCommand = `${effectiveCommand}; exec ${shell}`;
      }
      // Without keep-alive: command runs and session exits naturally when done

      const screenArgs = [
        '-dmS',
        sessionName,
        shell,
        shellArg,
        effectiveCommand,
      ];

      if (DEBUG) {
        console.log(`[DEBUG] Running: screen ${screenArgs.join(' ')}`);
        console.log(`[DEBUG] keepAlive: ${options.keepAlive || false}`);
      }

      // Use spawnSync with array arguments to avoid shell quoting issues
      // This is critical for commands containing quotes (e.g., echo "hello")
      // See issue #25 for details
      const result = spawnSync('screen', screenArgs, {
        stdio: 'inherit',
      });

      if (result.error) {
        throw result.error;
      }

      let message = `Command started in detached screen session: ${sessionName}`;
      if (options.keepAlive) {
        message += `\nSession will stay alive after command completes.`;
      } else {
        message += `\nSession will exit automatically after command completes.`;
      }
      message += `\nReattach with: screen -r ${sessionName}`;

      return Promise.resolve({
        success: true,
        sessionName,
        message,
      });
    } else {
      // Attached mode: always use detached mode with log capture
      // This ensures output is captured and displayed correctly, even for quick commands
      // that would otherwise have their output lost in a rapidly-terminating screen session.
      // Direct screen invocation (screen -S session shell -c command) loses output because:
      // 1. Screen creates a virtual terminal for the session
      // 2. Command output goes to that virtual terminal
      // 3. When the command exits quickly, screen shows "[screen is terminating]"
      // 4. The virtual terminal is destroyed and output is lost
      // See issue #25 for details: https://github.com/link-foundation/start/issues/25
      if (DEBUG) {
        console.log(
          `[DEBUG] Using detached mode with log capture for reliable output`
        );
      }

      return runScreenWithLogCapture(
        command,
        sessionName,
        shellInfo,
        options.user
      );
    }
  } catch (err) {
    return Promise.resolve({
      success: false,
      sessionName,
      message: `Failed to run in screen: ${err.message}`,
    });
  }
}

/**
 * Run command in tmux
 * @param {string} command - Command to execute
 * @param {object} options - Options (session, detached, user, keepAlive)
 * @returns {Promise<{success: boolean, sessionName: string, message: string}>}
 */
function runInTmux(command, options = {}) {
  if (!isCommandAvailable('tmux')) {
    return Promise.resolve({
      success: false,
      sessionName: null,
      message:
        'tmux is not installed. Install it with: sudo apt-get install tmux (Debian/Ubuntu) or brew install tmux (macOS)',
    });
  }

  const sessionName = options.session || generateSessionName('tmux');
  const shellInfo = getShell();
  const { shell } = shellInfo;

  // Wrap command with user switch if specified
  let effectiveCommand = wrapCommandWithUser(command, options.user);

  try {
    if (options.detached) {
      // Detached mode: tmux new-session -d -s <session> '<command>'
      // By default (keepAlive=false), the session will exit after command completes
      // With keepAlive=true, we keep the shell alive after the command

      if (options.keepAlive) {
        // With keep-alive: run command, then keep shell open
        effectiveCommand = `${effectiveCommand}; exec ${shell}`;
      }
      // Without keep-alive: command runs and session exits naturally when done

      if (DEBUG) {
        console.log(
          `[DEBUG] Running: tmux new-session -d -s "${sessionName}" "${effectiveCommand}"`
        );
        console.log(`[DEBUG] keepAlive: ${options.keepAlive || false}`);
      }

      execSync(
        `tmux new-session -d -s "${sessionName}" "${effectiveCommand}"`,
        {
          stdio: 'inherit',
        }
      );

      let message = `Command started in detached tmux session: ${sessionName}`;
      if (options.keepAlive) {
        message += `\nSession will stay alive after command completes.`;
      } else {
        message += `\nSession will exit automatically after command completes.`;
      }
      message += `\nReattach with: tmux attach -t ${sessionName}`;

      return Promise.resolve({
        success: true,
        sessionName,
        message,
      });
    } else {
      // Attached mode: tmux new-session -s <session> '<command>'
      if (DEBUG) {
        console.log(
          `[DEBUG] Running: tmux new-session -s "${sessionName}" "${effectiveCommand}"`
        );
      }

      return new Promise((resolve) => {
        const child = spawn(
          'tmux',
          ['new-session', '-s', sessionName, effectiveCommand],
          {
            stdio: 'inherit',
          }
        );

        child.on('exit', (code) => {
          resolve({
            success: code === 0,
            sessionName,
            message: `Tmux session "${sessionName}" exited with code ${code}`,
            exitCode: code,
          });
        });

        child.on('error', (err) => {
          resolve({
            success: false,
            sessionName,
            message: `Failed to start tmux: ${err.message}`,
          });
        });
      });
    }
  } catch (err) {
    return Promise.resolve({
      success: false,
      sessionName,
      message: `Failed to run in tmux: ${err.message}`,
    });
  }
}

/**
 * Run command in Docker container
 * @param {string} command - Command to execute
 * @param {object} options - Options (image, session/name, detached, user, keepAlive, autoRemoveDockerContainer)
 * @returns {Promise<{success: boolean, containerName: string, message: string}>}
 */
function runInDocker(command, options = {}) {
  if (!isCommandAvailable('docker')) {
    return Promise.resolve({
      success: false,
      containerName: null,
      message:
        'docker is not installed. Install Docker from https://docs.docker.com/get-docker/',
    });
  }

  if (!options.image) {
    return Promise.resolve({
      success: false,
      containerName: null,
      message: 'Docker isolation requires --image option',
    });
  }

  const containerName = options.session || generateSessionName('docker');

  try {
    if (options.detached) {
      // Detached mode: docker run -d --name <name> [--user <user>] <image> <shell> -c '<command>'
      // By default (keepAlive=false), the container exits after command completes
      // With keepAlive=true, we keep the container running with a shell
      let effectiveCommand = command;

      if (options.keepAlive) {
        // With keep-alive: run command, then keep shell alive
        effectiveCommand = `${command}; exec /bin/sh`;
      }
      // Without keep-alive: container exits naturally when command completes

      const dockerArgs = ['run', '-d', '--name', containerName];

      // Add --rm flag if autoRemoveDockerContainer is true
      // Note: --rm must come before the image name
      if (options.autoRemoveDockerContainer) {
        dockerArgs.splice(2, 0, '--rm');
      }

      // Add --user flag if specified
      if (options.user) {
        dockerArgs.push('--user', options.user);
      }

      dockerArgs.push(options.image, '/bin/sh', '-c', effectiveCommand);

      if (DEBUG) {
        console.log(`[DEBUG] Running: docker ${dockerArgs.join(' ')}`);
        console.log(`[DEBUG] keepAlive: ${options.keepAlive || false}`);
        console.log(
          `[DEBUG] autoRemoveDockerContainer: ${options.autoRemoveDockerContainer || false}`
        );
      }

      const containerId = execSync(`docker ${dockerArgs.join(' ')}`, {
        encoding: 'utf8',
      }).trim();

      let message = `Command started in detached docker container: ${containerName}`;
      message += `\nContainer ID: ${containerId.substring(0, 12)}`;
      if (options.keepAlive) {
        message += `\nContainer will stay alive after command completes.`;
      } else {
        message += `\nContainer will exit automatically after command completes.`;
      }
      if (options.autoRemoveDockerContainer) {
        message += `\nContainer will be automatically removed after exit.`;
      } else {
        message += `\nContainer filesystem will be preserved after exit.`;
      }
      message += `\nAttach with: docker attach ${containerName}`;
      message += `\nView logs: docker logs ${containerName}`;

      return Promise.resolve({
        success: true,
        containerName,
        containerId,
        message,
      });
    } else {
      // Attached mode: docker run -it --name <name> [--user <user>] <image> <shell> -c '<command>'
      const dockerArgs = ['run', '-it', '--rm', '--name', containerName];

      // Add --user flag if specified
      if (options.user) {
        dockerArgs.push('--user', options.user);
      }

      dockerArgs.push(options.image, '/bin/sh', '-c', command);

      if (DEBUG) {
        console.log(`[DEBUG] Running: docker ${dockerArgs.join(' ')}`);
      }

      return new Promise((resolve) => {
        const child = spawn('docker', dockerArgs, {
          stdio: 'inherit',
        });

        child.on('exit', (code) => {
          resolve({
            success: code === 0,
            containerName,
            message: `Docker container "${containerName}" exited with code ${code}`,
            exitCode: code,
          });
        });

        child.on('error', (err) => {
          resolve({
            success: false,
            containerName,
            message: `Failed to start docker: ${err.message}`,
          });
        });
      });
    }
  } catch (err) {
    return Promise.resolve({
      success: false,
      containerName,
      message: `Failed to run in docker: ${err.message}`,
    });
  }
}

/**
 * Run command in the specified isolation backend
 * @param {string} backend - Isolation backend (screen, tmux, docker)
 * @param {string} command - Command to execute
 * @param {object} options - Options
 * @returns {Promise<{success: boolean, message: string}>}
 */
function runIsolated(backend, command, options = {}) {
  switch (backend) {
    case 'screen':
      return runInScreen(command, options);
    case 'tmux':
      return runInTmux(command, options);
    case 'docker':
      return runInDocker(command, options);
    default:
      return Promise.resolve({
        success: false,
        message: `Unknown isolation backend: ${backend}`,
      });
  }
}

/**
 * Generate timestamp for logging
 * @returns {string} ISO timestamp without 'T' and 'Z'
 */
function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Generate unique log filename
 * @param {string} environment - The isolation environment name
 * @returns {string} Log filename
 */
function generateLogFilename(environment) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `start-command-${environment}-${timestamp}-${random}.log`;
}

/**
 * Create log content header
 * @param {object} params - Log parameters
 * @param {string} params.command - The command being executed
 * @param {string} params.environment - The isolation environment
 * @param {string} params.mode - attached or detached
 * @param {string} params.sessionName - Session/container name
 * @param {string} [params.image] - Docker image (for docker environment)
 * @param {string} [params.user] - User to run command as (optional)
 * @param {string} params.startTime - Start timestamp
 * @returns {string} Log header content
 */
function createLogHeader(params) {
  let content = `=== Start Command Log ===\n`;
  content += `Timestamp: ${params.startTime}\n`;
  content += `Command: ${params.command}\n`;
  content += `Environment: ${params.environment}\n`;
  content += `Mode: ${params.mode}\n`;
  content += `Session: ${params.sessionName}\n`;
  if (params.image) {
    content += `Image: ${params.image}\n`;
  }
  if (params.user) {
    content += `User: ${params.user}\n`;
  }
  content += `Platform: ${process.platform}\n`;
  content += `Node Version: ${process.version}\n`;
  content += `Working Directory: ${process.cwd()}\n`;
  content += `${'='.repeat(50)}\n\n`;
  return content;
}

/**
 * Create log content footer
 * @param {string} endTime - End timestamp
 * @param {number} exitCode - Exit code
 * @returns {string} Log footer content
 */
function createLogFooter(endTime, exitCode) {
  let content = `\n${'='.repeat(50)}\n`;
  content += `Finished: ${endTime}\n`;
  content += `Exit Code: ${exitCode}\n`;
  return content;
}

/**
 * Write log file
 * @param {string} logPath - Path to log file
 * @param {string} content - Log content
 * @returns {boolean} Success status
 */
function writeLogFile(logPath, content) {
  try {
    fs.writeFileSync(logPath, content, 'utf8');
    return true;
  } catch (err) {
    console.error(`\nWarning: Could not save log file: ${err.message}`);
    return false;
  }
}

/**
 * Get log directory from environment or use system temp
 * @returns {string} Log directory path
 */
function getLogDir() {
  return process.env.START_LOG_DIR || os.tmpdir();
}

/**
 * Create log file path
 * @param {string} environment - The isolation environment
 * @returns {string} Full path to log file
 */
function createLogPath(environment) {
  const logDir = getLogDir();
  const logFilename = generateLogFilename(environment);
  return path.join(logDir, logFilename);
}

/**
 * Reset screen version cache (useful for testing)
 */
function resetScreenVersionCache() {
  cachedScreenVersion = null;
  screenVersionChecked = false;
}

/**
 * Run command as a specific user (without isolation backend)
 * Uses sudo -u to switch users
 * @param {string} cmd - Command to execute
 * @param {string} username - User to run as
 * @returns {Promise<{success: boolean, message: string, exitCode: number}>}
 */
function runAsUser(cmd, username) {
  return new Promise((resolve) => {
    // Use sudo -n -u to run as the specified user
    const child = spawn('sudo', ['-n', '-u', username, 'sh', '-c', cmd], {
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      resolve({
        success: code === 0,
        message: `Command completed as user "${username}" with exit code ${code}`,
        exitCode: code || 0,
      });
    });

    child.on('error', (err) => {
      resolve({
        success: false,
        message: `Failed to run as user "${username}": ${err.message}`,
        exitCode: 1,
      });
    });
  });
}

module.exports = {
  isCommandAvailable,
  hasTTY,
  runInScreen,
  runInTmux,
  runInDocker,
  runIsolated,
  runAsUser,
  wrapCommandWithUser,
  // Export logging utilities for unified experience
  getTimestamp,
  generateLogFilename,
  createLogHeader,
  createLogFooter,
  writeLogFile,
  getLogDir,
  createLogPath,
  // Export screen version utilities for testing and debugging
  getScreenVersion,
  supportsLogfileOption,
  resetScreenVersionCache,
};
