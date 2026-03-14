/** Screen-specific isolation helpers extracted from isolation.js */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
 * Run command in GNU Screen using detached mode with log capture.
 * Supports screen >= 4.5.1 (native -Logfile) and older versions (tee fallback).
 * @param {string} command - Command to execute
 * @param {string} sessionName - Session name
 * @param {object} shellInfo - Shell info from getShell()
 * @param {string|null} user - Username to run command as (optional)
 * @param {Function} wrapCommandWithUser - Function to wrap command with user
 * @param {Function} isInteractiveShellCommand - Function to check if command is interactive shell
 * @returns {Promise<{success: boolean, sessionName: string, message: string, output: string}>}
 */
function runScreenWithLogCapture(
  command,
  sessionName,
  shellInfo,
  user = null,
  wrapCommandWithUser,
  isInteractiveShellCommand
) {
  const { shell, shellArg } = shellInfo;
  const logFile = path.join(os.tmpdir(), `screen-output-${sessionName}.log`);

  // Check if screen supports -Logfile option (added in 4.5.1)
  const useNativeLogging = supportsLogfileOption();

  return new Promise((resolve) => {
    try {
      let screenArgs;
      // Wrap command with user switch if specified
      let effectiveCommand = wrapCommandWithUser(command, user);

      // Temporary screenrc file for native logging path (issue #96)
      // Setting logfile flush 0 forces screen to flush its log buffer after every write,
      // preventing output loss for quick-completing commands like `agent --version`.
      // Without this, screen buffers log writes and flushes every 10 seconds by default.
      let screenrcFile = null;

      if (useNativeLogging) {
        // Modern screen (>= 4.5.1): Use -L -Logfile option for native log capture
        // Use a temporary screenrc with `logfile flush 0` to force immediate log flushing
        // (issue #96: quick commands like `agent --version` lose output without this)
        screenrcFile = path.join(os.tmpdir(), `screenrc-${sessionName}`);
        try {
          fs.writeFileSync(screenrcFile, 'logfile flush 0\n');
        } catch {
          // If we can't create the screenrc, proceed without it (best effort)
          screenrcFile = null;
        }

        // screen -dmS <session> -c <screenrc> -L -Logfile <logfile> <shell> -c '<command>'
        const logArgs = screenrcFile
          ? ['-dmS', sessionName, '-c', screenrcFile, '-L', '-Logfile', logFile]
          : ['-dmS', sessionName, '-L', '-Logfile', logFile];
        screenArgs = isInteractiveShellCommand(command)
          ? [...logArgs, ...command.trim().split(/\s+/)]
          : [...logArgs, shell, shellArg, effectiveCommand];

        if (DEBUG) {
          console.log(
            `[DEBUG] Running screen with native log capture (-Logfile): screen ${screenArgs.join(' ')}`
          );
        }
      } else {
        // Older screen (< 4.5.1, e.g., macOS bundled 4.0.3): Use tee fallback
        // The parentheses ensure proper grouping of the command and its stderr
        const isBareShell = isInteractiveShellCommand(command);
        if (!isBareShell) {
          effectiveCommand = `(${effectiveCommand}) 2>&1 | tee "${logFile}"`;
        }
        screenArgs = isBareShell
          ? ['-dmS', sessionName, ...command.trim().split(/\s+/)]
          : ['-dmS', sessionName, shell, shellArg, effectiveCommand];

        if (DEBUG) {
          console.log(
            `[DEBUG] Running screen with tee fallback (older screen version): screen ${screenArgs.join(' ')}`
          );
        }
      }

      // Use spawnSync with array args (not execSync string) to avoid quoting issues (issue #25)
      const result = spawnSync('screen', screenArgs, {
        stdio: 'inherit',
      });

      if (result.error) {
        throw result.error;
      }

      // Helper to read log file output and write to stdout
      // Includes a short retry for the tee fallback path to handle the TOCTOU race
      // condition where the session appears gone but the log file isn't fully written yet
      // (issue #96)
      const readAndDisplayOutput = (retryCount = 0) => {
        let output = '';
        try {
          output = fs.readFileSync(logFile, 'utf8');
        } catch {
          // Log file might not exist if command produced no output
        }

        // If output is empty and we haven't retried yet, wait briefly and retry once.
        // This handles the race where tee's write hasn't been flushed to disk yet
        // when the screen session appears done in `screen -ls` (issue #96).
        if (!output.trim() && retryCount === 0) {
          return new Promise((resolveRetry) => {
            setTimeout(() => {
              resolveRetry(readAndDisplayOutput(1));
            }, 50);
          });
        }

        // Display the output
        if (output.trim()) {
          process.stdout.write(output);
          // Add trailing newline if output doesn't end with one
          if (!output.endsWith('\n')) {
            process.stdout.write('\n');
          }
        }
        return Promise.resolve(output);
      };

      // Clean up temp files
      const cleanupTempFiles = () => {
        try {
          fs.unlinkSync(logFile);
        } catch {
          // Ignore cleanup errors
        }
        if (screenrcFile) {
          try {
            fs.unlinkSync(screenrcFile);
          } catch {
            // Ignore cleanup errors
          }
        }
      };

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
            // Session ended, read output (with retry for tee path race condition)
            readAndDisplayOutput().then((output) => {
              cleanupTempFiles();
              resolve({
                success: true,
                sessionName,
                message: `Screen session "${sessionName}" exited with code 0`,
                exitCode: 0,
                output,
              });
            });
            return;
          }

          waited += checkInterval;
          if (waited >= maxWait) {
            cleanupTempFiles();
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
          readAndDisplayOutput().then((output) => {
            cleanupTempFiles();
            resolve({
              success: true,
              sessionName,
              message: `Screen session "${sessionName}" exited with code 0`,
              exitCode: 0,
              output,
            });
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

/** Reset screen version cache (useful for testing) */
function resetScreenVersionCache() {
  cachedScreenVersion = null;
  screenVersionChecked = false;
}

module.exports = {
  getScreenVersion,
  supportsLogfileOption,
  runScreenWithLogCapture,
  resetScreenVersionCache,
};
