/**
 * Query and control command handlers.
 *
 * Every option in this module addresses an execution that already exists in
 * the tracking store instead of launching a new one: --status, --list,
 * --upload-log, --stop, --terminate, --attach, --resume, --resume-all and
 * --cleanup. `dispatchQueryCommand` is the single entry point the CLI calls
 * before it starts interpreting the command line as a command to run.
 */

const { queryStatus, listExecutions } = require('./status-formatter');
const { ControlAction, controlExecution } = require('./execution-control');
const { attachExecution } = require('./execution-attach');
const { resumeAllExecutions, resumeExecution } = require('./execution-resume');
const { uploadExecutionLog } = require('./log-uploader');

/**
 * Print a handler result, returning the process exit code.
 * @param {{success: boolean, output?: string, error?: string, exitCode?: number}} result
 * @returns {number} Exit code
 */
function reportResult(result) {
  if (result.success) {
    if (result.output) {
      console.log(result.output);
    }
    return result.exitCode || 0;
  }
  console.error(`Error: ${result.error}`);
  return result.exitCode || 1;
}

function handleStatusQuery(store, identifier, outputFormat) {
  return reportResult(queryStatus(store, identifier, outputFormat));
}

function handleListQuery(store, outputFormat, options = {}) {
  return reportResult(listExecutions(store, outputFormat, options));
}

function handleUploadLogQuery(store, identifier) {
  const result = uploadExecutionLog(store, identifier);
  if (result.success) {
    return result.exitCode || 0;
  }
  console.error(`Error: ${result.error}`);
  return result.exitCode || 1;
}

function handleControlQuery(store, identifier, action) {
  return reportResult(controlExecution(store, identifier, action));
}

function handleAttachQuery(store, identifier, readOnly) {
  return reportResult(attachExecution(store, identifier, { readOnly }));
}

async function handleResumeQuery(store, identifier, command, outputFormat) {
  return reportResult(
    await resumeExecution(store, identifier, { command, outputFormat })
  );
}

function handleResumeAllQuery(store, outputFormat) {
  return reportResult(resumeAllExecutions(store, { outputFormat }));
}

/**
 * Handle --cleanup / --cleanup-dry-run.
 * Cleans up stale "executing" records (processes that crashed or were killed).
 * @param {?object} store - Execution store
 * @param {boolean} dryRun - If true, just report what would be cleaned
 * @returns {number} Exit code
 */
function handleCleanup(store, dryRun) {
  if (!store) {
    console.error('Error: Execution tracking is disabled.');
    return 1;
  }

  const result = store.cleanupStale({ dryRun });

  if (result.errors.length > 0) {
    for (const error of result.errors) {
      console.error(`Error: ${error}`);
    }
  }

  if (result.records.length === 0) {
    console.log('No stale records found.');
    return 0;
  }

  if (dryRun) {
    console.log(
      `Found ${result.records.length} stale record(s) that would be cleaned up:\n`
    );
  } else {
    console.log(`Cleaned up ${result.cleaned} stale record(s):\n`);
  }

  for (const record of result.records) {
    const startTime = new Date(record.startTime).toLocaleString();
    console.log(`  UUID: ${record.uuid}`);
    console.log(`  Command: ${record.command}`);
    console.log(`  Started: ${startTime}`);
    console.log(`  PID: ${record.pid || 'N/A'}`);
    console.log('');
  }

  if (dryRun) {
    console.log('Run with --cleanup to actually clean up these records.');
  }
  return 0;
}

function hasValue(value) {
  return value !== null && value !== undefined;
}

/**
 * Report whether any query/control mode is active.
 * @param {object} options - Parsed wrapper options
 * @returns {boolean} True when the invocation addresses a stored execution
 */
function hasQueryMode(options) {
  return (
    hasValue(options.status) ||
    options.list === true ||
    hasValue(options.uploadLog) ||
    hasValue(options.stop) ||
    hasValue(options.terminate) ||
    hasValue(options.attach) ||
    hasValue(options.resume) ||
    options.resumeAll === true ||
    options.cleanup === true
  );
}

/**
 * Run the query/control mode selected by the wrapper options, if any.
 * @param {object} options - Parsed wrapper options
 * @param {object} context - {store, command}
 * @returns {Promise<?number>} Exit code, or null when no query mode is active
 */
async function dispatchQueryCommand(options, context = {}) {
  const store = context.store || null;
  const outputFormat = options.outputFormat;

  if (hasValue(options.status)) {
    return handleStatusQuery(store, options.status, outputFormat);
  }
  if (options.list) {
    return handleListQuery(store, outputFormat, { running: options.running });
  }
  if (hasValue(options.uploadLog)) {
    return handleUploadLogQuery(store, options.uploadLog);
  }
  if (hasValue(options.stop)) {
    return handleControlQuery(store, options.stop, ControlAction.STOP);
  }
  if (hasValue(options.terminate)) {
    return handleControlQuery(
      store,
      options.terminate,
      ControlAction.TERMINATE
    );
  }
  if (hasValue(options.attach)) {
    return handleAttachQuery(store, options.attach, options.readOnly === true);
  }
  if (hasValue(options.resume)) {
    return await handleResumeQuery(
      store,
      options.resume,
      context.command || null,
      outputFormat
    );
  }
  if (options.resumeAll) {
    return handleResumeAllQuery(store, outputFormat);
  }
  if (options.cleanup) {
    return handleCleanup(store, options.cleanupDryRun);
  }

  return null;
}

module.exports = {
  dispatchQueryCommand,
  hasQueryMode,
  handleAttachQuery,
  handleCleanup,
  handleControlQuery,
  handleListQuery,
  handleResumeAllQuery,
  handleResumeQuery,
  handleStatusQuery,
  handleUploadLogQuery,
  reportResult,
};
