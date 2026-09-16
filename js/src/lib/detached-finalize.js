/**
 * Detached completion finalizer (issue #170)
 *
 * A detached Docker session outlives the CLI process that started it: the
 * foreground `start` invocation returns as soon as the container is up, so
 * nobody is left to write the terminal state back into the execution store.
 * The record therefore stayed `executing` forever, with `exitCode: null` and
 * `endTime: null`, and every `--status` query had to re-derive the outcome from
 * scratch — fabricating `endTime` with `new Date()` in the process.
 *
 * The detached completion watcher (see `docker-cleanup.js`) now re-invokes this
 * module once the container is gone, handing over the facts it already read out
 * of a single `docker inspect`. This module is deliberately tiny and
 * dependency-light: it is executed as a short-lived child process on a host
 * whose CLI invocation is long gone, so it must never throw and never block.
 */

const path = require('path');

const {
  SHELL_VARS,
  describeExitCode,
  normalizeDockerTimestamp,
} = require('./docker-post-mortem');
const { shellQuote } = require('./isolation-log-utils');

/** Provenance markers for `endTime` (issue #170.2). */
const END_TIME_SOURCE = {
  /** `docker inspect .State.FinishedAt` — the container's own clock. */
  DOCKER_FINISHED_AT: 'docker-finished-at',
  /** The anchored `Finished:` line `start` itself wrote into the log. */
  LOG_FOOTER: 'log-footer',
  /** No real finish time exists: this is when the end was *observed*. */
  OBSERVED_AT: 'observed-at',
};

/**
 * Persist the terminal state of a detached execution.
 *
 * Purely additive with respect to the observation-vs-verdict discipline of
 * issues #148/#151/#162: `oomKilled` and `exitReason` are recorded as facts
 * next to the exit code, never as a substitute for it.
 *
 * @param {Object} options - Finalization input
 * @param {Object} options.store - An `ExecutionStore`
 * @param {string} options.executionId - UUID (or session name) of the record
 * @param {number|string|null} [options.exitCode] - `.State.ExitCode`
 * @param {boolean|string|null} [options.oomKilled] - `.State.OOMKilled`
 * @param {string|null} [options.startedAt] - `.State.StartedAt`
 * @param {string|null} [options.finishedAt] - `.State.FinishedAt`
 * @param {string|null} [options.containerError] - `.State.Error`
 * @returns {{updated: boolean, reason?: string, record?: Object}} Outcome
 */
function finalizeDetachedExecution(options = {}) {
  const { store, executionId } = options;
  if (!store || !executionId) {
    return { updated: false, reason: 'missing-arguments' };
  }

  let record;
  try {
    record = store.get(executionId);
  } catch {
    return { updated: false, reason: 'store-unreadable' };
  }
  if (!record) {
    return { updated: false, reason: 'record-not-found' };
  }
  if (record.status === 'executed' && record.endTime) {
    // Already finalized (e.g. a `--status` query got there first, or the
    // watcher ran twice after a resume). Nothing to correct.
    return { updated: false, reason: 'already-final', record };
  }

  const described = describeExitCode(options.exitCode);
  record.status = 'executed';
  if (described.code !== null) {
    record.exitCode = described.code;
  } else if (record.exitCode === null || record.exitCode === undefined) {
    record.exitCode = -1;
  }

  const finishedAt = normalizeDockerTimestamp(options.finishedAt);
  if (finishedAt) {
    record.endTime = new Date(finishedAt).toISOString();
    record.endTimeSource = END_TIME_SOURCE.DOCKER_FINISHED_AT;
  } else {
    // Docker has no finish time for this container (it never started, or it
    // was removed before we could look). Record *when we noticed*, and say so,
    // rather than passing observation time off as a finish time (issue #170.2).
    record.endTime = new Date().toISOString();
    record.endTimeSource = END_TIME_SOURCE.OBSERVED_AT;
    record.observedAt = record.endTime;
  }

  const startedAt = normalizeDockerTimestamp(options.startedAt);
  if (startedAt) {
    record.containerStartedAt = startedAt;
  }

  const oomKilled = normalizeBoolean(options.oomKilled);
  if (oomKilled !== null) {
    record.oomKilled = oomKilled;
  }

  const exitReason = resolveReason(record);
  if (exitReason) {
    record.exitReason = exitReason;
  }

  const containerError = normalizeContainerError(options.containerError);
  if (containerError) {
    record.options = { ...(record.options || {}), containerError };
  }

  try {
    store.save(record);
  } catch (err) {
    return { updated: false, reason: `save-failed: ${err.message}`, record };
  }
  return { updated: true, record };
}

