/** A dead launcher leaves a usable reservation, rather than a permanent gate. */
const os = require('os');

function markLaunch(record) {
  record.options.launchPending = true;
  record.options.launchOwner = { pid: process.pid, hostname: os.hostname() };
}

function hasActiveLaunch(record) {
  if (!record?.options?.launchPending) {
    return false;
  }
  const owner = record.options.launchOwner;
  if (!owner || owner.hostname !== os.hostname()) {
    return true;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

module.exports = { markLaunch, hasActiveLaunch };
