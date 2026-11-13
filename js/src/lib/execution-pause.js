/**
 * `$ --pause <id>` and `$ --unpause <id>` (issue #263): freeze and thaw a
 * detached Docker execution with the cgroup freezer.
 *
 * `docker pause` stops every process of the container from being scheduled,
 * so CPU is released, while the processes, their memory, the container, its
 * workspace and its log all stay exactly where they are. `docker unpause`
 * continues the very same processes: there is no new container, command,
 * snapshot, execution or recovery attempt. To get the memory back, `--stop`
 * the execution instead.
 *
 * Only Docker can freeze a session; screen and tmux are refused. The pause is
 * recorded on the execution as `options.paused`, `pausedAt`, `pauseCount` and
 * the optional `pausedBy` / `pauseReason`, but Docker stays the source of
 * truth: `--status`, `--list` and the controls reconcile a stale record from
 * `docker inspect` (after a daemon restart, a reboot or a removal), so a stale
 * `paused: true` can never hide a task.
 */

const { getDockerCommand } = require('./docker-cleanup');
const {
  escapeForLinksNotation,
  formatAsNestedLinksNotation,
} = require('./output-blocks');
const { collectProcessIds, runCommand } = require('./execution-control');

const PauseAction = {
  PAUSE: 'pause',
  UNPAUSE: 'unpause',
};

/** Bound for every docker call made here, so a hung daemon cannot hang us. */
const DOCKER_PAUSE_TIMEOUT_MS = 30000;

/** `docker inspect` template answering both the status and the freezer flag. */
const PAUSE_STATE_FORMAT = '{{.State.Status}} {{.State.Paused}}';

/** Docker states an execution can be reported in (plus `removed`/`unknown`). */
const DockerState = {
  RUNNING: 'running',
  PAUSED: 'paused',
  EXITED: 'exited',
  CREATED: 'created',
  REMOVED: 'removed',
  UNKNOWN: 'unknown',
};

/** Pause bookkeeping kept in `options`; cleared when the pause ends. */
const PAUSE_FIELDS = ['pausedAt', 'pausedBy', 'pauseReason'];

const NOT_FOUND_PATTERN = /no such (object|container)/i;

/** What a pause does to the container's resources, for callers' accounting. */
const PAUSED_RESOURCES = {
  cpu: 'released',
  memory: 'retained',
  disk: 'retained',
};

function failureDetail(result) {
  return (
    String(result?.stderr || '').trim() ||
    result?.error ||
    `exit code ${result?.status}`
  );
}

/**
 * Parse `docker inspect -f '{{.State.Status}} {{.State.Paused}}'` output.
 * @param {string} stdout - Inspect output
 * @returns {{state: string, paused: boolean}} Docker state
 */
function parsePauseState(stdout) {
  const [statusRaw, pausedRaw] = String(stdout || '')
    .trim()
    .split(/\s+/);
  const state = String(statusRaw || '').toLowerCase() || DockerState.UNKNOWN;
  const paused = pausedRaw === 'true' || state === DockerState.PAUSED;
  return { state: paused ? DockerState.PAUSED : state, paused };
}

/**
 * Ask Docker for the real state of a container.
 * @param {string} containerName - Container name or id
 * @param {Function} [runner] - Command runner (injectable for tests)
 * @returns {{state: string, paused: boolean, detail?: string}} `removed` when
 *   Docker answers "no such container", `unknown` when it cannot be asked
 */
function inspectPauseState(containerName, runner = runCommand) {
  const result = runner(
    getDockerCommand(),
    ['inspect', '-f', PAUSE_STATE_FORMAT, containerName],
    { timeout: DOCKER_PAUSE_TIMEOUT_MS }
  );
  if (result.success) {
    return parsePauseState(result.stdout);
  }
  const detail = failureDetail(result);
  if (!result.error && NOT_FOUND_PATTERN.test(detail)) {
    return { state: DockerState.REMOVED, paused: false };
  }
  return { state: DockerState.UNKNOWN, paused: false, detail };
}

/**
 * Whether a record is a detached Docker execution that Docker confirms is
 * paused right now. A stale `options.paused` alone never counts.
 * @param {object} record - Execution record
 * @param {Function} [runner] - Command runner
 * @returns {boolean} True only when `docker inspect` reports it paused
 */
function isConfirmedPaused(record, runner = runCommand) {
  const opts = (record && record.options) || {};
  if (
    opts.isolated !== 'docker' ||
    opts.isolationMode !== 'detached' ||
    !opts.sessionName ||
    record.containerState === DockerState.REMOVED
  ) {
    return false;
  }
  return inspectPauseState(opts.sessionName, runner).paused;
}

