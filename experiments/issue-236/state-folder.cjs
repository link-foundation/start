// Remove a START_APP_FOLDER that detached background processes may still use.
//
// A detached launch leaves a completion watcher behind (`sh -c`, inheriting
// the CLI environment) that finalizes the execution record once the
// container is gone. Its writes are atomic: a `<file>.<pid>.<uuid>.tmp`
// appears next to the store and is renamed over it. One landing between the
// scan and the final rmdir of a recursive `fs.rmSync` fails it with ENOTEMPTY,
// which turned a passing smoke test red (issue #245 CI). So first wait, for a
// bounded time, until no process still has this folder as START_APP_FOLDER,
// then remove it, retrying the errors a late writer can still cause.
const fs = require('node:fs');
const path = require('node:path');

const RETRYABLE = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Pids (other than this process) whose environment names `folder`. */
function processesUsing(folder, procRoot = '/proc') {
  const needle = `START_APP_FOLDER=${folder}\0`;
  let entries;
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return [];
  }
  return entries
    .filter((pid) => /^\d+$/.test(pid) && Number(pid) !== process.pid)
    .filter((pid) => {
      try {
        const environ = fs.readFileSync(path.join(procRoot, pid, 'environ'));
        return `${environ.toString('latin1')}\0`.includes(needle);
      } catch {
        return false;
      }
    })
    .map(Number);
}

/** Wait until no other process uses `folder`; returns the pids still left. */
function waitUntilUnused(folder, { timeoutMs = 60000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let pids = processesUsing(folder);
  while (pids.length > 0 && Date.now() < deadline) {
    sleepMs(pollMs);
    pids = processesUsing(folder);
  }
  return pids;
}

function removeWithRetries(folder, { attempts = 20, delayMs = 100 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
      return attempt;
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE.has(error.code)) throw error;
      sleepMs(delayMs);
    }
  }
}

function removeStateFolder(folder, options = {}) {
  const lingering = waitUntilUnused(folder, options);
  if (lingering.length > 0)
    console.warn(
      `[cleanup] processes still using ${folder} after ${options.timeoutMs ?? 60000} ms: ${lingering.join(', ')}`
    );
  return removeWithRetries(folder, options);
}

module.exports = {
  processesUsing,
  waitUntilUnused,
  removeWithRetries,
  removeStateFolder,
};
