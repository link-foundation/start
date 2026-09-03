/**
 * Resume tracked detached executions (issue #162).
 *
 * `--resume <id>` restarts a stored execution, and `--resume <id> -- <command>`
 * runs a *different* command against the same container filesystem. Both keep
 * the original execution UUID so `--status`, `--list` and `--upload-log` keep
 * addressing one logical session across restarts.
 *
 * Three strategies, chosen from the probed session state:
 * - DOCKER_START:    the container still exists and the stored command is
 *                    re-run by `docker start` (its original entrypoint).
 * - DOCKER_SNAPSHOT: the container still exists but a new command was given,
 *                    so its filesystem is committed to an image and a derived
 *                    container runs the new command. This avoids
 *                    `docker start -ai`, which would re-run the original
 *                    entrypoint from scratch.
 * - RELAUNCH:        nothing is left of the session, so the command is
 *                    launched again through the stored isolation options.
 */

const {
  DOCKER_CONTAINER_CLEANUP_POLICY,
  getDockerCommand,
  getDockerContainerCleanupPolicy,
  startDetachedDockerCompletionWatcher,
} = require('./docker-cleanup');
const { escapeForLinksNotation } = require('./output-blocks');
const { runCommand } = require('./execution-control');
const { SessionState, probeSession } = require('./session-probe');
const {
  ResumeAllAction,
  resumeAllExecutions,
} = require('./execution-resume-all');

/**
 * Strategies `buildResumePlan` can pick.
 */
const ResumeMode = {
  DOCKER_START: 'docker-start',
  DOCKER_SNAPSHOT: 'docker-snapshot',
  RELAUNCH: 'relaunch',
};

/**
 * Build the docker image name used to snapshot a container before running a
 * new command in it. Docker repository names must be lowercase and limited to
 * `[a-z0-9._-]`, so session names are sanitized.
 * @param {string} sessionName - Original session name
 * @param {number} attempt - Resume counter (1-based)
 * @returns {string} Image reference
 */
function buildSnapshotImageName(sessionName, attempt) {
  const sanitized = String(sessionName)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '');
  return `start-command-resume/${sanitized || 'session'}:${attempt}`;
}

/**
 * Build the container name for a snapshot-based resume.
 * @param {string} sessionName - Original session name
 * @param {number} attempt - Resume counter (1-based)
 * @returns {string} Container name
 */
function buildResumedSessionName(sessionName, attempt) {
  return `${sessionName}-resume-${attempt}`;
}

/**
 * Rebuild the isolation options stored on a record so the command can be
 * launched again with the same configuration.
 * @param {object} record - Execution record
 * @returns {object} Options for `runIsolated`
 */
function buildLaunchOptions(record) {
  const opts = record.options || {};
  return {
    image: opts.image || null,
    session: opts.sessionName,
    detached: true,
    endpoint: opts.endpoint || null,
    user: opts.user || false,
    keepAlive: opts.keepAlive || false,
    autoRemoveDockerContainer: opts.autoRemoveDockerContainer || false,
    alwaysCleanupContainer: opts.alwaysCleanupContainer || false,
    keepContainer: opts.keepContainer || false,
    keepContainerOnFail: opts.keepContainerOnFail || false,
    useCommandStream: opts.useCommandStream || false,
    shell: opts.shell || 'auto',
    privileged: opts.privileged || false,
    env: opts.env || [],
    volumes: opts.volumes || [],
    mounts: opts.mounts || [],
    networks: opts.networks || [],
    networkAliases: opts.networkAliases || [],
    // Append to the same log so one logical session keeps one gap-free record.
    logPath: record.logPath || null,
  };
}

/**
 * Decide how a stored execution should be resumed.
 * @param {object} record - Execution record
 * @param {?string} newCommand - Replacement command (from `-- <command>`)
 * @param {object} probe - Result of `probeSession`
 * @returns {object} Resume plan, or {error}
 */
