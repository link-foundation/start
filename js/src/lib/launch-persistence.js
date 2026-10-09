/** Reserve before launch, and identify/stop a launch whose final save failed. */
const { getDockerCommand } = require('./docker-cleanup');

function reserveLaunch(store, record, previous) {
  require('./launch-owner').markLaunch(record);
  if (typeof store.reserveLaunch === 'function') {
    store.reserveLaunch(record, previous);
  } else {
    store.save(record);
  }
}

function rollbackLaunch(store, previous) {
  try {
    store.save(previous);
  } catch {
    /* The durable reservation still names the session. */
  }
}

function failLaunchedPersistence(store, record, runner, error) {
  const name = record.options.sessionName;
  let stopped;
  try {
    stopped =
      record.options.isolated === 'docker'
        ? runner(getDockerCommand(), ['stop', name])
        : null;
  } catch {
    stopped = null;
  }
  const warning = {
    code: 'LAUNCH_PERSISTENCE_FAILED',
    uuid: record.uuid,
    containerName: name,
    running: !stopped?.success,
    error: error.message,
  };
  if (stopped?.success) {
    record.status = 'executed';
    record.exitCode = -1;
    record.endTime = new Date().toISOString();
    record.endTimeSource = 'observed-at';
    record.options.launchPending = false;
    try {
      store.save(record);
    } catch {
      /* Completion watcher remains attached. */
    }
  }
  return JSON.stringify(warning);
}

module.exports = { reserveLaunch, rollbackLaunch, failLaunchedPersistence };
