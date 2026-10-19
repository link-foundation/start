/**
 * What a new launch may do with its execution id (issue #229).
 *
 * A launch with an explicit `--session-id` that is already tracked used to
 * replace the record and truncate the log. It is now refused unless
 * `--append-attempt` is given, which keeps the record, archives the previous
 * attempt into `attemptHistory`, and appends the new attempt to the same log
 * after a lifecycle header (the layout `--resume` already writes).
 *
 * Two cases keep the earlier behaviour:
 * - the next level of a stacked isolation, which receives the same
 *   `--session-id` from its parent and runs with START_EXECUTION_ID already
 *   set to it (`isNestedLaunchOf`);
 * - a generated UUID, which cannot collide.
 */
const fs = require('fs');
const { isNestedLaunchOf, ATTEMPT_ENV } = require('./execution-env');
const { findRecord, withStoreLock } = require('./execution-identity');

const LOG_HEADER = '=== Start Command Log ===';

class LaunchRefusedError extends Error {}

function alreadyExistsMessage(uuid) {
  return `execution ${uuid} already exists; use $ --resume ${uuid} -- <command> to continue it, or pass --append-attempt`;
}

function isPidAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** True while the stored execution may still be running. */
function isExecutionLive(record) {
  if (require('./launch-owner').hasActiveLaunch(record)) {
    return true;
  }
  if (record.status !== 'executing') {
    return false;
  }
  if (record.options && record.options.isolated) {
    try {
      return require('./session-probe').probeSession(record).alive === true;
    } catch {
      return true;
    }
  }
  return isPidAlive(record.pid);
}

/** Attempts already in a log written without tracking, from its headers. */
function countLoggedAttempts(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8').split(LOG_HEADER).length - 1;
  } catch {
    return 0;
  }
}

function logSize(logPath) {
  try {
    return fs.statSync(logPath).size;
  } catch {
    return 0;
  }
}

/**
 * Decide how a launch uses its execution id, before anything is printed or
 * created.
 * @param {object} params - {store, sessionId, explicitSessionId,
 *   appendAttempt, logPath, env}
 * @returns {{append: boolean, previous: object|null, attemptNumber: number,
 *   logPath: string, nested: boolean, checked: boolean}}
 * @throws {LaunchRefusedError} When the launch must not run
 */
function preflightLaunch(params) {
  const { store, sessionId, logPath } = params;
  const env = params.env || process.env;
  const fresh = {
    append: false,
    previous: null,
    attemptNumber: 1,
    logPath,
    nested: false,
    checked: false,
  };
  if (!params.explicitSessionId) {
    return fresh;
  }
  if (isNestedLaunchOf(sessionId, env)) {
    const inherited = Number(env[ATTEMPT_ENV]);
    return {
      ...fresh,
      nested: true,
      attemptNumber:
        Number.isSafeInteger(inherited) && inherited > 0 ? inherited : 1,
    };
  }
  const existing = store ? store.get(sessionId) : null;
  if (existing && existing.uuid !== sessionId) {
    throw new LaunchRefusedError(
      `execution id ${sessionId} is already used as a name of execution ${existing.uuid}; pick another --session-id`
    );
  }
  if (existing) {
    if (!params.appendAttempt) {
      throw new LaunchRefusedError(alreadyExistsMessage(sessionId));
    }
    if (isExecutionLive(existing)) {
      throw new LaunchRefusedError(
        `execution ${sessionId} is still running; wait for it to finish or use $ --stop ${sessionId} before --append-attempt`
      );
    }
    const { nextAttemptNumber } = require('./execution-attempt');
    return {
      ...fresh,
      append: true,
      previous: existing,
      attemptNumber: nextAttemptNumber(existing),
      logPath: existing.logPath || logPath,
      checked: true,
    };
  }
  // Untracked (or deleted) executions are recognised by their log file.
  if (logPath && fs.existsSync(logPath)) {
    if (!params.appendAttempt) {
      throw new LaunchRefusedError(alreadyExistsMessage(sessionId));
    }
    return {
      ...fresh,
      append: true,
      attemptNumber: countLoggedAttempts(logPath) + 1,
      checked: true,
    };
  }
  return { ...fresh, checked: true };
}