/**
 * Derive the `exitReason` hint from the same evidence `--status` would use.
 * Kept in a helper so a failure to read the log never aborts finalization.
 * @param {Object} record - Execution record being finalized
 * @returns {string|null} Reason hint, or null
 */
function resolveReason(record) {
  try {
    const { resolveExitReason } = require('./exit-reason');
    const {
      FATAL_MARKER_TAIL_BYTES,
      readLogTail,
    } = require('./isolation-log-utils');
    const logTail = record.logPath
      ? readLogTail(record.logPath, FATAL_MARKER_TAIL_BYTES)
      : null;
    return resolveExitReason({
      exitCode: record.exitCode,
      logTail,
      oomKilled: record.oomKilled,
    });
  } catch {
    return null;
  }
}

/**
 * @param {boolean|string|null|undefined} value - Raw shell-provided flag
 * @returns {boolean|null} Parsed flag, or null when it carries no information
 */
function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return null;
}

/**
 * @param {string|null|undefined} value - Raw `.State.Error`
 * @returns {string|null} Error text, or null when docker reported none
 */
function normalizeContainerError(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '<no value>' || trimmed === '(none)') {
    return null;
  }
  return trimmed;
}

/**
 * Reconcile an in-memory record with one the detached watcher already
 * finalized.
 *
 * A container that exits almost immediately can be finalized by the watcher
 * before the foreground `start` invocation writes its own last update. Saving
 * the stale in-memory copy would resurrect `status: executing` and throw the
 * terminal facts away, so the stored record wins and only the fields the
 * foreground process learned (its `options`, e.g. `containerId`) are merged in.
 *
 * @param {Object} store - An `ExecutionStore`
 * @param {Object} record - The in-memory record about to be saved
 * @returns {Object} The record to save
 */
function reconcileFinalizedRecord(store, record) {
  try {
    const stored = store.get(record.uuid);
    if (!stored || stored.status !== 'executed' || !stored.endTime) {
      return record;
    }
    stored.options = { ...(stored.options || {}), ...(record.options || {}) };
    return stored;
  } catch {
    return record;
  }
}

/**
 * Shell fragment that hands the inspected docker facts to this module.
 *
 * Runs with the same runtime that started the session, inherits
 * `START_APP_FOLDER`/`START_DISABLE_TRACKING` from the detached watcher, and is
 * suffixed with `|| true` so a finalization failure can never abort the
 * watcher's remaining cleanup work.
 *
 * @param {string} executionId - UUID of the record to finalize
 * @returns {string} POSIX shell fragment
 */
function buildDetachedFinalizeSnippet(executionId) {
  const v = SHELL_VARS;
  return (
    `${shellQuote(process.execPath)} ${shellQuote(__filename)} ` +
    `${shellQuote(executionId)} "$${v.exit}" "$${v.oom}" ` +
    `"$${v.started}" "$${v.finished}" "$${v.error}" ` +
    `>/dev/null 2>&1 || true`
  );
}

/**
 * Entry point used by the detached watcher:
 *   <runtime> detached-finalize.js <uuid> <exit> <oom> <started> <finished> <error>
 * Always exits 0 — a bookkeeping failure must never turn into a visible error
 * in a log the user is reading for the command's own output.
 * @param {string[]} argv - Positional arguments
 * @returns {void}
 */
function main(argv) {
  const [
    executionId,
    exitCode,
    oomKilled,
    startedAt,
    finishedAt,
    containerError,
  ] = argv;
  if (!executionId || process.env.START_DISABLE_TRACKING === 'true') {
    return;
  }
  try {
    const { ExecutionStore } = require('./execution-store');
    const store = new ExecutionStore(
      process.env.START_APP_FOLDER
        ? { appFolder: path.resolve(process.env.START_APP_FOLDER) }
        : {}
    );
    finalizeDetachedExecution({
      store,
      executionId,
      exitCode,
      oomKilled,
      startedAt,
      finishedAt,
      containerError,
    });
  } catch {
    // Deliberately silent: see the exit-0 contract above.
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  END_TIME_SOURCE,
  buildDetachedFinalizeSnippet,
  finalizeDetachedExecution,
  main,
  reconcileFinalizedRecord,
};
