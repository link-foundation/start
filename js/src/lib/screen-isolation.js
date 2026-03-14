/** Screen-specific isolation helpers extracted from isolation.js */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const setTimeout = globalThis.setTimeout;

// Debug mode from environment (START_DEBUG or START_VERBOSE).
// Evaluated as a function so that env vars set after module load (e.g., by --verbose flag) are respected.
function isDebug() {
  return (
    process.env.START_DEBUG === '1' ||
    process.env.START_DEBUG === 'true' ||
    process.env.START_VERBOSE === '1' ||
    process.env.START_VERBOSE === 'true'
  );
}

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

      if (isDebug()) {
        console.error(
          `[screen-isolation] Detected screen version: ${cachedScreenVersion.major}.${cachedScreenVersion.minor}.${cachedScreenVersion.patch}`
        );
      }

      return cachedScreenVersion;
    }
  } catch {
    if (isDebug()) {
      console.error('[screen-isolation] Could not detect screen version');
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
 *
 * Uses a unified approach combining the `-L` flag with screenrc directives:
 * - `-L` flag enables logging for the initial window (available on ALL screen versions)
 * - `logfile <path>` in screenrc sets the log file path (replaces `-Logfile` CLI option)
 * - `logfile flush 0` forces immediate flushing (no 10-second delay)
 * - `deflog on` enables logging for any additional windows
 *
 * Key insight: `deflog on` only applies to windows created AFTER screenrc processing,
 * but the default window is created BEFORE screenrc is processed. The `-L` flag is
 * needed to enable logging for that initial window. Without it, output is silently
 * lost on macOS screen 4.00.03 (issue #96).
 *
 * This replaces the previous version-dependent approach that used:
 * - `-L -Logfile` for screen >= 4.5.1 (native logging)
 * - `tee` fallback for screen < 4.5.1 (e.g., macOS bundled 4.0.3)
 *
 * The tee fallback had reliability issues on macOS because:
 * - tee's write buffers may not be flushed before the session ends
 * - The TOCTOU race between session detection and file read was hard to mitigate
 *
 * @param {string} command - Command to execute
 * @param {string} sessionName - Session name
 * @param {object} shellInfo - Shell info from getShell()
 * @param {string|null} user - Username to run command as (optional)
 * @param {Function} wrapCommandWithUser - Function to wrap command with user
 * @param {Function} isInteractiveShellCommand - Function to check if command is interactive shell
 * @returns {Promise<{success: boolean, sessionName: string, message: string, output: string, exitCode: number}>}
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
  const exitCodeFile = path.join(
    os.tmpdir(),
    `screen-exit-${sessionName}.code`
  );

  return new Promise((resolve) => {
    try {
      // Wrap command with user switch if specified
      let effectiveCommand = wrapCommandWithUser(command, user);

      // Wrap command to capture exit code in a sidecar file.
      // We save $? after the command completes so we can report the real exit code
      // instead of always assuming 0 (previous behavior).
      const isBareShell = isInteractiveShellCommand(command);
      if (!isBareShell) {
        effectiveCommand = `${effectiveCommand}; echo $? > "${exitCodeFile}"`;
      }

      // Create temporary screenrc with logging configuration.
      // Combined with the -L flag (which enables logging for the initial window),
      // these directives work on ALL screen versions (including macOS 4.00.03):
      // - `logfile <path>` sets the output log path (replaces -Logfile CLI option)
      // - `logfile flush 0` forces immediate buffer flush (prevents output loss)
      // - `deflog on` enables logging for any subsequently created windows
      const screenrcFile = path.join(os.tmpdir(), `screenrc-${sessionName}`);
      const screenrcContent = [
        `logfile ${logFile}`,
        'logfile flush 0',
        'deflog on',
        '',
      ].join('\n');

      try {
        fs.writeFileSync(screenrcFile, screenrcContent);
      } catch (err) {
        if (isDebug()) {
          console.error(
            `[screen-isolation] Failed to create screenrc: ${err.message}`
          );
        }
        resolve({
          success: false,
          sessionName,
          message: `Failed to create screenrc for logging: ${err.message}`,
        });
        return;
      }

      // Build screen arguments:
      //   screen -dmS <session> -L -c <screenrc> <shell> -c '<command>'
      //
      // The -L flag explicitly enables logging for the initial window.
      // Without -L, `deflog on` in screenrc only applies to windows created
      // AFTER the screenrc is processed — but the default window is created
      // BEFORE screenrc processing. This caused output to be silently lost
      // on macOS screen 4.00.03 (issue #96).
      //
      // The -L flag is available on ALL screen versions (including 4.00.03).
      // Combined with `logfile <path>` in screenrc, -L logs to our custom path
      // instead of the default `screenlog.0`.
      const screenArgs = isBareShell
        ? [
            '-dmS',
            sessionName,
            '-L',
            '-c',
            screenrcFile,
            ...command.trim().split(/\s+/),
          ]
        : [
            '-dmS',
            sessionName,
            '-L',
            '-c',
            screenrcFile,
            shell,
            shellArg,
            effectiveCommand,
          ];

      if (isDebug()) {
        console.error(
          `[screen-isolation] Running: screen ${screenArgs.join(' ')}`
        );
        console.error(`[screen-isolation] screenrc: ${screenrcContent.trim()}`);
        console.error(`[screen-isolation] Log file: ${logFile}`);
        console.error(`[screen-isolation] Exit code file: ${exitCodeFile}`);
      }

      // Use spawnSync with array args (not execSync string) to avoid quoting issues (issue #25)
      const result = spawnSync('screen', screenArgs, {
        stdio: 'inherit',
      });

      if (result.error) {
        throw result.error;
      }

      // Helper to read log file output and write to stdout.
      // Uses multiple retries with increasing delays to handle the race condition
      // where the screen session disappears from `screen -ls` but the log file
      // hasn't been fully flushed yet (issue #96).
      const readAndDisplayOutput = (retryCount = 0) => {
        const MAX_RETRIES = 3;
        const RETRY_DELAYS = [50, 100, 200]; // ms

        let output = '';
        try {
          output = fs.readFileSync(logFile, 'utf8');
        } catch {
          // Log file might not exist if command produced no output
        }

        // If output is empty and we haven't exhausted retries, wait and retry.
        if (!output.trim() && retryCount < MAX_RETRIES) {
          const delay = RETRY_DELAYS[retryCount] || 200;
          if (isDebug()) {
            console.error(
              `[screen-isolation] Log file empty, retry ${retryCount + 1}/${MAX_RETRIES} after ${delay}ms`
            );
          }
          return new Promise((resolveRetry) => {
            setTimeout(() => {
              resolveRetry(readAndDisplayOutput(retryCount + 1));
            }, delay);
          });
        }

        if (isDebug() && !output.trim()) {
          console.error(
            `[screen-isolation] Log file still empty after ${MAX_RETRIES} retries`
          );
          // Check if log file exists at all
          try {
            const stats = fs.statSync(logFile);
            console.error(
              `[screen-isolation] Log file exists, size: ${stats.size} bytes`
            );
          } catch {
            console.error(`[screen-isolation] Log file does not exist`);
          }
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

      // Read exit code from sidecar file
      const readExitCode = () => {
        if (isBareShell) {
          return 0; // Can't capture exit code for interactive shells
        }
        try {
          const content = fs.readFileSync(exitCodeFile, 'utf8').trim();
          const code = parseInt(content, 10);
          if (isDebug()) {
            console.error(`[screen-isolation] Captured exit code: ${code}`);
          }
          return isNaN(code) ? 0 : code;
        } catch {
          if (isDebug()) {
            console.error(
              `[screen-isolation] Could not read exit code file, defaulting to 0`
            );
          }
          return 0;
        }
      };

      // Clean up temp files
      const cleanupTempFiles = () => {
        for (const f of [logFile, screenrcFile, exitCodeFile]) {
          try {
            fs.unlinkSync(f);
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
            // Session ended, read output and exit code
            readAndDisplayOutput().then((output) => {
              const exitCode = readExitCode();
              cleanupTempFiles();
              resolve({
                success: exitCode === 0,
                sessionName,
                message: `Screen session "${sessionName}" exited with code ${exitCode}`,
                exitCode,
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
            const exitCode = readExitCode();
            cleanupTempFiles();
            resolve({
              success: exitCode === 0,
              sessionName,
              message: `Screen session "${sessionName}" exited with code ${exitCode}`,
              exitCode,
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
