/** Log utility functions for isolation runners */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
 * Run command as an isolated user (without isolation environment)
 * Uses sudo -u to switch users
 * @param {string} cmd - Command to execute
 * @param {string} username - User to run as
 * @returns {Promise<{success: boolean, message: string, exitCode: number}>}
 */
function runAsIsolatedUser(cmd, username) {
  return new Promise((resolve) => {
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
  getTimestamp,
  generateLogFilename,
  createLogHeader,
  createLogFooter,
  writeLogFile,
  getLogDir,
  createLogPath,
  runAsIsolatedUser,
};
