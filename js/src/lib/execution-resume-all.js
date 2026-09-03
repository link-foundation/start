/**
 * `--resume-all`: re-attach or reconcile every execution still marked running.
 *
 * When the supervisor host restarts, the detached docker completion watcher
 * (`docker logs -f ... ; docker inspect ... ; footer`) dies with it. The
 * container keeps running but nothing streams its output into the session log
 * any more, and nothing will ever write the exit footer — the record stays
 * `executing` forever. `--resume-all` repairs that state:
 *
 * - reattached: a live docker container gets a fresh completion watcher.
 * - running:    a live screen/tmux session needs nothing (its logging is
 *               in-session), it is only reported.
 * - reconciled: the session is gone, so the record is finalized from the same
 *               evidence `--status` uses (docker exit code, log footer).
 * - unknown:    the backend cannot be probed locally (ssh), left untouched.
 *
 * Commands are never silently restarted here: resuming actual work is an
 * explicit, per-session decision made with `--resume`.
 */

const {
  getDockerContainerCleanupPolicy,
  startDetachedDockerCompletionWatcher,
} = require('./docker-cleanup');
const { escapeForLinksNotation } = require('./output-blocks');
const { runCommand } = require('./execution-control');
const { SessionState, probeSession } = require('./session-probe');

/**
 * Outcomes reported for each execution that was still marked running.
 */
const ResumeAllAction = {
  REATTACHED: 'reattached',
  RUNNING: 'running',
  RECONCILED: 'reconciled',
  UNKNOWN: 'unknown',
};

function formatResumeAllAsLinksNotation(summary) {
  const lines = ['executionResumeAll', `  count ${summary.count}`];
  for (const entry of summary.executions) {
    lines.push('  execution');
    lines.push(`    uuid ${escapeForLinksNotation(entry.uuid)}`);
    lines.push(`    backend ${escapeForLinksNotation(entry.backend)}`);
    lines.push(`    sessionName ${escapeForLinksNotation(entry.sessionName)}`);
    lines.push(`    state ${escapeForLinksNotation(entry.state)}`);
    lines.push(`    action ${escapeForLinksNotation(entry.action)}`);
    if (entry.exitCode !== null && entry.exitCode !== undefined) {
      lines.push(`    exitCode ${entry.exitCode}`);
    }
    lines.push(`    message ${escapeForLinksNotation(entry.message)}`);
  }
  return lines.join('\n');
}

function formatResumeAllAsText(summary) {
  if (summary.count === 0) {
    return 'No executions are currently marked as running.';
  }
  const lines = [`Executions still marked running: ${summary.count}`, ''];
  for (const entry of summary.executions) {
    lines.push(`${entry.action.toUpperCase()}  ${entry.uuid}`);
    lines.push(`  Backend:      ${entry.backend}`);
    lines.push(`  Session Name: ${entry.sessionName}`);
    lines.push(`  State:        ${entry.state}`);
    lines.push(`  ${entry.message}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function formatResumeAll(summary, outputFormat) {
  if (outputFormat === 'json') {
    return JSON.stringify(summary, null, 2);
  }
  if (outputFormat === 'text') {
    return formatResumeAllAsText(summary);
  }
  return formatResumeAllAsLinksNotation(summary);
}

function describeRecord(record, probe, action, message, exitCode = null) {
  return {
    uuid: record.uuid,
    backend:
      probe.backend || (record.options && record.options.isolated) || null,
    sessionName:
      probe.sessionName ||
      (record.options && record.options.sessionName) ||
      null,
    state: probe.state,
    action,
    exitCode,
    message,
  };
}

/**
 * Re-attach or reconcile every execution still marked running.
 * @param {?object} store - Execution store
 * @param {object} deps - {outputFormat, probe, runner, startWatcher, reconcile}
 * @returns {{success: boolean, output?: string, error?: string}}
 */
function resumeAllExecutions(store, deps = {}) {
  if (!store) {
    return { success: false, error: 'Execution tracking is disabled.' };
  }

  const runner = deps.runner || runCommand;
  const probeFn = deps.probe || ((record) => probeSession(record, runner));
  const startWatcher =
    deps.startWatcher || startDetachedDockerCompletionWatcher;
  const reconcile =
    deps.reconcile || require('./status-formatter').enrichDetachedStatus;

  let records;
  try {
    records = store.getExecuting();
  } catch (err) {
    return { success: false, error: err.message };
  }

  const executions = [];

  for (const record of records) {
    const probe = probeFn(record);
    const sessionName = probe.sessionName;

    if (probe.alive && probe.backend === 'docker') {
      startWatcher(
        sessionName,
        getDockerContainerCleanupPolicy(record.options || {}),
        record.logPath || null
      );
      executions.push(
        describeRecord(
          record,
          probe,
          ResumeAllAction.REATTACHED,
          `Re-attached completion watcher to running container: ${sessionName}`
        )
      );
      continue;
    }

    if (probe.alive) {
      executions.push(
        describeRecord(
          record,
          probe,
          ResumeAllAction.RUNNING,
          `Session is still running: ${sessionName}`
        )
      );
      continue;
    }

    if (probe.state === SessionState.UNKNOWN) {
      executions.push(
        describeRecord(
          record,
          probe,
          ResumeAllAction.UNKNOWN,
          `Session liveness cannot be probed locally: ${sessionName || record.uuid}`
        )
      );
      continue;
    }

    const reconciled = reconcile(record);
    if (reconciled && reconciled.status === 'executed') {
      store.save(reconciled);
      executions.push(
        describeRecord(
          record,
          probe,
          ResumeAllAction.RECONCILED,
          `Session ended while unsupervised; record finalized. Use \`$ --resume ${record.uuid}\` to continue it.`,
          reconciled.exitCode
        )
      );
      continue;
    }

    executions.push(
      describeRecord(
        record,
        probe,
        ResumeAllAction.UNKNOWN,
        `Session is not running but no terminal result could be resolved: ${sessionName || record.uuid}`
      )
    );
  }

  return {
    success: true,
    output: formatResumeAll(
      { count: executions.length, executions },
      deps.outputFormat
    ),
  };
}

module.exports = {
  ResumeAllAction,
  formatResumeAll,
  formatResumeAllAsLinksNotation,
  formatResumeAllAsText,
  resumeAllExecutions,
};
