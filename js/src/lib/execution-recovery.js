/**
 * Launch-time recovery for killed detached docker sessions (issue #176).
 *
 * `$ --isolated docker --detached --on-kill-resume 3 --recovery-command B -- A`
 * runs `A`; when the main process is killed (exit 137, or `OOMKilled` with no
 * exit status of its own), the detached completion watcher hands the inspected
 * facts to this module, which restarts the *same* container so `B` continues
 * on the same filesystem, with the same resource limits (they live in the
 * container's HostConfig), under the same execution UUID and appending to the
 * same log file.
 *
 * How `B` replaces `A` inside the same container: a container launched with a
 * recovery command runs a tiny selector as its entrypoint command. The
 * selector runs `A` normally, but runs `B` when the marker file exists. Before
 * `docker start`, the marker (holding the attempt number) is copied into the
 * stopped container with `docker cp`. Without a recovery command the original
 * command is simply started again.
 *
 * Like `detached-finalize.js`, the entry point runs as a short-lived child of
 * the watcher on a host whose CLI invocation is long gone, so it never throws.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getDockerCommand,
  getDockerContainerCleanupPolicy,
  startDetachedDockerCompletionWatcher,
} = require('./docker-cleanup');
const {
  SHELL_VARS,
  describeExitCode,
  formatContainerPostMortem,
} = require('./docker-post-mortem');
const {
  buildResourceLimitsStatusLine,
  readDockerResourceLimits,
} = require('./docker-resource-limits');
const { shellQuote } = require('./isolation-log-utils');
const {
  CGROUP_SHELL_VARS,
  formatCgroupMemoryLogLine,
  parseCgroupMemorySample,
} = require('./cgroup-memory');
const {
  formatRecoveryDelay,
  getOnKillResumeDelay,
  pickRecoveryDelayMs,
  waitForRecoveryDelay,
} = require('./recovery-delay');

/** File whose presence makes the selector run the recovery command. */
const RECOVERY_MARKER_PATH = '/.start-command-recovery';

/** Environment variable carrying the attempt number into the recovery command. */
const RECOVERY_ATTEMPT_ENV = 'START_COMMAND_RECOVERY_ATTEMPT';

/** Exit code of a process killed with SIGKILL (the OOM killer's signal). */
const KILLED_EXIT_CODE = 137;

/**
 * POSIX selector run as the container command when a recovery command is set:
 *   sh -c SELECTOR start-command <shell> <flag> <recovery> <main argv...>
 */
const RECOVERY_SELECTOR =
  's=$1; f=$2; r=$3; shift 3; ' +
  `if [ -e ${RECOVERY_MARKER_PATH} ]; then ` +
  `${RECOVERY_ATTEMPT_ENV}=$(cat ${RECOVERY_MARKER_PATH} 2>/dev/null); ` +
  `export ${RECOVERY_ATTEMPT_ENV}; ` +
  'if [ -n "$f" ]; then exec "$s" "$f" -c "$r"; fi; exec "$s" -c "$r"; fi; ' +
  'exec "$@"';

/**
 * Wrap the container command so a later `docker start` can switch to the
 * recovery command.
 * @param {string[]} mainArgs - Container command for the main run
 * @param {object} params - {shell, shellFlag, recoveryCommand}
 * @returns {string[]} Container command
 */
function buildRecoverySelectorArgs(mainArgs, params) {
  return [
    'sh',
    '-c',
    RECOVERY_SELECTOR,
    'start-command',
    params.shell || 'sh',
    params.shellFlag || '',
    params.recoveryCommand,
    ...mainArgs,
  ];
}

/**
 * Whether the main process was killed.
 *
 * Exit 137 (SIGKILL, the OOM killer's signal) always counts. `OOMKilled` alone
 * does not: Docker sets it when *any* process in the container's cgroup was
 * OOM-killed (a compiler, a test runner, a child `node`), and it stays set
 * until the container is started again. A main process that survived that and
 * then exited 0-127 on its own ran to completion, so the flag only counts when
 * there is no usable exit status (the watcher's `-1`, or nothing at all)
 * (issue #178).
 *
 * @param {number|string|null} exitCode - `.State.ExitCode`
 * @param {boolean|string|null} oomKilled - `.State.OOMKilled`
 * @returns {boolean} Whether the main process was killed
 */
