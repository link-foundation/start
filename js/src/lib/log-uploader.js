/**
 * Helpers for uploading stored execution logs as bounded, verified parts.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SanitizationError, sanitizeLogStream } = require('./log-sanitizer');
const { publishLogParts } = require('./log-upload-parts');

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

  return null;
}

async function uploadSource(source, options) {
  try {
    const url = await publishLogParts(sanitizeLogStream(source), options);
    return { success: true, exitCode: 0, url };
  } catch (error) {
    return {
      success: false,
      exitCode: 1,
      error:
        error instanceof SanitizationError || error.code === 'ERR_LOG_UPLOAD'
          ? error.message
          : 'Log preparation or upload failed; upload blocked.',
    };
  }
}

async function* openLog(logPath) {
  let handle;
  try {
    if (!(await fs.promises.stat(logPath)).isFile()) {
      throw new Error('Expected a regular file');
    }
    handle = await fs.promises.open(logPath, 'r');
    yield* handle.createReadStream({ autoClose: false });
  } catch {
    throw new SanitizationError('ERR_SOURCE');
  } finally {
    await handle?.close();
  }
}

async function uploadLogPath(logPath, options = {}) {
  if (!logPath) {
    return {
      success: false,
      error: 'Execution record does not have a log path.',
    };
  }
  try {
    await fs.promises.access(logPath, fs.constants.F_OK);
  } catch (error) {
    return {
      success: false,
      error:
        error.code === 'ENOENT'
          ? `Log file not found: ${logPath}`
          : new SanitizationError('ERR_SOURCE').message,
    };
  }
  return uploadSource(openLog(logPath), options);
}

async function uploadExecutionLog(store, identifier, options = {}) {
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

  // A continuation chain uploads every execution, oldest first (#231).
  const { buildChain, streamChainLog } = require('./execution-chain');
  const chain = buildChain(store.getAll(), record);
  return await (chain.length > 1
    ? uploadSource(streamChainLog(chain), options)
    : uploadLogPath(record.logPath, options));
}

module.exports = {
  resolveCommand,
  uploadExecutionLog,
  uploadLogPath,
};
