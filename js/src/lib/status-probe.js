/**
 * Live docker state of a detached execution, for `--status` and `--list`.
 *
 * Split out of `status-formatter` (as `status_probe.rs` is in Rust) so the
 * probing stays separate from the rendering and both files stay under the
 * repository line budget (issue #243).
 */

const { getDockerCommand, getDockerSpawnOptions } = require('./docker-cleanup');
const { normalizeDockerTimestamp } = require('./docker-post-mortem');
const {
  CONTAINER_STATE_REMOVED,
  dockerInspect,
} = require('./container-removal');

/**
 * Inspect the live state of a detached docker container by name.
 *
 * Distinguishes three outcomes that matter for status reporting:
 * - the container exists and is running,
 * - the container exists but has stopped (with a real exit code), and
 * - the container cannot be inspected at all.
 *
 * The last case is crucial on slow Docker-in-Docker hosts (issue #136): right
 * after `docker run -d` returns, `docker inspect <name>` can transiently fail
 * because the container is not visible yet. A failed inspect must NOT be read
 * as "stopped"; it means "unknown", so callers can keep the session running
 * instead of fabricating a terminal `-1` result.
 *
 * @param {string} sessionName - Container name
 * @param {Object|null} [probe] - Receives `sessionNotFound` (issue #225)
 * @returns {{running: boolean, exitCode: number|null, oomKilled: boolean|null}|null} State,
 *   or null when the container cannot be inspected (not found yet, removed, or docker error)
 */
function inspectDockerState(sessionName, probe = null) {
  const { stdout, notFound } = dockerInspect(
    getDockerCommand(),
    dockerProbeSpawnOptions(),
    '{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}} ' +
      '{{.State.StartedAt}} {{.State.FinishedAt}}',
    sessionName
  );
  if (probe) {
    // "No such container" is a fact, unlike a docker that cannot be reached
    // (issue #225); it still reads as unknown liveness here (issue #136).
    probe.sessionNotFound = notFound;
  }
  if (stdout === null) {
    return null;
  }
  // Parsed positionally and defensively: an older docker (or a stubbed one)
  // may answer with fewer fields than the template asks for.
  const [runningRaw, exitRaw, oomKilledRaw, startedRaw, finishedRaw] = stdout
    .trim()
    .split(/\s+/);
  const exitCode = Number.parseInt(exitRaw, 10);
  return {
    running: runningRaw === 'true',
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    oomKilled:
      oomKilledRaw === 'true' ? true : oomKilledRaw === 'false' ? false : null,
    startedAt: normalizeDockerTimestamp(startedRaw),
    finishedAt: normalizeDockerTimestamp(finishedRaw),
  };
}

function isDetachedDockerRecord(record) {
  const opts = record.options || {};
  return (
    opts.isolated === 'docker' &&
    opts.isolationMode === 'detached' &&
    Boolean(opts.sessionName)
  );
}

function dockerProbeSpawnOptions() {
  return getDockerSpawnOptions({
    encoding: 'utf8',
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function readDockerState(record, probe = null) {
  const opts = record.options || {};
  if (opts.isolated !== 'docker' || !opts.sessionName) {
    return null;
  }
  if (record.containerState === CONTAINER_STATE_REMOVED) {
    // A removed container stays removed: a relaunch clears the marker, so
    // there is nothing left to ask Docker (issue #243).
    return null;
  }
  const state = inspectDockerState(opts.sessionName, probe);
  if (
    record.attempt &&
    state?.startedAt &&
    Date.parse(state.startedAt) < Date.parse(record.attempt.startedAt)
  ) {
    return null;
  }
  return state;
}

/**
 * Best-effort terminal exit code reported by the isolation backend itself
 * (currently docker via `docker inspect .State.ExitCode`). Returns null when
 * the backend cannot provide a real code, so callers never surface the `-1`
 * sentinel for a session whose real exit code is simply not available yet.
 * A running container has no terminal exit code (docker reports `0` for it),
 * so only a stopped container contributes one.
 * @param {{running: boolean, exitCode: number|null}|null} dockerState - Inspected state
 * @returns {number|null}
 */
function backendExitCode(dockerState) {
  return dockerState && !dockerState.running ? dockerState.exitCode : null;
}

/**
 * Reconcile the OOM observation from the stored record and from `docker inspect`.
 *
 * `State.OOMKilled` is a container-cgroup flag: the kernel sets it when ANY
 * process in the cgroup is OOM-killed and it is never cleared for the life of
 * the container (moby/moby#47618). It is therefore an *observation*, never a
 * verdict about the session (issue #151) — a container that lost one child
 * process keeps running and can still exit `0`. Once observed, the flag stays
 * `true` for the record.
 * @param {Object} record - Execution record
 * @param {{oomKilled: boolean|null}|null} dockerState - Inspected state
 * @returns {boolean|undefined} Observation, or undefined when nothing is known
 */
function resolveOomObservation(record, dockerState) {
  if (record.oomKilled === true || dockerState?.oomKilled === true) {
    return true;
  }
  if (record.oomKilled === false || dockerState?.oomKilled === false) {
    return false;
  }
  return undefined;
}

module.exports = {
  backendExitCode,
  dockerProbeSpawnOptions,
  inspectDockerState,
  isDetachedDockerRecord,
  readDockerState,
  resolveOomObservation,
};