function isKilledExit(exitCode, oomKilled) {
  const { code } = describeExitCode(exitCode);
  if (code === KILLED_EXIT_CODE) {
    return true;
  }
  const oom = oomKilled === true || oomKilled === 'true';
  return oom && (code === null || code < 0);
}

/**
 * Shell condition run by the completion watcher: true when the container was
 * killed and the recovery entry point resumed it. Mirrors `isKilledExit()`:
 * `OOMKilled` only counts without a non-negative exit code (issue #178).
 * @param {string} executionId - Execution UUID
 * @returns {string} POSIX shell condition
 */
function buildRecoverySnippet(executionId) {
  const v = SHELL_VARS;
  return (
    `{ [ "$${v.exit}" = ${KILLED_EXIT_CODE} ] || ` +
    `{ [ "$${v.oom}" = true ] && ! [ "$${v.exit}" -ge 0 ] 2>/dev/null; }; } && ` +
    `${shellQuote(process.execPath)} ${shellQuote(__filename)} ` +
    `${shellQuote(executionId)} "$${v.exit}" "$${v.oom}" ` +
    `"$${v.started}" "$${v.finished}" "$${v.error}" ` +
    `"$${CGROUP_SHELL_VARS.sample}" >/dev/null 2>&1`
  );
}

/**
 * The `[Recovery k/N]` separator written into the session log.
 * @param {object} params - {attempt, maxAttempts, exitCode, oomKilled, containerName, command, delayMs}
 * @returns {string} Separator line, newline terminated
 */
function formatRecoverySeparator(params) {
  const described = describeExitCode(params.exitCode);
  const signal = described.signal ? `, ${described.signal}` : '';
  const what = params.command
    ? `running recovery command: ${params.command}`
    : 'running the original command again';
  const delay =
    params.delayMs > 0
      ? ` after a ${formatRecoveryDelay(params.delayMs)} delay`
      : '';
  return (
    `\n[Recovery ${params.attempt}/${params.maxAttempts}] ` +
    `Main process was killed (exit ${described.code}${signal}, ` +
    `oomKilled=${params.oomKilled === true || params.oomKilled === 'true'}); ` +
    `resuming container ${params.containerName}${delay}, ${what}\n`
  );
}

function isStopRequested(store, executionId) {
  try {
    const current = store.get(executionId);
    return Boolean(
      current && current.options && current.options.stopRequestedAt
    );
  } catch {
    return false;
  }
}

function appendToLog(logPath, text) {
  if (!logPath) {
    return;
  }
  try {
    fs.appendFileSync(logPath, text);
  } catch {
    // The log is best-effort here: recovery itself must still proceed.
  }
}