/**
 * Options of a record whose pause just ended.
 * @param {object} options - Current options
 * @param {string} endedBy - unpause, stop, terminate or reconcile
 * @param {string} [at] - When the pause ended
 * @returns {object} New options (the input is not mutated)
 */
function clearedPauseOptions(options, endedBy, at = new Date().toISOString()) {
  const next = { ...(options || {}) };
  for (const field of PAUSE_FIELDS) {
    delete next[field];
  }
  next.paused = false;
  next.unpausedAt = at;
  next.pauseEndedBy = endedBy;
  return next;
}

/**
 * Options of a record that was just paused.
 * @param {object} options - Current options
 * @param {{reason?: ?string, by?: ?string, at?: string}} details - Who and why
 * @returns {object} New options (the input is not mutated)
 */
function pausedOptions(options, details = {}) {
  const next = { ...(options || {}) };
  delete next.unpausedAt;
  delete next.pauseEndedBy;
  delete next.pausedBy;
  delete next.pauseReason;
  next.paused = true;
  next.pausedAt = details.at || new Date().toISOString();
  next.pauseCount = (Number(next.pauseCount) || 0) + 1;
  if (details.by) {
    next.pausedBy = details.by;
  }
  if (details.reason) {
    next.pauseReason = details.reason;
  }
  return next;
}

/**
 * Re-read the record and save new options on it, best effort for
 * reconciliation and strict for the pause/unpause transitions themselves.
 * @returns {object} The saved record
 */
function saveOptions(store, record, update, strict = true) {
  let current = record;
  try {
    current = store.get(record.uuid) || record;
  } catch {
    // Fall back to the record we already have.
  }
  current.options = update(current.options || {});
  try {
    store.save(current);
  } catch (error) {
    if (strict) {
      throw error;
    }
  }
  return current;
}

/**
 * Forget a pause that Docker no longer confirms (issue #263): a container that
 * was stopped, removed, restarted by the daemon or thawed by hand.
 * @returns {object} The (possibly updated) record
 */
function reconcileStalePause(store, record, endedBy = 'reconcile') {
  if (!store || !record.options || record.options.paused !== true) {
    return record;
  }
  return saveOptions(
    store,
    record,
    (options) => clearedPauseOptions(options, endedBy),
    false
  );
}

/**
 * End the recorded pause of an execution that `--stop` / `--terminate` just
 * ended (issue #263). No-op when it was not paused.
 * @param {object} store - Execution store
 * @param {object} record - Execution record
 * @param {string} action - stop or terminate
 */
function clearPauseAfterControl(store, record, action) {
  if (record?.options?.paused === true) {
    reconcileStalePause(store, record, action);
  }
}

/**
 * Validate that an execution can be paused/unpaused at all.
 * @returns {{record?: object, error?: string}} Record, or the refusal
 */
function resolvePauseTarget(store, identifier, action) {
  if (!store) {
    return { error: 'Execution tracking is disabled.' };
  }
  const record = store.get(identifier);
  if (!record) {
    return {
      error: `No execution found with UUID or session name: ${identifier}`,
    };
  }
  const opts = record.options || {};
  if (opts.isolated !== 'docker') {
    return {
      error:
        `--${action} only supports Docker isolation: ${identifier} uses ${opts.isolated || 'no isolation'}. ` +
        'screen and tmux sessions cannot be frozen; use --stop or --terminate instead.',
    };
  }
  if (!opts.sessionName) {
    return {
      error: 'Execution record does not contain an isolation session name.',
    };
  }
  if (opts.isolationMode !== 'detached') {
    return {
      error: `Only detached Docker executions can be ${action}d.`,
    };
  }
  return { record };
}

function notPausableError(action, identifier, record, dockerState) {
  const name = record.options.sessionName;
  const what =
    dockerState.state === DockerState.REMOVED
      ? 'no longer exists (removed)'
      : `is ${dockerState.state}, not ${action === PauseAction.PAUSE ? 'running' : 'paused'}`;
  return (
    `Cannot ${action} ${identifier}: container "${name}" ${what}. ` +
    `Use \`$ --status ${record.uuid}\` to inspect it, or \`$ --resume ${record.uuid}\` to continue it.`
  );
}

