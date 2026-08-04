/**
 * Status formatter module for execution records
 *
 * Provides formatting functions for execution status output in various formats:
 * - Links Notation (links-notation): Structured link doublet format
 * - JSON: Standard JSON output
 * - Text: Human-readable text format
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const {
  escapeForLinksNotation,
  formatAsNestedLinksNotation,
} = require('./output-blocks');
const { collectProcessIds } = require('./execution-control');
const { getDockerCommand, getDockerSpawnOptions } = require('./docker-cleanup');

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
 * @returns {{running: boolean, exitCode: number|null, oomKilled: boolean|null}|null} State,
 *   or null when the container cannot be inspected (not found yet, removed, or docker error)
 */
function inspectDockerState(sessionName) {
  const result = spawnSync(
    getDockerCommand(),
    [
      'inspect',
      '-f',
      '{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}',
      sessionName,
    ],
    getDockerSpawnOptions({
      encoding: 'utf8',
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  );
  if (result.error || result.status !== 0 || !result.stdout) {
    return null;
  }
  const [runningRaw, exitRaw, oomKilledRaw] = result.stdout.trim().split(/\s+/);
  const exitCode = Number.parseInt(exitRaw, 10);
  return {
    running: runningRaw === 'true',
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    oomKilled:
      oomKilledRaw === 'true' ? true : oomKilledRaw === 'false' ? false : null,
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

function readDockerState(record) {
  const opts = record.options || {};
  if (opts.isolated !== 'docker' || !opts.sessionName) {
    return null;
  }
  return inspectDockerState(opts.sessionName);
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

/**
 * Check if a detached isolation session is still running
 * @param {Object} record - Execution record
 * @returns {boolean|null} true if running, false if not, null if unable to determine
 */
function isDetachedSessionAlive(record) {
  const opts = record.options || {};
  const sessionName = opts.sessionName;
  const isolationMode = opts.isolationMode;
  const isolated = opts.isolated;

  if (!sessionName || isolationMode !== 'detached') {
    return null;
  }

  try {
    switch (isolated) {
      case 'screen': {
        const output = execSync('screen -ls', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return output.includes(sessionName);
      }
      case 'tmux': {
        execSync(`tmux has-session -t ${sessionName}`, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return true;
      }
      case 'docker': {
        // A failed inspect means the container is not visible yet (still being
        // created on a slow DinD host) or already removed — not "stopped".
        // Return null (unknown) so the session is not falsely marked finished.
        const state = inspectDockerState(sessionName);
        return state === null ? null : state.running;
      }
      case 'ssh': {
        // For SSH, check if the PID is still running on remote would require
        // re-connecting. Fall back to checking the local wrapper PID.
        if (record.pid) {
          try {
            process.kill(record.pid, 0);
            return true;
          } catch {
            return false;
          }
        }
        return null;
      }
      default:
        return null;
    }
  } catch {
    // Command failed - session is likely not running
    return false;
  }
}

/**
 * Number of trailing bytes scanned for the terminal log footer. The footer is
 * always appended at the very end of the log, so there is no reason to read
 * (potentially megabytes of) command output on every `--status` call.
 */
const LOG_TAIL_BYTES = 16 * 1024;

/**
 * The three-line terminal footer that `start` itself writes (see
 * `createLogFooter()` and `createShellLogFooterSnippet()`):
 *
 *   ==================================================
 *   Finished: 2026-07-30 23:36:20.295
 *   Exit Code: 0
 *
 * The whole block is anchored at line starts so that a bare `Exit Code: N`
 * substring emitted by the wrapped command (inside a JSON payload, a quoted
 * log excerpt, an `rg` dump, ...) can no longer be mistaken for the footer
 * `start` appends itself (issue #150).
 */
const LOG_FOOTER_PATTERN =
  /^={10,}[ \t]*\r?\n^Finished:[^\r\n]*\r?\n^Exit Code:[ \t]*(-?\d+)[ \t]*(?![^\r\n])/gm;

/**
 * Read the last `bytes` bytes of a file as UTF-8 text.
 *
 * A partial first line is dropped: the slice can start in the middle of a line,
 * and that fragment must not be treated as the beginning of a line by the
 * anchored footer pattern.
 *
 * @param {string} logPath - Path to the log file
 * @param {number} [bytes] - Maximum number of trailing bytes to read
 * @returns {string|null} Tail content, or null when the file cannot be read
 */
function readLogTail(logPath, bytes = LOG_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(logPath, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const tail = buffer.toString('utf8');
    if (size <= bytes) {
      return tail;
    }
    const firstNewline = tail.indexOf('\n');
    return firstNewline === -1 ? '' : tail.slice(firstNewline + 1);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Read the terminal exit code from the anchored footer at the end of a log.
 * Returns null when the log has no footer yet (command still running, or the
 * host-side watcher has not appended it yet) — never a number parsed out of the
 * command's own output.
 * @param {string} logPath - Path to the log file
 * @returns {number|null}
 */
function readExitCodeFromLog(logPath) {
  if (!logPath) {
    return null;
  }
  const tail = readLogTail(logPath);
  if (tail === null) {
    return null;
  }
  const matches = [...tail.matchAll(LOG_FOOTER_PATTERN)];
  if (matches.length === 0) {
    return null;
  }
  return parseInt(matches[matches.length - 1][1], 10);
}

/**
 * Enrich execution record with live session status for detached executions.
 * If a record shows "executing" but the detached session has actually ended,
 * returns an updated copy with status "executed". If it shows "executed" but
 * the session is still running, returns a copy with status "executing".
 * @param {Object} record - Execution record
 * @returns {Object} Possibly updated execution record
 */
function enrichDetachedStatus(record) {
  const footerExit = readExitCodeFromLog(record.logPath);
  const dockerState = isDetachedDockerRecord(record)
    ? readDockerState(record)
    : null;
  const alive = isDetachedDockerRecord(record)
    ? dockerState === null
      ? null
      : dockerState.running
    : isDetachedSessionAlive(record);

  // `oomKilled` is exposed alongside the status, but never decides it (#151).
  const oomKilled = resolveOomObservation(record, dockerState);

  // Create a shallow copy to avoid mutating the original
  const cloneRecord = () => {
    const enriched = Object.create(Object.getPrototypeOf(record));
    Object.assign(enriched, record);
    if (oomKilled !== undefined) {
      enriched.oomKilled = oomKilled;
    }
    return enriched;
  };

  if (alive === null) {
    // Liveness is unknown: the backend could not be probed (e.g. a detached
    // docker container that is not visible yet on a slow Docker-in-Docker host,
    // or one that has already been removed). Honor a terminal `Exit Code:`
    // footer if the command wrote one; otherwise leave the record untouched
    // (still executing) rather than fabricating a `-1` terminal result that
    // orchestrators misread as a finished/failed run (issue #136).
    const isDetached =
      record.options && record.options.isolationMode === 'detached';
    if (isDetached && record.status === 'executing') {
      if (footerExit !== null) {
        const enriched = cloneRecord();
        enriched.status = 'executed';
        enriched.exitCode = footerExit;
        if (!enriched.endTime) {
          enriched.endTime = new Date().toISOString();
        }
        return enriched;
      }
      if (oomKilled === true) {
        // The container is gone and wrote no footer, so the OOM observation is
        // the only evidence left: report the session as finished with the
        // conventional SIGKILL code (issue #148). While the container is still
        // inspectable this branch is never taken — a live container keeps the
        // session `executing` no matter what the cgroup flag says (issue #151).
        const enriched = cloneRecord();
        enriched.status = 'executed';
        enriched.exitCode = 137;
        if (!enriched.endTime) {
          enriched.endTime = new Date().toISOString();
        }
        return enriched;
      }
    }
    return oomKilled !== undefined ? cloneRecord() : record;
  }

  const enriched = cloneRecord();

  if (alive && enriched.status === 'executed') {
    // A live `screen -ls` (or `tmux`/`docker`) session does NOT mean the command
    // is still running: a lingering shell can outlive a killed command (e.g. the
    // OOM killer sends SIGKILL, exit 137, but the login shell stays up for a
    // window after `start` already wrote the terminal footer). The footer/recorded
    // exit code is authoritative. Only flip back to 'executing' when there is NO
    // recorded terminal exit code AND no `Exit Code:` footer in the log.
    const hasRecordedExit =
      enriched.exitCode !== null && enriched.exitCode !== undefined;
    if (!hasRecordedExit && footerExit === null) {
      // Session still running and no terminal record - correct it
      enriched.status = 'executing';
      enriched.exitCode = null;
      enriched.endTime = null;
    }
    // Otherwise keep the recorded/footer exit code - the command has finished.
  } else if (!alive && enriched.status === 'executing') {
    // Session ended but record says executing - correct it. Resolve a real exit
    // code: prefer the backend's own record (e.g. `docker inspect
    // .State.ExitCode`, which is authoritative and cannot be spoofed by command
    // output — issue #150), then the anchored log footer, then `137` when the
    // only evidence left is the OOM observation, and only fall back to the `-1`
    // sentinel as a last resort when no real code can be obtained (issues #136,
    // #151).
    enriched.status = 'executed';
    if (enriched.exitCode === null || enriched.exitCode === undefined) {
      enriched.exitCode =
        backendExitCode(dockerState) ??
        footerExit ??
        (oomKilled === true ? 137 : -1);
    }
    if (!enriched.endTime) {
      enriched.endTime = new Date().toISOString();
    }
  }

  return enriched;
}

/**
 * Wrap a record so its serialized form includes a `currentTime` field when
 * the status is "executing". This reflects the moment `--status` was invoked,
 * making it easy to compute how long a command has been running.
 * The original record is not mutated.
 * @param {Object} record - Execution record
 * @returns {Object} Record-like object with `toObject()` augmented when executing
 */
function attachCurrentTime(record) {
  if (!record || record.status !== 'executing') {
    return record;
  }

  const currentTime = new Date().toISOString();
  const wrapped = Object.create(Object.getPrototypeOf(record));
  Object.assign(wrapped, record);
  wrapped.currentTime = currentTime;
  wrapped.toObject = function () {
    const base =
      typeof record.toObject === 'function'
        ? record.toObject.call(this)
        : { ...this };
    // Insert currentTime right after startTime for readability
    const ordered = {};
    for (const [key, value] of Object.entries(base)) {
      ordered[key] = value;
      if (key === 'startTime') {
        ordered.currentTime = currentTime;
      }
    }
    if (!('currentTime' in ordered)) {
      ordered.currentTime = currentTime;
    }
    return ordered;
  };

  return wrapped;
}

/**
 * Wrap a record so its serialized form includes best-effort process IDs.
 * The original record is not mutated.
 * @param {Object} record - Execution record
 * @returns {Object} Record-like object with processIds in toObject()
 */
function attachProcessIds(record) {
  const processIds = collectProcessIds(record);
  if (!processIds) {
    return record;
  }

  const wrapped = Object.create(Object.getPrototypeOf(record));
  Object.assign(wrapped, record);
  wrapped.processIds = processIds;

  const sourceToObject =
    typeof record.toObject === 'function'
      ? () => record.toObject()
      : () => ({ ...record });

  wrapped.toObject = function () {
    const base = sourceToObject();
    const ordered = {};
    let inserted = false;
    for (const [key, value] of Object.entries(base)) {
      ordered[key] = value;
      if (key === 'pid') {
        ordered.processIds = processIds;
        inserted = true;
      }
    }
    if (!inserted) {
      ordered.processIds = processIds;
    }
    return ordered;
  };

  return wrapped;
}

/**
 * Format execution record as Links Notation (indented style)
 * Uses nested Links notation for object values (like options) instead of JSON
 *
 * @param {Object} record - The execution record with toObject() method
 * @returns {string} Links Notation formatted string in indented style
 *
 * Output format:
 * <uuid>
 *   <key> "<value>"
 *   options
 *     <nested_key> <nested_value>
 *   ...
 */
function formatRecordAsLinksNotation(record) {
  const obj = record.toObject();
  const lines = [record.uuid];

  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) {
      if (key === 'options' && typeof value === 'object') {
        // Format options as nested Links notation
        const optionEntries = Object.entries(value).filter(
          ([, v]) => v !== null && v !== undefined
        );
        if (optionEntries.length > 0) {
          lines.push('  options');
          for (const [optKey, optValue] of optionEntries) {
            const formattedOptValue = escapeForLinksNotation(optValue);
            lines.push(`    ${optKey} ${formattedOptValue}`);
          }
        }
      } else if (typeof value === 'object') {
        // For other objects, still format as nested Links notation
        lines.push(`  ${key}`);
        const nested = formatAsNestedLinksNotation(value, 2, 2);
        lines.push(nested);
      } else {
        const formattedValue = escapeForLinksNotation(value);
        lines.push(`  ${key} ${formattedValue}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format execution record as human-readable text
 * @param {Object} record - The execution record with toObject() method
 * @returns {string} Human-readable text
 */
function formatRecordAsText(record) {
  const obj = record.toObject();
  const lines = [
    `Execution Status`,
    `${'='.repeat(50)}`,
    `UUID:              ${obj.uuid}`,
    `Status:            ${obj.status}`,
    `Command:           ${obj.command}`,
    `Exit Code:         ${obj.exitCode !== null ? obj.exitCode : 'N/A'}`,
    ...(obj.oomKilled !== undefined
      ? [`OOM Killed:        ${obj.oomKilled}`]
      : []),
    `PID:               ${obj.pid !== null ? obj.pid : 'N/A'}`,
    `Working Directory: ${obj.workingDirectory}`,
    `Shell:             ${obj.shell}`,
    `Platform:          ${obj.platform}`,
    `Start Time:        ${obj.startTime}`,
  ];
  if (obj.currentTime) {
    lines.push(`Current Time:      ${obj.currentTime}`);
  }
  lines.push(
    `End Time:          ${obj.endTime || 'N/A'}`,
    `Log Path:          ${obj.logPath}`
  );

  // Format options as nested list instead of JSON
  const optionEntries = Object.entries(obj.options || {}).filter(
    ([, v]) => v !== null && v !== undefined
  );
  if (optionEntries.length > 0) {
    lines.push(`Options:`);
    for (const [key, value] of optionEntries) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format execution record based on format type
 * @param {Object} record - The execution record
 * @param {string} format - Output format (links-notation, json, text)
 * @returns {string} Formatted output string
 */
function formatRecord(record, format) {
  switch (format) {
    case 'links-notation':
      return formatRecordAsLinksNotation(record);
    case 'json':
      return JSON.stringify(record.toObject(), null, 2);
    case 'text':
      return formatRecordAsText(record);
    default:
      throw new Error(`Unknown output format: ${format}`);
  }
}

function sortRecordsByStartTimeDesc(records) {
  return [...records].sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
  );
}

function indentBlock(block, spaces) {
  const prefix = ' '.repeat(spaces);
  return block
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function prepareRecordForList(record) {
  return attachCurrentTime(attachProcessIds(enrichDetachedStatus(record)));
}

/**
 * Format execution records as a Links Notation list.
 * @param {Object[]} records - Execution records
 * @returns {string} Links Notation formatted list
 */
function formatRecordListAsLinksNotation(records) {
  const lines = ['executions', `  count ${records.length}`];

  if (records.length === 0) {
    lines.push('  records ()');
    return lines.join('\n');
  }

  lines.push('  records');
  for (const record of records) {
    lines.push(indentBlock(formatRecordAsLinksNotation(record), 4));
  }

  return lines.join('\n');
}

/**
 * Format execution records as human-readable text.
 * @param {Object[]} records - Execution records
 * @returns {string} Human-readable list
 */
function formatRecordListAsText(records) {
  const lines = ['Executions', `${'='.repeat(50)}`, `Count: ${records.length}`];

  for (const record of records) {
    lines.push('', formatRecordAsText(record));
  }

  return lines.join('\n');
}

/**
 * Format execution records based on format type.
 * @param {Object[]} records - Execution records
 * @param {string} format - Output format (links-notation, json, text)
 * @returns {string} Formatted output string
 */
function formatRecordList(records, format) {
  switch (format) {
    case 'links-notation':
      return formatRecordListAsLinksNotation(records);
    case 'json':
      return JSON.stringify(
        {
          count: records.length,
          executions: records.map((record) => record.toObject()),
        },
        null,
        2
      );
    case 'text':
      return formatRecordListAsText(records);
    default:
      throw new Error(`Unknown output format: ${format}`);
  }
}

/**
 * Handle status query and output the result
 * @param {Object} store - ExecutionStore instance
 * @param {string} uuid - UUID of the execution to query
 * @param {string|null} outputFormat - Output format (links-notation, json, text)
 * @returns {{success: boolean, output?: string, error?: string}}
 */
function queryStatus(store, identifier, outputFormat) {
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
  try {
    // Enrich detached execution status with live session check
    const enrichedRecord = enrichDetachedStatus(record);
    const withProcessIds = attachProcessIds(enrichedRecord);
    // Attach currentTime so callers can see how long an executing command has been running
    const withCurrentTime = attachCurrentTime(withProcessIds);
    return {
      success: true,
      output: formatRecord(withCurrentTime, outputFormat || 'links-notation'),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Handle execution list query and output the result
 * @param {Object} store - ExecutionStore instance
 * @param {string|null} outputFormat - Output format (links-notation, json, text)
 * @returns {{success: boolean, output?: string, error?: string}}
 */
function listExecutions(store, outputFormat) {
  if (!store) {
    return { success: false, error: 'Execution tracking is disabled.' };
  }

  try {
    const records = sortRecordsByStartTimeDesc(
      store.getAll().map(prepareRecordForList)
    );
    return {
      success: true,
      output: formatRecordList(records, outputFormat || 'links-notation'),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  formatRecordAsLinksNotation,
  formatRecordAsText,
  formatRecord,
  formatRecordListAsLinksNotation,
  formatRecordListAsText,
  formatRecordList,
  queryStatus,
  listExecutions,
  isDetachedSessionAlive,
  enrichDetachedStatus,
  readExitCodeFromLog,
  readLogTail,
  attachCurrentTime,
  attachProcessIds,
};
