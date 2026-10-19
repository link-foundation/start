/**
 * Removed-container bookkeeping for `--status` (issue #225).
 *
 * A kept docker container can be removed later (by hand, by an orchestrator,
 * or by start-command's own cleanup policy). `docker inspect` then exits 1
 * with `No such object` / `No such container`, which used to be folded into
 * the same `null` as "docker could not be queried at all", so `--status` kept
 * reporting the old `containerId` as if the container still held its disk.
 *
 * This module tells the two failures apart and records the removal on the
 * execution record as `containerState: removed` plus
 * `containerRemovedObservedAt`. `containerId` is kept for history.
 */

const { spawnSync } = require('child_process');

/** `containerState` of a record whose container no longer exists. */
const CONTAINER_STATE_REMOVED = 'removed';

/**
 * Docker's answer for a container that does not exist:
 * `Error: No such object: <name>` (`docker inspect`, Docker 29 prints it
 * lower-case) and `Error response from daemon: No such container: <name>`
 * (`docker container inspect`). A daemon that cannot be reached prints
 * "Cannot connect" / "failed to connect", which must not match.
 */
const DOCKER_NOT_FOUND_PATTERN = /no such (object|container)/i;

/**
 * Environment variable the detached watcher sets for the finalizer when its
 * own `docker rm -f` removed the container.
 */
const CONTAINER_REMOVED_ENV = 'START_INTERNAL_CONTAINER_REMOVED';

/**
 * @param {{status?: number|null, stderr?: string|Buffer, error?: Error}} result
 *   `spawnSync` result of a `docker inspect`
 * @returns {boolean} True only when docker answered that the object is unknown
 */
function isDockerNotFound(result) {
  if (!result || result.error || result.status === 0) {
    return false;
  }
  return DOCKER_NOT_FOUND_PATTERN.test(String(result.stderr || ''));
}

/**
 * Run `docker inspect -f <format> <target>`.
 * @returns {{stdout: string|null, notFound: boolean}} `stdout` is null when
 *   the inspect failed; `notFound` says the failure was "no such container"
 */
function dockerInspect(dockerCommand, spawnOptions, format, target) {
  const result = spawnSync(
    dockerCommand,
    ['inspect', '-f', format, target],
    spawnOptions
  );
  if (result.error || result.status !== 0 || !result.stdout) {
    return { stdout: null, notFound: isDockerNotFound(result) };
  }
  return { stdout: String(result.stdout), notFound: false };
}

/**
 * Set `containerState: removed` on a record, keeping an earlier observation
 * time when there is one.
 * @param {Object} record - Execution record (mutated)
 * @param {string} [observedAt] - When the removal was observed
 * @returns {Object} The same record
 */
function markContainerRemoved(record, observedAt = new Date().toISOString()) {
  record.containerState = CONTAINER_STATE_REMOVED;
  record.containerRemovedObservedAt =
    record.containerRemovedObservedAt || observedAt;
  return record;
}

/**
 * Whether a finished detached docker record should be checked for removal.
 * Executing records are never touched: a container that is not visible yet
 * on a slow Docker-in-Docker host is not a removed one (issue #136).
 */
function shouldProbeRemoval(record) {
  const opts = (record && record.options) || {};
  return (
    record.status === 'executed' &&
    opts.isolated === 'docker' &&
    opts.isolationMode === 'detached' &&
    Boolean(opts.sessionName || opts.containerId) &&
    record.containerState !== CONTAINER_STATE_REMOVED
  );
}

/**
 * Attach `containerState: removed` to a finished detached docker record whose
 * container no longer exists. The container id is preferred over the session
 * name, so a later container that reuses the name is not mistaken for it.
 *
 * @param {Object} record - Enriched execution record
 * @param {{dockerCommand: string, spawnOptions: Object,
 *   sessionNotFound?: boolean}} probe - How to run docker, and whether the
 *   status probe by session name already answered "no such container"
 * @returns {Object} The record, or a copy carrying the removal
 */
function attachContainerRemoval(record, probe) {
  if (!shouldProbeRemoval(record)) {
    return record;
  }
  const containerId = record.options.containerId;
  const notFound = containerId
    ? dockerInspect(
        probe.dockerCommand,
        probe.spawnOptions,
        '{{.Id}}',
        containerId
      ).notFound
    : probe.sessionNotFound === true;
  if (!notFound) {
    return record;
  }
  const copy = Object.assign(
    Object.create(Object.getPrototypeOf(record)),
    record
  );
  return markContainerRemoved(copy);
}

/**
 * Persist a removal `--status` observed, best effort: a read-only query must
 * never fail because the store could not be written.
 * @param {Object} store - ExecutionStore
 * @param {Object} stored - Record as read from the store
 * @param {Object} enriched - Record as reported
 */
function persistContainerRemoval(store, stored, enriched) {
  if (
    !store ||
    enriched.containerState !== CONTAINER_STATE_REMOVED ||
    stored.containerState === CONTAINER_STATE_REMOVED ||
    typeof store.markContainerRemoved !== 'function'
  ) {
    return;
  }
  try {
    store.markContainerRemoved(
      stored.uuid,
      enriched.containerRemovedObservedAt
    );
  } catch {
    // The removal is still reported; it is simply observed again next time.
  }
}

module.exports = {
  CONTAINER_REMOVED_ENV,
  CONTAINER_STATE_REMOVED,
  DOCKER_NOT_FOUND_PATTERN,
  attachContainerRemoval,
  dockerInspect,
  isDockerNotFound,
  markContainerRemoved,
  persistContainerRemoval,
};