function writeRecoveryMarker(containerName, attempt, runner) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-recovery-'));
  const file = path.join(dir, 'marker');
  try {
    fs.writeFileSync(file, `${attempt}\n`, { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    return runner(getDockerCommand(), [
      'cp',
      file,
      `${containerName}:${RECOVERY_MARKER_PATH}`,
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function failureDetail(result) {
  return (
    (result.stderr || '').trim() || result.error || `exit code ${result.status}`
  );
}

/**
 * Resume a killed execution in its own container, after the random
 * `--on-kill-resume-delay` wait (issue #181) when one was requested.
 * @param {object} params - {store, executionId, exitCode, oomKilled, startedAt,
 *   finishedAt, containerError, cgroupMemory, runner, startWatcher, now,
 *   random, sleep}; `cgroupMemory` is the watcher's last cgroup v2 sample
 *   (issue #182)
 * @returns {{recovered: boolean, reason: string, attempt?: number, delayMs?: number}} Outcome
 */
function recoverKilledExecution(params = {}) {
  const { store, executionId } = params;
  if (!store || !executionId) {
    return { recovered: false, reason: 'missing-arguments' };
  }
  const record = store.get(executionId);
  if (!record) {
    return { recovered: false, reason: 'record-not-found' };
  }
  const opts = record.options || {};
  const maxAttempts = Number(opts.onKillResume) || 0;
  const containerName = opts.sessionName;
  if (opts.isolated !== 'docker' || !containerName || maxAttempts < 1) {
    return { recovered: false, reason: 'not-configured' };
  }
  if (!isKilledExit(params.exitCode, params.oomKilled)) {
    return { recovered: false, reason: 'not-killed' };
  }
  const log = (text) => appendToLog(record.logPath, text);
  if (opts.stopRequestedAt) {
    log('\n[Recovery] Not resuming: the session was stopped on request.\n');
    return { recovered: false, reason: 'stop-requested' };
  }
  const used = Number(opts.recoveryAttempts) || 0;
  if (used >= maxAttempts) {
    log(
      `\n[Recovery] Not resuming: all ${maxAttempts} recovery attempt(s) used.\n`
    );
    return { recovered: false, reason: 'attempts-exhausted' };
  }

  const runner = params.runner || require('./execution-control').runCommand;
  const now = params.now || (() => new Date());
  const attempt = used + 1;
  const delayRange = getOnKillResumeDelay(opts);
  const delayMs = pickRecoveryDelayMs(delayRange, params.random);
  const giveUp = (reason) => {
    log(`[Recovery ${attempt}/${maxAttempts}] Failed: ${reason}\n`);
    return { recovered: false, reason: 'resume-failed', attempt };
  };

  log(
    `\n${formatContainerPostMortem({
      containerName,
      exitCode: params.exitCode,
      oomKilled: params.oomKilled,
      startedAt: params.startedAt,
      finishedAt: params.finishedAt,
      error: params.containerError,
    })}`
  );
  const memoryLine = formatCgroupMemoryLogLine(params.cgroupMemory);
  if (memoryLine) {
    log(`${memoryLine}\n`);
  }
  log(
    formatRecoverySeparator({
      attempt,
      maxAttempts,
      exitCode: params.exitCode,
      oomKilled: params.oomKilled,
      containerName,
      command: opts.recoveryCommand || null,
      delayMs,
    })
  );

  // Executions killed by one host-wide OOM event must not all come back in
  // the same second (issue #181). `--stop` during the wait cancels the resume:
  // the container has already exited, so `docker stop` only leaves the
  // `stopRequestedAt` marker this loop polls for.
  if (delayMs > 0) {
    const cancelled = waitForRecoveryDelay({
      delayMs,
      sleep: params.sleep,
      shouldCancel: () => isStopRequested(store, executionId),
    });
    if (cancelled) {
      log(
        `[Recovery ${attempt}/${maxAttempts}] Not resuming: the session was stopped on request during the delay.\n`
      );
      return { recovered: false, reason: 'stop-requested', attempt, delayMs };
    }
  }

  // Docker keeps `docker update` limits in the HostConfig across restarts;
  // they are read back so the log and `--status` show what the resumed run
  // is held to, and so a later relaunch can re-apply them.
  const resourceLimits = readDockerResourceLimits(containerName, runner);
  const limitsLine = buildResourceLimitsStatusLine(resourceLimits);
  if (limitsLine) {
    log(`${limitsLine}\n`);
  }

  if (opts.recoveryCommand) {
    let copied;
    try {
      copied = writeRecoveryMarker(containerName, attempt, runner);
    } catch (err) {
      copied = { success: false, error: err.message };
    }
    if (!copied.success) {
      return giveUp(`could not mark the container: ${failureDetail(copied)}`);
    }
  }

  const since = now().toISOString();
  const {
    appendLifecycle,
    archiveAttempt,
    createAttempt,
    patchAttempt,
  } = require('./execution-attempt');
  const nextAttempt = record.attempt
    ? createAttempt(record, {
        mode: 'automatic-recovery',
        sessionName: containerName,
      })
    : null;
  if (nextAttempt) {
    nextAttempt.startedAt = since;
    appendLifecycle(
      { uuid: record.uuid, logPath: record.logPath, attempt: nextAttempt },
      'resume-started'
    );
  }
  const started = runner(getDockerCommand(), ['start', containerName]);
  if (!started.success) {
    if (nextAttempt) {
      appendLifecycle(
        { uuid: record.uuid, logPath: record.logPath, attempt: nextAttempt },
        'launch-failed',
        { error: failureDetail(started) }
      );
    }
    return giveUp(`docker start failed: ${failureDetail(started)}`);
  }

  const described = describeExitCode(params.exitCode);
  const delayed = delayRange ? `, delayMs=${delayMs}` : '';
  // The killed run's own counters: the resumed run starts a fresh cgroup.
  const memory = parseCgroupMemorySample(params.cgroupMemory);
  if (nextAttempt) {
    Object.assign(record, {
      status: 'executed',
      exitCode: described.code,
      endTime: params.finishedAt || null,
      containerStartedAt: params.startedAt || undefined,
      oomKilled: params.oomKilled === true || params.oomKilled === 'true',
      cgroupMemory: memory || undefined,
    });
    archiveAttempt(record);
    nextAttempt.launchAcceptedAt = new Date().toISOString();
    record.attempt = nextAttempt;
  }
  const counted = memory
    ? ['oomEvents', 'oomKills']
        .filter((field) => memory[field] !== null)
        .map((field) => `, ${field}=${memory[field]}`)
        .join('')
    : '';
  record.options = {
    ...opts,
    recoveryAttempts: attempt,
    recoveryHistory: [
      ...(Array.isArray(opts.recoveryHistory) ? opts.recoveryHistory : []),
      `${attempt}: exit ${described.code}, oomKilled=${params.oomKilled === true || params.oomKilled === 'true'}${counted}${delayed}, resumed at ${since}`,
    ],
    lastRecoveryAt: since,
    ...(delayRange ? { lastRecoveryDelayMs: delayMs } : {}),
    ...(resourceLimits && resourceLimits.length > 0 ? { resourceLimits } : {}),
  };
  record.status = 'executing';
  record.exitCode = null;
  record.endTime = null;
  record.exitReason = undefined;
  record.oomKilled = undefined;
  record.cgroupMemory = undefined;
  record.memoryExhausted = undefined;
  record.memoryExhaustedReason = undefined;
  record.endTimeSource = undefined;
  record.observedAt = undefined;
  record.staleDetectedAt = undefined;
  record.containerStartedAt = undefined;
  try {
    store.save(record);
  } catch {
    // The container is already running again; the new watcher still follows
    // it and finalizes the record when it ends.
  }

  const startWatcher =
    params.startWatcher || startDetachedDockerCompletionWatcher;
  if (nextAttempt) {
    appendLifecycle(record, 'launch-accepted');
  }
  startWatcher(
    containerName,
    getDockerContainerCleanupPolicy(opts),
    record.logPath || null,
    record.uuid,
    {
      since,
      recoverOnKill: true,
      ...(nextAttempt ? { attemptNumber: nextAttempt.number } : {}),
    }
  );
  if (nextAttempt) {
    const current = patchAttempt(store, record, {
      watcherAttachedAt: new Date().toISOString(),
    });
    if (current) {
      appendLifecycle(current, 'watcher-attached');
    }
  }
  return {
    recovered: true,
    reason: 'resumed',
    attempt,
    ...(delayRange ? { delayMs } : {}),
  };
}

/**
 * Entry point used by the detached watcher:
 *   <runtime> execution-recovery.js <uuid> <exit> <oom> <started> <finished> <error> <cgroup>
 * Exits 0 only when the container was resumed; any other outcome lets the
 * watcher continue with its normal cleanup, footer and finalization.
 * @param {string[]} argv - Positional arguments
 * @returns {number} Process exit code
 */
function main(argv) {
  const [
    executionId,
    exitCode,
    oomKilled,
    startedAt,
    finishedAt,
    error,
    cgroupMemory,
  ] = argv;
  if (!executionId || process.env.START_DISABLE_TRACKING === 'true') {
    return 1;
  }
  try {
    const { ExecutionStore } = require('./execution-store');
    const store = new ExecutionStore(
      process.env.START_APP_FOLDER
        ? { appFolder: path.resolve(process.env.START_APP_FOLDER) }
        : {}
    );
    const outcome = recoverKilledExecution({
      store,
      executionId,
      exitCode,
      oomKilled,
      startedAt,
      finishedAt,
      containerError: error,
      cgroupMemory,
    });
    return outcome.recovered ? 0 : 1;
  } catch (err) {
    // The watcher discards this output; START_DEBUG=1 shows it when the
    // entry point is run by hand.
    if (process.env.START_DEBUG === '1' || process.env.START_DEBUG === 'true') {
      console.error(`[DEBUG] execution-recovery failed: ${err.stack || err}`);
    }
    return 1;
  }
}

module.exports = {
  KILLED_EXIT_CODE,
  RECOVERY_ATTEMPT_ENV,
  RECOVERY_MARKER_PATH,
  RECOVERY_SELECTOR,
  buildRecoverySelectorArgs,
  buildRecoverySnippet,
  formatRecoverySeparator,
  isKilledExit,
  main,
  recoverKilledExecution,
};

// After `module.exports`: run as the watcher's entry point, recovery starts the
// next watcher through `docker-cleanup.js`, which requires this module back
// and needs its exports complete.
if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
