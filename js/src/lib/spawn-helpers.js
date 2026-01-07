/**
 * Spawn helper functions for reliable cross-platform command execution
 *
 * Issue #57: On macOS with Bun, node:child_process events may not fire reliably
 * before the event loop exits. Bun.spawn provides more reliable stream handling.
 *
 * This module provides two implementations:
 * - runWithBunSpawn: Uses Bun.spawn with async/await for reliable event handling
 * - runWithNodeSpawn: Uses node:child_process with close event for Node.js compatibility
 */

const { spawn } = require('child_process');
const fs = require('fs');

/**
 * Run command using Bun.spawn (for Bun runtime)
 * Uses async/await for reliable stream handling on macOS
 *
 * @param {Object} options - Execution options
 * @param {string} options.shell - Shell to use
 * @param {string[]} options.shellArgs - Shell arguments
 * @param {string} options.logFilePath - Path to log file
 * @param {string} options.logContent - Initial log content
 * @param {number} options.startTimeMs - Start timestamp
 * @param {Object} options.executionRecord - Execution tracking record
 * @param {Object} options.store - Execution store
 * @param {Object} options.config - CLI configuration
 * @param {Function} options.onComplete - Callback for completion (exitCode, endTime, logContent, durationMs)
 * @param {Function} options.onError - Callback for errors (errorMessage, endTime, durationMs)
 */
async function runWithBunSpawn(options) {
  const {
    shell,
    shellArgs,
    logFilePath,
    startTimeMs,
    executionRecord,
    store,
    config,
    onComplete,
    onError,
  } = options;

  let logContent = options.logContent || '';

  try {
    // Spawn the process using Bun's native API
    const proc = Bun.spawn([shell, ...shellArgs], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'inherit',
    });

    // Update execution record with PID and save initial state
    if (executionRecord && store) {
      executionRecord.pid = proc.pid;
      try {
        store.save(executionRecord);
      } catch (err) {
        if (config && config.verbose) {
          console.error(
            `[Tracking] Warning: Could not save execution record: ${err.message}`
          );
        }
      }
    }

    if (config && config.verbose) {
      console.log(`[verbose] Using Bun.spawn for reliable macOS handling`);
      console.log(`[verbose] Process PID: ${proc.pid}`);
    }

    // Read stdout and stderr streams concurrently
    // TextDecoder is a global in modern runtimes (Bun, Node.js 16+)
    // eslint-disable-next-line no-undef
    const decoder = new TextDecoder();

    // Read stdout in real-time
    const stdoutReader = proc.stdout.getReader();
    const readStdout = async () => {
      let output = '';
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) {
            break;
          }
          const text = decoder.decode(value);
          process.stdout.write(text);
          output += text;
        }
      } catch (err) {
        if (config && config.verbose) {
          console.error(`[verbose] stdout read error: ${err.message}`);
        }
      }
      return output;
    };

    // Read stderr in real-time
    const stderrReader = proc.stderr.getReader();
    const readStderr = async () => {
      let output = '';
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) {
            break;
          }
          const text = decoder.decode(value);
          process.stderr.write(text);
          output += text;
        }
      } catch (err) {
        if (config && config.verbose) {
          console.error(`[verbose] stderr read error: ${err.message}`);
        }
      }
      return output;
    };

    // Read both streams concurrently and wait for process to exit
    const [stdoutContent, stderrContent, exitCode] = await Promise.all([
      readStdout(),
      readStderr(),
      proc.exited,
    ]);

    // Add captured output to log content
    logContent += stdoutContent;
    logContent += stderrContent;

    const durationMs = Date.now() - startTimeMs;
    const endTime = new Date().toISOString().replace('T', ' ').substring(0, 23);

    // Write log file
    try {
      logContent += `\n${'='.repeat(50)}\n`;
      logContent += `Finished: ${endTime}\n`;
      logContent += `Exit Code: ${exitCode}\n`;
      fs.writeFileSync(logFilePath, logContent, 'utf8');
    } catch (err) {
      console.error(`\nWarning: Could not save log file: ${err.message}`);
    }

    // Update execution record as completed
    if (executionRecord && store) {
      executionRecord.complete(exitCode);
      try {
        store.save(executionRecord);
      } catch (err) {
        if (config && config.verbose) {
          console.error(
            `[Tracking] Warning: Could not update execution record: ${err.message}`
          );
        }
      }
    }

    // Call completion callback
    if (onComplete) {
      onComplete(exitCode, endTime, logContent, durationMs);
    }

    return exitCode;
  } catch (err) {
    const durationMs = Date.now() - startTimeMs;
    const endTime = new Date().toISOString().replace('T', ' ').substring(0, 23);
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

    // Update execution record as failed
    if (executionRecord && store) {
      executionRecord.complete(1);
      try {
        store.save(executionRecord);
      } catch (storeErr) {
        if (config && config.verbose) {
          console.error(
            `[Tracking] Warning: Could not update execution record: ${storeErr.message}`
          );
        }
      }
    }

    // Call error callback
    if (onError) {
      onError(errorMessage, endTime, durationMs);
    }

    return 1;
  }
}

/**
 * Run command using node:child_process (for Node.js compatibility)
 * Uses event-based handling with close event
 *
 * @param {Object} options - Execution options (same as runWithBunSpawn)
 */
function runWithNodeSpawn(options) {
  const {
    shell,
    shellArgs,
    logFilePath,
    startTimeMs,
    executionRecord,
    store,
    config,
    onComplete,
    onError,
  } = options;

  let logContent = options.logContent || '';

  // Execute the command with captured output
  const child = spawn(shell, shellArgs, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false,
  });

  // Update execution record with PID and save initial state
  if (executionRecord && store) {
    executionRecord.pid = child.pid;
    try {
      store.save(executionRecord);
    } catch (err) {
      if (config && config.verbose) {
        console.error(
          `[Tracking] Warning: Could not save execution record: ${err.message}`
        );
      }
    }
  }

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

  // Handle process close (not 'exit' - we need to wait for all stdio to be closed)
  // The 'close' event fires after all stdio streams have been closed, ensuring
  // all stdout/stderr data has been received. The 'exit' event can fire before
  // buffered data is received, causing output loss on macOS (Issue #57).
  child.on('close', (code) => {
    const exitCode = code || 0;
    const durationMs = Date.now() - startTimeMs;
    const endTime = new Date().toISOString().replace('T', ' ').substring(0, 23);

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

    // Update execution record as completed
    if (executionRecord && store) {
      executionRecord.complete(exitCode);
      try {
        store.save(executionRecord);
      } catch (err) {
        if (config && config.verbose) {
          console.error(
            `[Tracking] Warning: Could not update execution record: ${err.message}`
          );
        }
      }
    }

    // Call completion callback
    if (onComplete) {
      onComplete(exitCode, endTime, logContent, durationMs);
    }
  });

  // Handle spawn errors
  child.on('error', (err) => {
    const durationMs = Date.now() - startTimeMs;
    const endTime = new Date().toISOString().replace('T', ' ').substring(0, 23);
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

    // Update execution record as failed
    if (executionRecord && store) {
      executionRecord.complete(1);
      try {
        store.save(executionRecord);
      } catch (storeErr) {
        if (config && config.verbose) {
          console.error(
            `[Tracking] Warning: Could not update execution record: ${storeErr.message}`
          );
        }
      }
    }

    // Call error callback
    if (onError) {
      onError(errorMessage, endTime, durationMs);
    }
  });

  return child;
}

module.exports = {
  runWithBunSpawn,
  runWithNodeSpawn,
};
