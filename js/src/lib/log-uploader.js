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

function isCommandFile(filePath) {
  if (process.platform === 'win32') {
    return fs.existsSync(filePath);
  }

  return isExecutable(filePath);
}

function getPathCommandNames(commandName) {
  if (process.platform !== 'win32' || path.extname(commandName)) {
    return [commandName];
  }

  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);

  return [commandName, ...extensions.map((ext) => `${commandName}${ext}`)];
}

function resolveCommandFromPath(commandName) {
  const pathValue = process.env.PATH || '';
  for (const pathEntry of pathValue.split(path.delimiter)) {
    if (!pathEntry) {
      continue;
    }

    const directory = pathEntry.replace(/^"|"$/g, '');
    for (const candidateName of getPathCommandNames(commandName)) {
      const candidate = path.join(directory, candidateName);
      if (isCommandFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolveCommand(commandName) {
  const isWindows = process.platform === 'win32';
  const lookupCommand = isWindows ? 'where' : 'which';
  const pathMatch = resolveCommandFromPath(commandName);
  if (pathMatch) {
    return pathMatch;
  }

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

function shouldRunThroughShell(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    ...options,
    shell: shouldRunThroughShell(command),
  });
}

function runInstall(command, displayName, args) {
  console.log(
    `gh-upload-log not found; installing with: ${displayName} ${args.join(' ')}`
  );
  const result = runCommand(command, args, { stdio: 'inherit' });
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
    const installer = resolveCommand(command);
    if (!installer) {
      continue;
    }
    if (runInstall(installer, command, args)) {
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

  const result = runCommand(availability.command, [logPath], {
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
