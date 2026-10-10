/**
 * Resume tracked detached executions (issue #162).
 *
 * `--resume <id>` restarts a stored execution, and `--resume <id> -- <command>`
 * runs a *different* command against the same container filesystem. Both keep
 * the original execution UUID so `--status`, `--list` and `--upload-log` keep
 * addressing one logical session across restarts.
 *
 * Three strategies, chosen from the probed session state:
 * - DOCKER_START:    the container still exists. Newly managed containers
 *                    accept replacement commands through a small handoff
 *                    script, then restart in place without a snapshot.
 * - DOCKER_SNAPSHOT: a legacy container needs a replacement command, or
 *                    immutable labels need changing. After disk preflight,
 *                    its filesystem is committed under a host-wide lock and
 *                    a derived container runs the command.
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
const {
  buildResourceLimitsStatusLine,
  normalizeResourceLimits,
} = require('./docker-resource-limits');
const { appendLogFile } = require('./isolation-log-utils');
const {
  appendLifecycle,
  archiveAttempt,
  createAttempt,
  patchAttempt,
} = require('./execution-attempt');
const { runCommand } = require('./execution-control');
const {
  reserveLaunch,
  rollbackLaunch,
  failLaunchedPersistence,
} = require('./launch-persistence');
const { SessionState, probeSession } = require('./session-probe');
const { getDockerNetworks } = require('./docker-network-lifecycle');
const {
  writeCommandHandoff,
  buildCommandHandoffArgs,
  commandHandoffPath,
} = require('./docker-command-handoff');
const {
  acquireSnapshotLock,
  preflightSnapshot,
  SNAPSHOT_IMAGE_LABEL,
} = require('./docker-snapshot-safety');
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
    ...opts,
    labels: opts.labels || [],
    sessionId: record.uuid,
    rootSession:
      opts.rootSession || opts.sessionNameHistory?.[0] || opts.sessionName,
    resumeCount: (Number(opts.resumeCount) || 0) + 1,
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
    // Limits captured from the container on an earlier resume (issue #176).
    resourceLimits: normalizeResourceLimits(opts.resourceLimits),
    // Append to the same log so one logical session keeps one gap-free record.
    logPath: record.logPath || null,
    deferCompletionWatcher: true,
  };
}

/**
 * Build the steps that start a snapshot-derived container.
 *
 * `docker run` can only join one network, so a session that was launched on
 * several networks is rebuilt the same way `runIsolated` builds it: create the
 * container, connect the additional networks, then start it. Dropping to a
 * single `docker run` when there is nothing extra to connect keeps the common
 * case to one command.
 *
 * @param {object} params - {containerArgs, extraNetworks, newSessionName, snapshotImage}
 * @returns {object[]} Resume steps
 */
function buildSnapshotStartSteps({
  containerArgs,
  extraNetworks,
  newSessionName,
  snapshotImage,
}) {
  if (extraNetworks.length === 0) {
    return [
      {
        command: getDockerCommand(),
        args: ['run', '-d', ...containerArgs],
        description: `Run the new command in ${newSessionName}`,
      },
    ];
  }

  return [
    {
      command: getDockerCommand(),
      args: ['create', ...containerArgs],
      description: `Create ${newSessionName} from ${snapshotImage}`,
    },
    ...extraNetworks.map((network) => ({
      command: getDockerCommand(),
      args: ['network', 'connect', network, newSessionName],
      description: `Connect ${newSessionName} to network ${network}`,
    })),
    {
      command: getDockerCommand(),
      args: ['start', newSessionName],
      description: `Run the new command in ${newSessionName}`,
    },
  ];
}

/**
 * Decide how a stored execution should be resumed.
 * @param {object} record - Execution record
 * @param {?string} newCommand - Replacement command (from `-- <command>`)
 * @param {object} probe - Result of `probeSession`
 * @param {?string[]} [liveResourceLimits] - Limits read from the stopped
 *   container with `docker inspect`; falls back to the stored ones when null
 * @returns {object} Resume plan, or {error}
 */