/**
 * Report of one pause/unpause, in every output format.
 * @param {object} result - {action, identifier, status, record, method,
 *   dockerState, processIds, message}
 * @returns {object} Plain report object
 */
function buildPauseReport(result) {
  const opts = result.record.options || {};
  const report = {
    action: result.action,
    identifier: result.identifier,
    uuid: result.record.uuid,
    status: result.status,
    backend: opts.isolated,
    sessionName: opts.sessionName,
    method: result.method,
    dockerState: result.dockerState,
    paused: result.dockerState === DockerState.PAUSED,
  };
  if (report.paused) {
    report.pausedAt = opts.pausedAt || null;
    report.pauseCount = Number(opts.pauseCount) || 0;
    if (opts.pausedBy) {
      report.pausedBy = opts.pausedBy;
    }
    if (opts.pauseReason) {
      report.pauseReason = opts.pauseReason;
    }
    report.resources = { ...PAUSED_RESOURCES };
  } else if (opts.unpausedAt) {
    report.unpausedAt = opts.unpausedAt;
  }
  if (result.processIds) {
    report.processIds = result.processIds;
  }
  report.message = result.message;
  return report;
}

function formatPauseReportAsLinksNotation(report) {
  const lines = ['executionControl'];
  for (const [key, value] of Object.entries(report)) {
    if (value !== null && typeof value === 'object') {
      lines.push(`  ${key}`);
      lines.push(formatAsNestedLinksNotation(value, 2, 2));
    } else {
      lines.push(`  ${key} ${escapeForLinksNotation(value)}`);
    }
  }
  return lines.join('\n');
}

function formatPauseReportAsText(report) {
  const lines = [
    report.message,
    `UUID:          ${report.uuid}`,
    `Container:     ${report.sessionName}`,
    `Docker State:  ${report.dockerState}`,
    `Paused:        ${report.paused}`,
  ];
  if (report.paused) {
    lines.push(`Paused At:     ${report.pausedAt || 'N/A'}`);
    lines.push(`Pause Count:   ${report.pauseCount}`);
    lines.push(
      `Resources:     CPU ${report.resources.cpu}, memory ${report.resources.memory}, disk ${report.resources.disk}`
    );
  }
  if (report.processIds?.containerPid) {
    lines.push(`Container PID: ${report.processIds.containerPid}`);
  }
  return lines.join('\n');
}

/**
 * Render a pause/unpause report.
 * @param {object} report - From `buildPauseReport`
 * @param {?string} outputFormat - links-notation (default), json or text
 * @returns {string} Output
 */
function formatPauseReport(report, outputFormat) {
  if (outputFormat === 'json') {
    return JSON.stringify(report, null, 2);
  }
  if (outputFormat === 'text') {
    return formatPauseReportAsText(report);
  }
  return formatPauseReportAsLinksNotation(report);
}

function success(fields, deps) {
  const record = fields.record;
  const processIds = collectProcessIds(record, deps.runner);
  return {
    success: true,
    output: formatPauseReport(
      buildPauseReport({ ...fields, processIds }),
      deps.outputFormat
    ),
  };
}

function runDocker(runner, args) {
  return runner(getDockerCommand(), args, {
    timeout: DOCKER_PAUSE_TIMEOUT_MS,
  });
}

/**
 * Handle a container Docker no longer has: record the removal and drop a
 * stale pause, then fail with a recovery path.
 */
function failRemoved(store, action, identifier, record, dockerState) {
  if (typeof store.markContainerRemoved === 'function') {
    try {
      store.markContainerRemoved(record.uuid, new Date().toISOString());
    } catch {
      // Reported either way; `--status` observes the removal again.
    }
  }
  reconcileStalePause(store, record);
  return {
    success: false,
    error: notPausableError(action, identifier, record, dockerState),
  };
}

/**
 * `$ --pause <id>`: freeze a running detached Docker execution.
 * @param {?object} store - Execution store
 * @param {string} identifier - UUID or session name
 * @param {object} [deps] - {runner, outputFormat, reason, by}
 * @returns {{success: boolean, output?: string, error?: string}}
 */
