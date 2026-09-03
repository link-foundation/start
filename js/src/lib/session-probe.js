/**
 * Session liveness probing for tracked executions.
 *
 * `--attach`, `--resume` and `--resume-all` all need the same question
 * answered first: is the isolation session behind this execution record still
 * alive, stopped but recoverable, or gone entirely? The probe never mutates
 * anything, so it is safe to run against every tracked record.
 */

const { runCommand } = require('./execution-control');
const { getDockerCommand } = require('./docker-cleanup');

/**
 * States a tracked isolation session can be observed in.
 * - RUNNING: the session/container is alive and can be attached to
 * - STOPPED: the container still exists but is not running (resumable)
 * - MISSING: no trace of the session/container remains
 * - UNKNOWN: the backend cannot be probed locally (e.g. ssh)
 */
const SessionState = {
  RUNNING: 'running',
  STOPPED: 'stopped',
  MISSING: 'missing',
  UNKNOWN: 'unknown',
};

/**
 * Map a `docker inspect -f {{.State.Status}}` value to a session state.
 * @param {?string} status - Docker container status
 * @returns {string} SessionState value
 */
function mapDockerStatusToState(status) {
  const normalized = String(status || '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return SessionState.UNKNOWN;
  }
  if (normalized === 'running' || normalized === 'restarting') {
    return SessionState.RUNNING;
  }
  return SessionState.STOPPED;
}

/**
 * Find a session in `screen -ls` output.
 * Session names are matched exactly against the `<pid>.<name>` column so a
 * prefix like "session" never matches "my-session".
 * @param {string} output - Combined stdout/stderr of `screen -ls`
 * @param {string} sessionName - Session name to look for
 * @returns {string} SessionState.RUNNING or SessionState.MISSING
 */
function parseScreenSessionState(output, sessionName) {
  for (const line of String(output || '').split('\n')) {
    const firstColumn = line.trim().split(/\s+/)[0] || '';
    const match = firstColumn.match(/^(\d+)\.(.+)$/);
    if (match && match[2] === sessionName) {
      return SessionState.RUNNING;
    }
  }
  return SessionState.MISSING;
}

/**
 * Probe the isolation session behind an execution record.
 * @param {object} record - Execution record
 * @param {function} runner - Command runner (injectable for tests)
 * @returns {{backend: ?string, sessionName: ?string, state: string, alive: boolean, containerStatus: ?string}}
 */
function probeSession(record, runner = runCommand) {
  const opts = (record && record.options) || {};
  const backend = opts.isolated || null;
  const sessionName = opts.sessionName || null;
  const probe = {
    backend,
    sessionName,
    state: SessionState.UNKNOWN,
    alive: false,
    containerStatus: null,
  };

  if (!sessionName || !backend) {
    return probe;
  }

  if (backend === 'docker') {
    const result = runner(getDockerCommand(), [
      'inspect',
      '-f',
      '{{.State.Status}}',
      sessionName,
    ]);
    if (!result.success) {
      probe.state = SessionState.MISSING;
      return probe;
    }
    probe.containerStatus = String(result.stdout || '').trim() || null;
    probe.state = mapDockerStatusToState(probe.containerStatus);
  } else if (backend === 'screen') {
    const result = runner('screen', ['-ls']);
    // `screen -ls` exits non-zero even when it lists sessions, so the output is
    // authoritative, not the exit status.
    probe.state = parseScreenSessionState(
      `${result.stdout || ''}${result.stderr || ''}`,
      sessionName
    );
  } else if (backend === 'tmux') {
    const result = runner('tmux', ['has-session', '-t', sessionName]);
    probe.state = result.success ? SessionState.RUNNING : SessionState.MISSING;
  }

  probe.alive = probe.state === SessionState.RUNNING;
  return probe;
}

module.exports = {
  SessionState,
  mapDockerStatusToState,
  parseScreenSessionState,
  probeSession,
};