/**
 * Turn the record a launch built into the next attempt of `previous`,
 * keeping the identity, history and log of the execution.
 * @param {object} record - Freshly built ExecutionRecord (mutated)
 * @param {object} previous - Stored record of the same UUID
 * @returns {object} The record
 */
function mergeAppendedAttempt(record, previous) {
  const {
    archiveAttempt,
    createAttempt,
    currentAttemptNumber,
  } = require('./execution-attempt');
  const prior = require('./execution-store').ExecutionRecord.fromObject(
    JSON.parse(JSON.stringify(previous.toObject()))
  );
  if (!prior.attempt && currentAttemptNumber(prior) === 1) {
    // A launch writes a fresh log, so its first attempt starts at offset 0.
    prior.attempt = { number: 1, startedAt: prior.startTime, logOffset: 0 };
  }
  const attempt = createAttempt(prior, {
    mode: 'append-attempt',
    sessionName: record.options.sessionName || null,
  });
  archiveAttempt(prior);
  const keep = prior.options || {};
  const history = [...(keep.sessionNameHistory || [])];
  if (keep.sessionName && keep.sessionName !== record.options.sessionName) {
    history.push(keep.sessionName);
  }
  record.attempt = attempt;
  record.attemptHistory = prior.attemptHistory;
  record.startTime = prior.startTime;
  record.logPath = prior.logPath || record.logPath;
  record.continues = record.continues || prior.continues;
  record.options = {
    ...record.options,
    ...(history.length ? { sessionNameHistory: [...new Set(history)] } : {}),
    ...(keep.aliases ? { aliases: keep.aliases } : {}),
    ...(keep.name ? { name: keep.name } : {}),
    ...(keep.resumeCount ? { resumeCount: keep.resumeCount } : {}),
  };
  return record;
}

/**
 * Persist the launch's record, refusing if another launch claimed the id in
 * the meantime: a new id must still be free, an appended attempt must still
 * follow the attempt the preflight saw.
 * @param {object} store - ExecutionStore
 * @param {object} record - Record to save
 * @param {object} launch - preflightLaunch() result
 */
function claimLaunch(store, record, launch) {
  if (!launch.checked) {
    store.save(record);
    return;
  }
  withStoreLock(store, (records) => {
    const index = records.findIndex((r) => r.uuid === record.uuid);
    if (launch.previous) {
      const current = records[index];
      if (
        !current ||
        require('./launch-owner').hasActiveLaunch(current) ||
        (current.attempt?.number || 0) !==
          (launch.previous.attempt?.number || 0)
      ) {
        throw new LaunchRefusedError(
          `execution ${record.uuid} was claimed by another launch`
        );
      }
      records[index] = record;
    } else {
      if (findRecord(records, record.uuid)) {
        throw new LaunchRefusedError(alreadyExistsMessage(record.uuid));
      }
      records.push(record);
    }
    return record;
  });
}

/**
 * Header a launch writes into its log: unchanged for a fresh log; for an
 * appended attempt, preceded by a lifecycle line in the format `--resume`
 * writes, so the attempts stay apart.
 * @param {string} content - Header content
 * @param {object} launch - preflightLaunch() result
 * @param {object|null} record - Record of the launch, when tracked
 * @returns {string} Content to write
 */
function launchLogContent(content, launch, record = null) {
  if (!launch.append) {
    return content;
  }
  const lifecycle = {
    event: 'attempt-appended',
    at: new Date().toISOString(),
    uuid: record ? record.uuid : null,
    attemptNumber: launch.attemptNumber,
    ...(record && record.attempt ? record.attempt : {}),
  };
  return `\n[Start Command Lifecycle] ${JSON.stringify(lifecycle)}\n${content}`;
}

