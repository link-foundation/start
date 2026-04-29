/**
 * Status formatter module for execution records
 *
 * Provides formatting functions for execution status output in various formats:
 * - Links Notation (links-notation): Structured link doublet format
 * - JSON: Standard JSON output
 * - Text: Human-readable text format
 */

const { execSync } = require('child_process');
const fs = require('fs');
const {
  escapeForLinksNotation,
  formatAsNestedLinksNotation,
} = require('./output-blocks');

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
        const output = execSync(
          `docker inspect -f "{{.State.Running}}" ${sessionName}`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        return output.trim() === 'true';
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

function readExitCodeFromLog(logPath) {
  if (!logPath) {
    return null;
  }
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const matches = [...content.matchAll(/Exit Code:\s*(-?\d+)/g)];
    if (matches.length === 0) {
      return null;
    }
    return parseInt(matches[matches.length - 1][1], 10);
  } catch {
    return null;
  }
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
  const alive = isDetachedSessionAlive(record);
  if (alive === null) {
    return record;
  }

  // Create a shallow copy to avoid mutating the original
  const enriched = Object.create(Object.getPrototypeOf(record));
  Object.assign(enriched, record);

  if (alive && enriched.status === 'executed') {
    // Session still running but record says executed - correct it
    enriched.status = 'executing';
    enriched.exitCode = null;
    enriched.endTime = null;
  } else if (!alive && enriched.status === 'executing') {
    // Session ended but record says executing - correct it
    enriched.status = 'executed';
    if (enriched.exitCode === null || enriched.exitCode === undefined) {
      enriched.exitCode = readExitCodeFromLog(enriched.logPath) ?? -1;
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
  return attachCurrentTime(enrichDetachedStatus(record));
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
    // Attach currentTime so callers can see how long an executing command has been running
    const withCurrentTime = attachCurrentTime(enrichedRecord);
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
  attachCurrentTime,
};
