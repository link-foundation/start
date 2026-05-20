/**
 * Helpers for uploading stored execution logs with gh-upload-log.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCommand(commandName) {
  const isWindows = process.platform === 'win32';
  const lookupCommand = isWindows ? 'where' : 'which';

  try {
    const result = spawnSync(lookupCommand, [commandName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim().split(/\r?\n/)[0];
    }
  } catch {
    // Fall through to common locations.
  }

  if (!isWindows && commandName === 'gh-upload-log') {
    const bunGlobalPath = path.join(os.homedir(), '.bun', 'bin', commandName);
    if (isExecutable(bunGlobalPath)) {
      return bunGlobalPath;
    }
  }

  return null;
}

function runInstall(command, args) {
  console.log(
    `gh-upload-log not found; installing with: ${command} ${args.join(' ')}`
  );
  const result = spawnSync(command, args, { stdio: 'inherit' });
  return result.status === 0;
}

function ensureGhUploadLogAvailable() {
  const existing = resolveCommand('gh-upload-log');
  if (existing) {
    return { success: true, command: existing };
  }

  const installers = [
    ['bun', ['install', '-g', 'gh-upload-log']],
    ['npm', ['install', '-g', 'gh-upload-log']],
  ];

  for (const [command, args] of installers) {
    if (!resolveCommand(command)) {
      continue;
    }
    if (runInstall(command, args)) {
      const installed = resolveCommand('gh-upload-log');
      if (installed) {
        return { success: true, command: installed };
      }
    }
  }

  return {
    success: false,
    error:
      'gh-upload-log is not installed and automatic installation did not make it available on PATH.',
  };
}

function uploadLogPath(logPath) {
  if (!logPath) {
    return {
      success: false,
      error: 'Execution record does not have a log path.',
    };
  }
  if (!fs.existsSync(logPath)) {
    return { success: false, error: `Log file not found: ${logPath}` };
  }

  const availability = ensureGhUploadLogAvailable();
  if (!availability.success) {
    return availability;
  }

  const result = spawnSync(availability.command, [logPath], {
    stdio: 'inherit',
  });

  const exitCode =
    result.status !== null && result.status !== undefined ? result.status : 1;
  if (exitCode !== 0) {
    return {
      success: false,
      exitCode,
      error: `gh-upload-log exited with code ${exitCode}`,
    };
  }

  return { success: true, exitCode: 0 };
}

function uploadExecutionLog(store, identifier) {
  if (!store) {
    return { success: false, error: 'Execution tracking is disabled.' };
  }

  const record = store.get(identifier);
  if (!record) {
    return {
      success: false,
      error: `No execution found with UUID or session name: ${identifier}`,
    };
  }

  return uploadLogPath(record.logPath);
}

module.exports = {
  ensureGhUploadLogAvailable,
  resolveCommand,
  uploadExecutionLog,
  uploadLogPath,
};