/**
 * Save the initial record of a direct run, before it starts. A refused
 * claim ends the launch with exit code 1; other failures only lose tracking.
 * @param {object|null} store - ExecutionStore
 * @param {object|null} record - Execution record
 * @param {object} launch - prepareLaunch() result
 * @param {object} [config] - CLI configuration ({verbose})
 */
function claimDirectLaunch(store, record, launch, config = {}) {
  if (!record || !store) {
    return;
  }
  try {
    claimLaunch(store, record, launch);
  } catch (err) {
    if (err instanceof LaunchRefusedError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    if (config.verbose) {
      console.error(
        `[Tracking] Warning: Could not save execution record: ${err.message}`
      );
    }
  }
}

/**
 * Write the launch header: a fresh log, or, for an appended attempt, a
 * lifecycle line and the header after the earlier attempts.
 * @param {string} logPath - Log path
 * @param {string} content - Header content
 * @param {object} launch - preflightLaunch() result
 * @param {object|null} record - Record of the launch, when tracked
 */
function writeLaunchLog(logPath, content, launch, record = null) {
  const { appendLogFile, writeLogFile } = require('./isolation-log-utils');
  const text = launchLogContent(content, launch, record);
  if (launch.append) {
    appendLogFile(logPath, text);
  } else {
    writeLogFile(logPath, text);
  }
}

/**
 * Preflight of the CLI: how this launch uses its id (#229) and which
 * execution it continues (#231).
 * @param {object} store - ExecutionStore, or null when tracking is off
 * @param {object} options - Parsed wrapper options
 * @param {string} sessionId - Execution UUID of the launch
 * @param {string} logPath - Default log path of the launch
 * @returns {object} preflightLaunch() result plus `continues`
 * @throws {Error} When the launch must not run
 */
function prepareLaunch(store, options, sessionId, logPath) {
  const launch = preflightLaunch({
    store,
    sessionId,
    explicitSessionId: Boolean(options.sessionId),
    appendAttempt: Boolean(options.appendAttempt),
    logPath,
  });
  launch.continues = options.continues
    ? require('./execution-chain').resolveContinues(
        store,
        options.continues,
        sessionId
      )
    : null;
  return launch;
}

/**
 * Apply the preflight to the record a launch built: the continued UUID and,
 * for `--append-attempt`, the identity and history of the stored execution.
 * @param {object|null} record - Freshly built ExecutionRecord (mutated)
 * @param {object} launch - prepareLaunch() result
 * @returns {object|null} The record
 */
function applyLaunch(record, launch) {
  if (!record) {
    return record;
  }
  if (launch.continues) {
    record.continues = launch.continues;
  }
  if (launch.previous) {
    mergeAppendedAttempt(record, launch.previous);
  } else if (launch.attemptNumber > 1) {
    // A nested level or an untracked log: number the attempt all the same.
    record.attempt = {
      number: launch.attemptNumber,
      startedAt: new Date().toISOString(),
      logOffset: launch.append ? logSize(launch.logPath) : 0,
      mode: launch.nested ? 'nested' : 'append-attempt',
    };
  }
  return record;
}

/**
 * START_* variables of a direct run (no session name).
 * @param {string} sessionId - Execution UUID
 * @param {object} launch - prepareLaunch() result
 * @returns {object} Child environment
 */
function directLaunchEnv(sessionId, launch) {
  const env = require('./execution-env');
  return env.withExecutionEnv(
    env.buildExecutionEnv({
      executionId: sessionId,
      sessionName: '',
      attempt: launch.attemptNumber,
    })
  );
}

module.exports = {
  LaunchRefusedError,
  alreadyExistsMessage,
  applyLaunch,
  claimDirectLaunch,
  claimLaunch,
  directLaunchEnv,
  isExecutionLive,
  launchLogContent,
  mergeAppendedAttempt,
  prepareLaunch,
  preflightLaunch,
  writeLaunchLog,
};