function buildResumePlan(record, newCommand, probe = {}) {
  const opts = (record && record.options) || {};
  const backend = opts.isolated;
  const sessionName = opts.sessionName;

  if (!sessionName) {
    return {
      error: 'Execution record does not contain an isolation session name.',
    };
  }

  if (opts.isolationMode !== 'detached') {
    return { error: 'Only detached isolated executions can be resumed.' };
  }

  if (probe.alive) {
    return {
      error:
        `Session "${sessionName}" is still running. ` +
        `Use \`$ --attach ${record.uuid}\` to re-enter it, or \`$ --stop ${record.uuid}\` first.`,
    };
  }

  const command = newCommand || record.command;
  if (!command) {
    return {
      error: `Execution "${record.uuid}" has no stored command to resume.`,
    };
  }

  const attempt = (Number(opts.resumeCount) || 0) + 1;

  if (backend === 'docker' && probe.state === SessionState.STOPPED) {
    if (!newCommand) {
      return {
        mode: ResumeMode.DOCKER_START,
        backend,
        sessionName,
        command,
        attempt,
        steps: [
          {
            command: getDockerCommand(),
            args: ['start', sessionName],
            description: `Start stopped container ${sessionName}`,
          },
        ],
        message: `Resumed detached docker container: ${sessionName}`,
      };
    }

    // Lazily required: isolation.js pulls in this module's siblings, so a
    // top-level require would create a cycle.
    const { buildDockerRuntimeArgs } = require('./isolation');
    const snapshotImage = buildSnapshotImageName(sessionName, attempt);
    const newSessionName = buildResumedSessionName(sessionName, attempt);
    return {
      mode: ResumeMode.DOCKER_SNAPSHOT,
      backend,
      sessionName,
      newSessionName,
      snapshotImage,
      command,
      attempt,
      steps: [
        {
          command: getDockerCommand(),
          args: ['commit', sessionName, snapshotImage],
          description: `Snapshot container ${sessionName} as ${snapshotImage}`,
        },
        {
          command: getDockerCommand(),
          args: [
            'run',
            '-d',
            '--name',
            newSessionName,
            ...(opts.user ? ['--user', opts.user] : []),
            ...buildDockerRuntimeArgs(opts),
            snapshotImage,
            'sh',
            '-c',
            command,
          ],
          description: `Run the new command in ${newSessionName}`,
        },
      ],
      message: `Resumed session in new container ${newSessionName} from snapshot of ${sessionName}`,
    };
  }

  return {
    mode: ResumeMode.RELAUNCH,
    backend,
    sessionName,
    command,
    attempt,
    steps: [],
    launchOptions: buildLaunchOptions(record),
    message: `Relaunched ${backend} session: ${sessionName}`,
  };
}

/**
 * Format a resume result as links notation.
 * @param {object} result - Resume result fields
 * @returns {string} Links notation block
 */
function formatResumeResultAsLinksNotation(result) {
  const lines = [
    'executionResume',
    `  identifier ${escapeForLinksNotation(result.identifier)}`,
    `  uuid ${escapeForLinksNotation(result.uuid)}`,
    `  mode ${escapeForLinksNotation(result.mode)}`,
    `  backend ${escapeForLinksNotation(result.backend)}`,
    `  sessionName ${escapeForLinksNotation(result.sessionName)}`,
  ];
  if (result.previousSessionName) {
    lines.push(
      `  previousSessionName ${escapeForLinksNotation(result.previousSessionName)}`
    );
  }
  if (result.snapshotImage) {
    lines.push(
      `  snapshotImage ${escapeForLinksNotation(result.snapshotImage)}`
    );
  }
  lines.push(`  command ${escapeForLinksNotation(result.command)}`);
  lines.push(`  message ${escapeForLinksNotation(result.message)}`);
  return lines.join('\n');
}

function formatResumeResult(result, outputFormat) {
  if (outputFormat === 'json') {
    return JSON.stringify(result, null, 2);
  }
  if (outputFormat === 'text') {
    return [
      `Resume Mode:   ${result.mode}`,
      `UUID:          ${result.uuid}`,
      `Backend:       ${result.backend}`,
      `Session Name:  ${result.sessionName}`,
      `Command:       ${result.command}`,
      result.message,
    ].join('\n');
  }
  return formatResumeResultAsLinksNotation(result);
}

