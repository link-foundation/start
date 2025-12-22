/**
 * Isolation Runners for start-command
 *
 * Provides execution of commands in various isolated environments:
 * - screen: GNU Screen terminal multiplexer
 * - tmux: tmux terminal multiplexer
 * - zellij: Modern terminal workspace
 * - docker: Docker containers
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateSessionName } = require('./args-parser');

// Debug mode from environment
const DEBUG =
  process.env.START_DEBUG === '1' || process.env.START_DEBUG === 'true';

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
 * Run command in GNU Screen
 * @param {string} command - Command to execute
 * @param {object} options - Options (session, detached)
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
  const { shell, shellArg } = getShell();

  try {
    if (options.detached) {
      // Detached mode: screen -dmS <session> <shell> -c '<command>'
      const screenArgs = ['-dmS', sessionName, shell, shellArg, command];

      if (DEBUG) {
        console.log(`[DEBUG] Running: screen ${screenArgs.join(' ')}`);
      }

      execSync(`screen ${screenArgs.map((a) => `"${a}"`).join(' ')}`, {
        stdio: 'inherit',
      });

      return Promise.resolve({
        success: true,
        sessionName,
        message: `Command started in detached screen session: ${sessionName}\nReattach with: screen -r ${sessionName}`,
      });
    } else {
      // Attached mode: screen -S <session> <shell> -c '<command>'
      const screenArgs = ['-S', sessionName, shell, shellArg, command];

      if (DEBUG) {
        console.log(`[DEBUG] Running: screen ${screenArgs.join(' ')}`);
      }

      return new Promise((resolve) => {
        const child = spawn('screen', screenArgs, {
          stdio: 'inherit',
        });

        child.on('exit', (code) => {
          resolve({
            success: code === 0,
            sessionName,
            message: `Screen session "${sessionName}" exited with code ${code}`,
            exitCode: code,
          });
        });

        child.on('error', (err) => {
          resolve({
            success: false,
            sessionName,
            message: `Failed to start screen: ${err.message}`,
          });
        });
      });
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
 * @param {object} options - Options (session, detached)
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

  try {
    if (options.detached) {
      // Detached mode: tmux new-session -d -s <session> '<command>'
      if (DEBUG) {
        console.log(
          `[DEBUG] Running: tmux new-session -d -s "${sessionName}" "${command}"`
        );
      }

      execSync(`tmux new-session -d -s "${sessionName}" "${command}"`, {
        stdio: 'inherit',
      });

      return Promise.resolve({
        success: true,
        sessionName,
        message: `Command started in detached tmux session: ${sessionName}\nReattach with: tmux attach -t ${sessionName}`,
      });
    } else {
      // Attached mode: tmux new-session -s <session> '<command>'
      if (DEBUG) {
        console.log(
          `[DEBUG] Running: tmux new-session -s "${sessionName}" "${command}"`
        );
      }

      return new Promise((resolve) => {
        const child = spawn(
          'tmux',
          ['new-session', '-s', sessionName, command],
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
 * Run command in Zellij
 * @param {string} command - Command to execute
 * @param {object} options - Options (session, detached)
 * @returns {Promise<{success: boolean, sessionName: string, message: string}>}
 */
function runInZellij(command, options = {}) {
  if (!isCommandAvailable('zellij')) {
    return Promise.resolve({
      success: false,
      sessionName: null,
      message:
        'zellij is not installed. Install it with: cargo install zellij or brew install zellij (macOS)',
    });
  }

  const sessionName = options.session || generateSessionName('zellij');
  const { shell, shellArg } = getShell();

  try {
    if (options.detached) {
      // Detached mode for zellij
      if (DEBUG) {
        console.log(`[DEBUG] Creating detached zellij session: ${sessionName}`);
      }

      // Create the session in background
      execSync(
        `zellij -s "${sessionName}" action new-tab -- ${shell} ${shellArg} "${command}" &`,
        { stdio: 'inherit', shell: true }
      );

      return Promise.resolve({
        success: true,
        sessionName,
        message: `Command started in detached zellij session: ${sessionName}\nReattach with: zellij attach ${sessionName}`,
      });
    } else {
      // Attached mode: zellij -s <session> -- <shell> -c <command>
      if (DEBUG) {
        console.log(
          `[DEBUG] Running: zellij -s "${sessionName}" -- ${shell} ${shellArg} "${command}"`
        );
      }

      return new Promise((resolve) => {
        const child = spawn(
          'zellij',
          ['-s', sessionName, '--', shell, shellArg, command],
          {
            stdio: 'inherit',
          }
        );

        child.on('exit', (code) => {
          resolve({
            success: code === 0,
            sessionName,
            message: `Zellij session "${sessionName}" exited with code ${code}`,
            exitCode: code,
          });
        });

        child.on('error', (err) => {
          resolve({
            success: false,
            sessionName,
            message: `Failed to start zellij: ${err.message}`,
          });
        });
      });
    }
  } catch (err) {
    return Promise.resolve({
      success: false,
      sessionName,
      message: `Failed to run in zellij: ${err.message}`,
    });
  }
}

/**
 * Run command in Docker container
 * @param {string} command - Command to execute
 * @param {object} options - Options (image, session/name, detached)
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
      // Detached mode: docker run -d --name <name> <image> <shell> -c '<command>'
      const dockerArgs = [
        'run',
        '-d',
        '--name',
        containerName,
        options.image,
        '/bin/sh',
        '-c',
        command,
      ];

      if (DEBUG) {
        console.log(`[DEBUG] Running: docker ${dockerArgs.join(' ')}`);
      }

      const containerId = execSync(`docker ${dockerArgs.join(' ')}`, {
        encoding: 'utf8',
      }).trim();

      return Promise.resolve({
        success: true,
        containerName,
        containerId,
        message: `Command started in detached docker container: ${containerName}\nContainer ID: ${containerId.substring(0, 12)}\nAttach with: docker attach ${containerName}\nView logs: docker logs ${containerName}`,
      });
    } else {
      // Attached mode: docker run -it --name <name> <image> <shell> -c '<command>'
      const dockerArgs = [
        'run',
        '-it',
        '--rm',
        '--name',
        containerName,
        options.image,
        '/bin/sh',
        '-c',
        command,
      ];

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
 * @param {string} backend - Isolation backend (screen, tmux, docker, zellij)
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
    case 'zellij':
      return runInZellij(command, options);
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

module.exports = {
  isCommandAvailable,
  runInScreen,
  runInTmux,
  runInZellij,
  runInDocker,
  runIsolated,
  // Export logging utilities for unified experience
  getTimestamp,
  generateLogFilename,
  createLogHeader,
  createLogFooter,
  writeLogFile,
  getLogDir,
  createLogPath,
};