function buildResumePlan(
  record,
  newCommand,
  probe = {},
  liveResourceLimits = null
) {
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
    if (!opts.forceSnapshot && (!newCommand || opts.commandHandoff)) {
      return {
        mode: ResumeMode.DOCKER_START,
        backend,
        sessionName,
        command,
        ...(newCommand ? { handoffCommand: command } : {}),
        attempt,
        steps: [
          {
            command: getDockerCommand(),
            args: ['start', sessionName],
            description: `Start stopped container ${sessionName}`,
          },
        ],
        message: newCommand
          ? `Resumed new command in the same detached docker container: ${sessionName} (no filesystem snapshot)`
          : `Resumed detached docker container: ${sessionName}`,
      };
    }

    // Lazily required: isolation.js pulls in this module's siblings, so a
    // top-level require would create a cycle.
    const { buildDockerRuntimeArgs } = require('./isolation');
    // `docker commit` keeps the filesystem but not the HostConfig, so the
    // limits must be passed to the new container explicitly (issue #176).
    const resourceLimits = normalizeResourceLimits(
      liveResourceLimits || opts.resourceLimits
    );
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
      resourceLimits,
      steps: [
        {
          command: getDockerCommand(),
          args: ['commit', sessionName, snapshotImage],
          description: `Snapshot container ${sessionName} as ${snapshotImage}`,
        },
        ...buildSnapshotStartSteps({
          containerArgs: [
            '--name',
            newSessionName,
            '--label',
            `${SNAPSHOT_IMAGE_LABEL}=${snapshotImage}`,
            ...(opts.user ? ['--user', opts.user] : []),
            ...buildDockerRuntimeArgs({
              ...opts,
              resourceLimits,
              session: newSessionName,
              containerName: newSessionName,
              sessionId: record.uuid,
              rootSession:
                opts.rootSession || opts.sessionNameHistory?.[0] || sessionName,
              resumeCount: attempt,
            }),
            snapshotImage,
            ...buildCommandHandoffArgs(
              ['sh', '-c', command],
              commandHandoffPath(newSessionName)
            ),
          ],
          extraNetworks: getDockerNetworks(opts).slice(1),
          newSessionName,
          snapshotImage,
        }),
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
  if (result.resourceLimits && result.resourceLimits.length > 0) {
    lines.push(
      `  resourceLimits ${escapeForLinksNotation(result.resourceLimits.join(' '))}`
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
      ...(result.resourceLimits && result.resourceLimits.length > 0
        ? [`Resource Limits: ${result.resourceLimits.join(' ')}`]
        : []),
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
function applyResumeToRecord(
  record,
  plan,
  containerId,
  attempt = createAttempt(record, plan)
) {
  archiveAttempt(record);
  record.attempt = attempt;
  const options = { ...(record.options || {}) };
  options.rootSession =
    options.rootSession ||
    options.sessionNameHistory?.[0] ||
    options.sessionName;
  options.resumeCount = plan.attempt;
  options.resumedAt = attempt.startedAt;
  // A resume is a new deliberate start: launch-time recovery applies again.
  delete options.stopRequestedAt;
  delete options.exitEvidence;
  if (plan.resourceLimits && plan.resourceLimits.length > 0) {
    options.resourceLimits = plan.resourceLimits;
  }

  if (plan.newSessionName) {
    options.sessionNameHistory = [
      ...(options.sessionNameHistory || []),
      options.sessionName,
    ];
    options.sessionName = plan.newSessionName;
  }
  if (plan.snapshotImage) {
    options.image = plan.snapshotImage;
    options.snapshotImage = plan.snapshotImage;
    // Every new detached container, including a snapshot successor, supports handoff.
    options.commandHandoff = true;
  }
  if (plan.mode === ResumeMode.RELAUNCH && plan.backend === 'docker') {
    options.commandHandoff = true;
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

  if (require('./launch-owner').hasActiveLaunch(record)) {
    return {
      success: false,
      error: 'An execution launch is already reserved.',
    };
  }
  const previousData = globalThis.structuredClone(
    record.toObject ? record.toObject() : record
  );
  const previous = record.constructor.fromObject
    ? record.constructor.fromObject(previousData)
    : previousData;
  const runner = deps.runner || runCommand;
  const probeFn = deps.probe || ((r) => probeSession(r, runner));
  const probe = probeFn(record);
  const opts = record.options || {};
  let resources;
  try {
    resources = require('./resume-resources').prepareResumeResources(
      record,
      probe,
      deps.resourceOptions || {},
      runner,
      deps.random
    );
  } catch (error) {
    return { success: false, error: error.message };
  }
  const requestedLabels = deps.resourceOptions?.labels || [];
  const labels = [...(opts.labels || [])];
  for (const label of requestedLabels) {
    const key = label.split('=')[0];
    const existing = labels.findIndex((value) => value.split('=')[0] === key);
    if (existing >= 0) {
      labels[existing] = label;
    } else {
      labels.push(label);
    }
  }
  if (requestedLabels.length && opts.isolated !== 'docker') {
    return {
      success: false,
      error: 'Docker labels require a Docker execution when resuming.',
    };
  }
  const labelsChanged =
    JSON.stringify(labels) !== JSON.stringify(opts.labels || []);
  const planningRecord = {
    ...record,
    options: {
      ...opts,
      ...(resources ? { resourceLimits: resources.resourceLimits } : {}),
      ...(requestedLabels.length ? { labels } : {}),
      ...(labelsChanged ? { forceSnapshot: true } : {}),
    },
  };
  const plan = buildResumePlan(
    planningRecord,
    deps.command || null,
    probe,
    resources?.resourceLimits
  );
  if (resources && !plan.error) {
    plan.resourceLimits = resources.resourceLimits;
    if (plan.mode === ResumeMode.DOCKER_START && resources.update) {
      plan.steps.unshift({
        command: getDockerCommand(),
        args: [
          'update',
          ...resources.resourceLimits.filter((s) =>
            /^--(?:memory|memory-swap|cpus|cpu-quota|cpu-period)=/.test(s)
          ),
          plan.sessionName,
        ],
      });
    }
  }
  if (plan.error) {
    return { success: false, error: plan.error };
  }

  let containerId = null;
  const attempt = createAttempt(record, plan);
  const lifecycleRecord = {
    uuid: record.uuid,
    logPath: record.logPath,
    attempt,
  };
  appendLifecycle(lifecycleRecord, 'resume-started');
  const updated = applyResumeToRecord(record, plan, null, attempt);
  if (requestedLabels.length) {
    updated.options.labels = labels;
  }
  if (resources) {
    updated.options.resolvedLimits = resources.resolvedLimits;
    updated.options.resourceLimitSpecs = resources.resourceLimitSpecs;
    if (
      opts.cpuPenaltyConfig &&
      deps.resourceOptions?.cpus !== null &&
      deps.resourceOptions?.cpus !== undefined
    ) {
      updated.options.baseResourceLimits = resources.resourceLimits;
    }
  }
  try {
    reserveLaunch(store, updated, previous);
  } catch (error) {
    appendLifecycle(lifecycleRecord, 'launch-failed', { error: error.message });
    return {
      success: false,
      error: `Launch reservation failed: ${error.message}`,
    };
  }

  if (resources && deps.resourceOptions?.memory && record.logPath) {
    const oldMemory = resources.oldMemory;
    appendLogFile(
      record.logPath,
      `Resume memory limit: ${oldMemory} -> ${resources.resolvedLimits.memory} (${deps.resourceOptions.memory})\n`
    );
  }

  if (plan.mode === ResumeMode.RELAUNCH) {
    const runIsolated = deps.runIsolated || require('./isolation').runIsolated;
    let launchResult;
    try {
      launchResult = await runIsolated(
        plan.backend,
        plan.command,
        plan.launchOptions
      );
    } catch (error) {
      launchResult = { success: false, message: error.message };
    }
    if (!launchResult || !launchResult.success) {
      rollbackLaunch(store, previous);
      appendLifecycle(lifecycleRecord, 'launch-failed', {
        error: launchResult?.message || 'unknown error',
      });
      return {
        success: false,
        error: `Failed to relaunch ${plan.backend} session "${plan.sessionName}": ${
          (launchResult && launchResult.message) || 'unknown error'
        }`,
      };
    }
    containerId = launchResult.containerId || null;
  } else {
    let snapshotLock;
    let snapshotCreated = false;
    let derivedCreated = false;
    try {
      if (plan.mode === ResumeMode.DOCKER_SNAPSHOT) {
        snapshotLock = acquireSnapshotLock(deps.snapshotOptions);
        const preflight = preflightSnapshot(
          plan.sessionName,
          runner,
          deps.snapshotOptions
        );
        plan.message += `\n${preflight.message}`;
        if (record.logPath) {
          appendLogFile(record.logPath, `${preflight.message}\n`);
        }
      }
      if (plan.handoffCommand) {
        const copied = writeCommandHandoff(
          plan.sessionName,
          plan.handoffCommand,
          runner,
          opts
        );
        if (!copied.success) {
          throw new Error(
            (copied.stderr || '').trim() ||
              copied.error ||
              'Could not copy replacement command into the stopped container'
          );
        }
      }
      for (const step of plan.steps) {
        let result;
        try {
          result = runner(step.command, step.args);
        } catch (error) {
          result = { success: false, error: error.message };
        }
        if (!result.success) {
          const detail =
            (result.stderr || '').trim() ||
            result.error ||
            `exit code ${result.status}`;
          throw new Error(detail);
        }
        if (step.args[0] === 'commit') {
          snapshotCreated = true;
        }
        if (step.args[0] === 'create') {
          derivedCreated = true;
        }
        // commit returns an image ID; cp/update/network commands are not IDs.
        if (['run', 'create'].includes(step.args[0])) {
          containerId = (result.stdout || '').trim() || containerId;
        }
      }
      if (plan.mode === ResumeMode.DOCKER_SNAPSHOT && deps.removeOriginal) {
        const running = runner(getDockerCommand(), [
          'inspect',
          '-f',
          '{{.State.Running}}',
          plan.newSessionName,
        ]);
        if (running.success && String(running.stdout).trim() === 'true') {
          const removed = runner(getDockerCommand(), ['rm', plan.sessionName]);
          const note = removed.success
            ? `Stopped original container removed: ${plan.sessionName}`
            : `Original container retained: ${(removed.stderr || removed.error || 'docker rm failed').trim()}`;
          plan.message += `\n${note}`;
          if (record.logPath) {
            appendLogFile(record.logPath, `${note}\n`);
          }
        } else {
          plan.message +=
            '\nOriginal container retained: the snapshot container is not running.';
        }
      }
    } catch (error) {
      if (derivedCreated) {
        runner(getDockerCommand(), ['rm', plan.newSessionName]);
      }
      if (snapshotCreated) {
        runner(getDockerCommand(), ['rmi', plan.snapshotImage]);
      }
      if (plan.handoffCommand) {
        // A failed start must not leave a replacement hidden behind the old record.
        try {
          writeCommandHandoff(plan.sessionName, previous.command, runner, opts);
        } catch {
          /* Next explicit command can still repair the handoff. */
        }
      }
      rollbackLaunch(store, previous);
      appendLifecycle(lifecycleRecord, 'launch-failed', {
        error: error.message,
      });
      return {
        success: false,
        error: `Failed to resume ${plan.backend} session "${plan.sessionName}": ${error.message}`,
      };
    } finally {
      snapshotLock?.release();
    }

    const limitsLine = buildResourceLimitsStatusLine(plan.resourceLimits);
    if (limitsLine && record.logPath) {
      appendLogFile(record.logPath, `${limitsLine}\n`);
    }
  }

  const previousSessionName = plan.newSessionName ? plan.sessionName : null;
  attempt.launchAcceptedAt = new Date().toISOString();
  updated.options.launchPending = false;
  if (containerId) {
    updated.options.containerId = containerId;
  }
  let persistenceError = null;
  try {
    store.save(updated);
  } catch (error) {
    persistenceError = error;
  }
  appendLifecycle(updated, 'launch-accepted');

  if (plan.backend === 'docker') {
    try {
      const startWatcher =
        deps.startWatcher || startDetachedDockerCompletionWatcher;
      const watcher = startWatcher(
        activeSessionName(plan),
        getDockerContainerCleanupPolicy(updated.options),
        updated.logPath || null,
        updated.uuid || null,
        {
          since: attempt.startedAt,
          attemptNumber: attempt.number,
          recoverOnKill:
            plan.mode !== ResumeMode.DOCKER_SNAPSHOT &&
            Boolean(opts.onKillResume),
        }
      );
      if (watcher === false) {
        throw new Error('Watcher process could not be started');
      }
      const current = persistenceError
        ? null
        : patchAttempt(store, updated, {
            watcherAttachedAt: new Date().toISOString(),
          });
      if (current) {
        appendLifecycle(current, 'watcher-attached');
      }
    } catch (error) {
      if (persistenceError) {
        return {
          success: false,
          error: failLaunchedPersistence(
            store,
            updated,
            runner,
            persistenceError
          ),
        };
      }
      const current = persistenceError
        ? null
        : patchAttempt(store, updated, {
            watcherError: error.message,
          });
      appendLifecycle(current || updated, 'watcher-attachment-failed', {
        error: error.message,
      });
      return {
        success: false,
        error: `Launch accepted for container ${activeSessionName(plan)}, but completion watcher attachment failed: ${error.message}`,
      };
    }
  }

  if (persistenceError) {
    // The reservation remains durable and the watcher is attached. Stop the
    // new container rather than allow an untracked command to keep running.
    return {
      success: false,
      error: failLaunchedPersistence(store, updated, runner, persistenceError),
    };
  }

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
        resourceLimits: plan.resourceLimits || null,
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
