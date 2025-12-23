#!/usr/bin/env node
/**
 * Experiment: Test screen output capture behavior
 *
 * This experiment tests different approaches to capture output from GNU screen
 * sessions, specifically addressing issue #25 where output is lost on macOS
 * with screen 4.00.03.
 */

const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Check if screen is available
function isScreenAvailable() {
  try {
    execSync('which screen', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

// Get screen version
function getScreenVersion() {
  try {
    const output = execSync('screen --version', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
    if (match) {
      return {
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: parseInt(match[3], 10),
        raw: output.trim(),
      };
    }
  } catch {
    // Ignore
  }
  return null;
}

// Check if -Logfile is supported (screen >= 4.5.1)
function supportsLogfileOption(version) {
  if (!version) {
    return false;
  }
  if (version.major > 4) {
    return true;
  }
  if (version.major < 4) {
    return false;
  }
  if (version.minor > 5) {
    return true;
  }
  if (version.minor < 5) {
    return false;
  }
  return version.patch >= 1;
}

// Test 1: Direct screen invocation (current approach for TTY)
async function testDirectScreen(command) {
  console.log('\n=== Test 1: Direct screen invocation (TTY mode) ===');
  const sessionName = `test-direct-${Date.now()}`;
  const shell = process.env.SHELL || '/bin/sh';

  console.log(`Command: screen -S ${sessionName} ${shell} -c '${command}'`);
  console.log('Note: This approach loses output for quick commands');

  // This is what happens currently with TTY
  return new Promise((resolve) => {
    const child = spawn('screen', ['-S', sessionName, shell, '-c', command], {
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      console.log(`Exit code: ${code}`);
      resolve({ success: code === 0, output: '(output not captured)' });
    });

    child.on('error', (err) => {
      console.error(`Error: ${err.message}`);
      resolve({ success: false, output: '' });
    });
  });
}

// Test 2: Detached screen with log file (current approach for no-TTY)
async function testDetachedWithLog(command) {
  console.log('\n=== Test 2: Detached screen with log capture ===');
  const sessionName = `test-detached-${Date.now()}`;
  const shell = process.env.SHELL || '/bin/sh';
  const logFile = path.join(os.tmpdir(), `screen-test-${sessionName}.log`);

  const version = getScreenVersion();
  const useNativeLogging = supportsLogfileOption(version);

  console.log(`Screen version: ${version ? version.raw : 'unknown'}`);
  console.log(`Supports -Logfile: ${useNativeLogging}`);

  let screenArgs;
  let effectiveCommand = command;

  if (useNativeLogging) {
    // Modern screen
    screenArgs = [
      '-dmS',
      sessionName,
      '-L',
      '-Logfile',
      logFile,
      shell,
      '-c',
      command,
    ];
  } else {
    // Older screen - use tee fallback
    effectiveCommand = `(${command}) 2>&1 | tee "${logFile}"`;
    screenArgs = ['-dmS', sessionName, shell, '-c', effectiveCommand];
  }

  console.log(`Command: screen ${screenArgs.join(' ')}`);

  return new Promise((resolve) => {
    try {
      const result = spawnSync('screen', screenArgs, { stdio: 'inherit' });

      if (result.error) {
        console.error(`Error: ${result.error.message}`);
        resolve({ success: false, output: '' });
        return;
      }

      // Poll for session completion
      const checkInterval = 100;
      const maxWait = 10000;
      let waited = 0;

      const checkCompletion = () => {
        try {
          const sessions = execSync('screen -ls', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          if (!sessions.includes(sessionName)) {
            // Session ended
            let output = '';
            try {
              output = fs.readFileSync(logFile, 'utf8');
              console.log(`Captured output: "${output.trim()}"`);
              fs.unlinkSync(logFile);
            } catch {
              console.log('Log file not found or empty');
            }
            resolve({ success: true, output });
            return;
          }

          waited += checkInterval;
          if (waited >= maxWait) {
            resolve({ success: false, output: 'timeout' });
            return;
          }

          setTimeout(checkCompletion, checkInterval);
        } catch {
          let output = '';
          try {
            output = fs.readFileSync(logFile, 'utf8');
            console.log(`Captured output: "${output.trim()}"`);
            fs.unlinkSync(logFile);
          } catch {
            // Ignore
          }
          resolve({ success: true, output });
        }
      };

      setTimeout(checkCompletion, checkInterval);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      resolve({ success: false, output: '' });
    }
  });
}

// Test 3: Script command for output capture (alternative approach)
async function testScriptCapture(command) {
  console.log('\n=== Test 3: Using script command for output capture ===');
  const logFile = path.join(os.tmpdir(), `script-test-${Date.now()}.log`);
  const shell = process.env.SHELL || '/bin/sh';

  // Use 'script' command which is available on both macOS and Linux
  // script -q logfile command  (macOS/BSD)
  // script -q -c command logfile (Linux)
  const isMac = process.platform === 'darwin';

  let scriptArgs;
  if (isMac) {
    scriptArgs = ['-q', logFile, shell, '-c', command];
  } else {
    scriptArgs = ['-q', '-c', `${shell} -c '${command}'`, logFile];
  }

  console.log(`Command: script ${scriptArgs.join(' ')}`);

  return new Promise((resolve) => {
    const child = spawn('script', scriptArgs, {
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      let output = '';
      try {
        output = fs.readFileSync(logFile, 'utf8');
        console.log(`Captured output: "${output.trim()}"`);
        fs.unlinkSync(logFile);
      } catch {
        console.log('Log file not found');
      }
      resolve({ success: code === 0, output });
    });

    child.on('error', (err) => {
      console.error(`Error: ${err.message}`);
      resolve({ success: false, output: '' });
    });
  });
}

// Main
async function main() {
  console.log('Screen Output Capture Experiment');
  console.log('=================================');
  console.log(`Platform: ${process.platform}`);
  console.log(
    `TTY: stdin=${process.stdin.isTTY}, stdout=${process.stdout.isTTY}`
  );

  if (!isScreenAvailable()) {
    console.log('Screen is not installed. Exiting.');
    return;
  }

  const version = getScreenVersion();
  console.log(`Screen version: ${version ? version.raw : 'unknown'}`);

  const testCommand = 'echo "hello from screen"';

  // Test 2 is the recommended approach
  const result = await testDetachedWithLog(testCommand);
  console.log('\n=== Summary ===');
  console.log(
    `Test 2 (detached with log): Success=${result.success}, Output captured=${result.output.includes('hello')}`
  );
}

main().catch(console.error);