function pauseExecution(store, identifier, deps = {}) {
  const action = PauseAction.PAUSE;
  const target = resolvePauseTarget(store, identifier, action);
  if (target.error) {
    return { success: false, error: target.error };
  }
  let record = target.record;
  const runner = deps.runner || runCommand;
  const context = { runner, outputFormat: deps.outputFormat };
  const name = record.options.sessionName;
  const dockerState = inspectPauseState(name, runner);

  if (dockerState.state === DockerState.REMOVED) {
    return failRemoved(store, action, identifier, record, dockerState);
  }
  if (dockerState.state === DockerState.UNKNOWN) {
    return {
      success: false,
      error: `Cannot ${action} ${identifier}: docker inspect ${name} failed: ${dockerState.detail}`,
    };
  }
  if (dockerState.paused) {
    if (record.options.paused !== true) {
      // Paused outside start-command: adopt it so status and cleanup know.
      record = saveOptions(store, record, (o) =>
        pausedOptions(o, { by: deps.by, reason: deps.reason })
      );
    }
    return success(
      {
        action,
        identifier,
        record,
        status: 'already-paused',
        method: 'NONE',
        dockerState: DockerState.PAUSED,
        message: `Container ${name} is already paused; nothing changed.`,
      },
      context
    );
  }
  if (dockerState.state !== DockerState.RUNNING) {
    reconcileStalePause(store, record);
    return {
      success: false,
      error: notPausableError(action, identifier, record, dockerState),
    };
  }

  const result = runDocker(runner, ['pause', name]);
  if (!result.success) {
    return {
      success: false,
      error: `Failed to pause docker container "${name}": ${failureDetail(result)}`,
    };
  }
  record = saveOptions(store, record, (o) =>
    pausedOptions(o, { by: deps.by, reason: deps.reason })
  );
  return success(
    {
      action,
      identifier,
      record,
      status: 'paused',
      method: 'DOCKER_PAUSE',
      dockerState: DockerState.PAUSED,
      message:
        `Paused detached docker container: ${name}. CPU is released; memory stays allocated ` +
        `(use \`$ --stop ${record.uuid}\` to free it). \`$ --unpause ${record.uuid}\` continues the same process.`,
    },
    context
  );
}

/**
 * `$ --unpause <id>`: thaw a paused detached Docker execution.
 * @param {?object} store - Execution store
 * @param {string} identifier - UUID or session name
 * @param {object} [deps] - {runner, outputFormat}
 * @returns {{success: boolean, output?: string, error?: string}}
 */
function unpauseExecution(store, identifier, deps = {}) {
  const action = PauseAction.UNPAUSE;
  const target = resolvePauseTarget(store, identifier, action);
  if (target.error) {
    return { success: false, error: target.error };
  }
  let record = target.record;
  const runner = deps.runner || runCommand;
  const context = { runner, outputFormat: deps.outputFormat };
  const name = record.options.sessionName;
  const dockerState = inspectPauseState(name, runner);

  if (dockerState.state === DockerState.REMOVED) {
    return failRemoved(store, action, identifier, record, dockerState);
  }
  if (dockerState.state === DockerState.UNKNOWN) {
    return {
      success: false,
      error: `Cannot ${action} ${identifier}: docker inspect ${name} failed: ${dockerState.detail}`,
    };
  }
  if (dockerState.state === DockerState.RUNNING) {
    // Thawed by hand or by a daemon restart: report the truth.
    record = reconcileStalePause(store, record);
    return success(
      {
        action,
        identifier,
        record,
        status: 'not-paused',
        method: 'NONE',
        dockerState: DockerState.RUNNING,
        message: `Container ${name} is running and not paused; nothing changed.`,
      },
      context
    );
  }
  if (!dockerState.paused) {
    reconcileStalePause(store, record);
    return {
      success: false,
      error: notPausableError(action, identifier, record, dockerState),
    };
  }

  const result = runDocker(runner, ['unpause', name]);
  if (!result.success) {
    return {
      success: false,
      error: `Failed to unpause docker container "${name}": ${failureDetail(result)}`,
    };
  }
  record = saveOptions(store, record, (o) =>
    clearedPauseOptions(o, PauseAction.UNPAUSE)
  );
  return success(
    {
      action,
      identifier,
      record,
      status: 'unpaused',
      method: 'DOCKER_UNPAUSE',
      dockerState: DockerState.RUNNING,
      message: `Unpaused detached docker container: ${name}. The same process continues.`,
    },
    context
  );
}

/**
 * The pause fields `--status` and `--list` report for a detached Docker
 * execution, from what the status probe saw.
 * @param {object} record - Execution record (after status reconciliation)
 * @param {object} probe - Status probe; `dockerState` is the inspected state
 *   and `sessionNotFound` says Docker answered "no such container"
 * @returns {?{dockerState: string, paused: boolean, pausedAt?: string}} Fields,
 *   or null for records that are not detached Docker executions
 */