/**
 * Apply the resume outcome to the stored record, keeping the original UUID so
 * one logical session stays addressable across restarts.
 * @param {object} record - Execution record
 * @param {object} plan - Resume plan
 * @param {?string} containerId - New container id, when one was created
 * @returns {object} The updated record
 */
function applyResumeToRecord(record, plan, containerId) {
  const options = { ...(record.options || {}) };
  options.resumeCount = plan.attempt;
  options.resumedAt = new Date().toISOString();

  if (plan.newSessionName) {
    options.sessionNameHistory = [
      ...(options.sessionNameHistory || []),
      options.sessionName,
    ];
    options.sessionName = plan.newSessionName;
  }
  if (plan.snapshotImage) {
    options.image = plan.snapshotImage;
  }
  if (containerId) {
    options.containerId = containerId;
  }

  record.options = options;
  record.command = plan.command;
  record.status = 'executing';
  record.exitCode = null;
  record.endTime = null;
  record.exitReason = undefined;
  record.oomKilled = undefined;
  return record;
}

function activeSessionName(plan) {
  return plan.newSessionName || plan.sessionName;
}

/**
 * Resume a tracked execution by UUID or session name.
 * @param {?object} store - Execution store
 * @param {string} identifier - UUID or session name
 * @param {object} deps - {command, outputFormat, probe, runner, startWatcher, runIsolated}
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
async function resumeExecution(store, identifier, deps = {}) {
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

  const runner = deps.runner || runCommand;
  const probeFn = deps.probe || ((r) => probeSession(r, runner));
  const plan = buildResumePlan(record, deps.command || null, probeFn(record));
  if (plan.error) {
    return { success: false, error: plan.error };
  }

  let containerId = null;

  if (plan.mode === ResumeMode.RELAUNCH) {
    const runIsolated = deps.runIsolated || require('./isolation').runIsolated;
    const launchResult = await runIsolated(
      plan.backend,
      plan.command,
      plan.launchOptions
    );
    if (!launchResult || !launchResult.success) {
      return {
        success: false,
        error: `Failed to relaunch ${plan.backend} session "${plan.sessionName}": ${
          (launchResult && launchResult.message) || 'unknown error'
        }`,
      };
    }
    containerId = launchResult.containerId || null;
  } else {
    for (const step of plan.steps) {
      const result = runner(step.command, step.args);
      if (!result.success) {
        const detail =
          (result.stderr || '').trim() ||
          result.error ||
          `exit code ${result.status}`;
        return {
          success: false,
          error: `Failed to resume ${plan.backend} session "${plan.sessionName}": ${detail}`,
        };
      }
      containerId = (result.stdout || '').trim() || containerId;
    }

    // The completion watcher died with the previous run (or with the
    // supervisor), so a new one must follow the resumed container.
    const startWatcher =
      deps.startWatcher || startDetachedDockerCompletionWatcher;
    startWatcher(
      activeSessionName(plan),
      getDockerContainerCleanupPolicy(record.options || {}),
      record.logPath || null
    );
  }

  const previousSessionName = plan.newSessionName ? plan.sessionName : null;
  const updated = applyResumeToRecord(record, plan, containerId);
  store.save(updated);

  return {
    success: true,
    output: formatResumeResult(
      {
        identifier,
        uuid: updated.uuid,
        mode: plan.mode,
        backend: plan.backend,
        sessionName: updated.options.sessionName,
        previousSessionName,
        snapshotImage: plan.snapshotImage || null,
        command: plan.command,
        message: plan.message,
      },
      deps.outputFormat
    ),
  };
}

module.exports = {
  ResumeAllAction,
  ResumeMode,
  resumeAllExecutions,
  applyResumeToRecord,
  buildLaunchOptions,
  buildResumePlan,
  buildResumedSessionName,
  buildSnapshotImageName,
  formatResumeResult,
  formatResumeResultAsLinksNotation,
  resumeExecution,
  DOCKER_CONTAINER_CLEANUP_POLICY,
};