function observedPauseFields(record, probe) {
  const opts = (record && record.options) || {};
  if (opts.isolated !== 'docker' || opts.isolationMode !== 'detached') {
    return null;
  }
  const inspected = probe && probe.dockerState;
  let dockerState;
  if (record.containerState === DockerState.REMOVED || probe?.sessionNotFound) {
    dockerState = DockerState.REMOVED;
  } else if (inspected && inspected.status) {
    dockerState = inspected.paused ? DockerState.PAUSED : inspected.status;
  } else if (inspected) {
    dockerState = inspected.running ? DockerState.RUNNING : DockerState.EXITED;
  } else {
    dockerState = DockerState.UNKNOWN;
  }
  // Unknown liveness (docker unreachable) keeps the recorded pause.
  const paused =
    dockerState === DockerState.UNKNOWN
      ? opts.paused === true
      : dockerState === DockerState.PAUSED;
  const fields = { dockerState, paused };
  if (paused) {
    fields.pausedAt = opts.pausedAt || null;
  }
  return fields;
}

/**
 * Attach `dockerState`, `paused` and `pausedAt` to a status record, and make
 * its recorded pause agree with Docker (issue #263). The input is not mutated.
 * @param {object} record - Enriched execution record
 * @param {object} probe - Status probe (see `observedPauseFields`)
 * @returns {object} Record-like object whose `toObject()` carries the fields
 */
function attachPauseState(record, probe) {
  const fields = observedPauseFields(record, probe);
  if (!fields) {
    return record;
  }
  const wrapped = Object.assign(
    Object.create(Object.getPrototypeOf(record)),
    record
  );
  const opts = record.options || {};
  if (fields.dockerState !== DockerState.UNKNOWN) {
    if (fields.paused && opts.paused !== true) {
      wrapped.options = pausedOptions(opts);
      fields.pausedAt = wrapped.options.pausedAt;
      wrapped.pauseReconciled = true;
    } else if (!fields.paused && opts.paused === true) {
      wrapped.options = clearedPauseOptions(opts, 'reconcile');
      wrapped.pauseReconciled = true;
    }
  }
  Object.assign(wrapped, fields);
  // `this`, not `wrapped`: later enrichment copies the record (exit reason,
  // attempt history) and those copies must still serialize their own fields.
  const baseToObject = record.toObject;
  wrapped.toObject = function () {
    const ordered = {};
    const base =
      typeof baseToObject === 'function'
        ? baseToObject.call(this)
        : { ...this };
    for (const [key, value] of Object.entries(base)) {
      ordered[key] = value;
      if (key === 'status') {
        Object.assign(ordered, fields);
      }
    }
    return Object.assign(ordered, fields);
  };
  return wrapped;
}

/**
 * Persist the pause reconciliation `--status` / `--list` observed, best
 * effort: a read-only query must never fail because the store is busy.
 * @param {?object} store - Execution store
 * @param {object} reported - Record returned by `attachPauseState`
 */
function persistPauseReconciliation(store, reported) {
  if (!store || !reported || reported.pauseReconciled !== true) {
    return;
  }
  const target = reported.options || {};
  saveOptions(
    store,
    reported,
    (options) =>
      target.paused
        ? pausedOptions(options, { at: target.pausedAt })
        : clearedPauseOptions(options, 'reconcile', target.unpausedAt),
    false
  );
}

/**
 * Human-readable pause lines for `--status --output-format text`.
 * @param {object} obj - Serialized record
 * @returns {string[]} Lines (empty for non-Docker records)
 */
function pauseTextLines(obj) {
  if (obj.dockerState === undefined) {
    return [];
  }
  const lines = [
    `Docker State:      ${obj.dockerState}`,
    `Paused:            ${obj.paused}`,
  ];
  if (obj.paused) {
    lines.push(`Paused At:         ${obj.pausedAt || 'N/A'}`);
  }
  return lines;
}

module.exports = {
  DOCKER_PAUSE_TIMEOUT_MS,
  DockerState,
  PAUSED_RESOURCES,
  PAUSE_STATE_FORMAT,
  PauseAction,
  attachPauseState,
  buildPauseReport,
  clearPauseAfterControl,
  clearedPauseOptions,
  formatPauseReport,
  inspectPauseState,
  isConfirmedPaused,
  observedPauseFields,
  parsePauseState,
  pauseExecution,
  pauseTextLines,
  pausedOptions,
  persistPauseReconciliation,
  reconcileStalePause,
  unpauseExecution,
};
