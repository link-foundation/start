const { spawn, spawnSync } = require('child_process');
const {
  appendLogFile,
  createShellLogFooterSnippet,
  FATAL_MARKER_TAIL_BYTES,
  readLogTail,
  shellQuote,
} = require('./isolation-log-utils');
const { resolveMemoryExhaustion } = require('./exit-reason');
const {
  buildDockerPostMortemSnippet,
  buildDockerRemovalNoteSnippet,
  buildDockerStateSnippet,
} = require('./docker-post-mortem');
const { buildDetachedFinalizeSnippet } = require('./detached-finalize');

const DOCKER_CONTAINER_CLEANUP_POLICY = {
  DEFAULT: 'default',
  ALWAYS: 'always',
  KEEP: 'keep',
  KEEP_ON_FAIL: 'keep-on-fail',
};

function getDockerCommand() {
  return process.env.START_DOCKER_BIN || 'docker';
}

function getDockerSpawnOptions(options = {}) {
  if (process.platform === 'win32' && process.env.START_DOCKER_BIN) {
    return { ...options, shell: true };
  }
  return options;
}

function getDockerContainerCleanupPolicy(options = {}) {
  if (options.keepContainer) {
    return DOCKER_CONTAINER_CLEANUP_POLICY.KEEP;
  }
  if (options.keepContainerOnFail) {
    return DOCKER_CONTAINER_CLEANUP_POLICY.KEEP_ON_FAIL;
  }
  if (options.alwaysCleanupContainer || options.autoRemoveDockerContainer) {
    return DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS;
  }
  return DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT;
}

function isAbnormalDockerExit(exitCode, oomKilled = false) {
  return exitCode !== 0 || oomKilled === true;
}

function shouldCleanupDockerContainer(policy, exitCode, oomKilled = false) {
  if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS) {
    return true;
  }
  if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT) {
    return !isAbnormalDockerExit(exitCode, oomKilled);
  }
  if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.KEEP_ON_FAIL) {
    return !isAbnormalDockerExit(exitCode, oomKilled);
  }
  return false;
}

function getDockerContainerCleanupInstructions(containerName) {
  return [
    `Container kept for investigation: ${containerName}`,
    `Re-enter while running: $ --attach ${containerName}`,
    `Continue the stored command: $ --resume ${containerName}`,
    `Run another command in the same container: $ --resume ${containerName} -- <command>`,
    `Remove when done: docker rm -f ${containerName}`,
  ].join('\n');
}

function appendDockerContainerCleanupPolicyMessage(
  message,
  containerName,
  policy
) {
  if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.KEEP) {
    return `${message}\n${getDockerContainerCleanupInstructions(containerName)}`;
  }
  if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.KEEP_ON_FAIL) {
    return (
      `${message}\nContainer will be removed after successful completion.` +
      `\nContainer will be kept if the command fails or Docker reports OOMKilled.` +
      `\nRemove when done: docker rm -f ${containerName}`
    );
  }
  if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT) {
    return (
      `${message}\nContainer will be removed after successful completion.` +
      `\nContainer will be kept if the command fails or Docker reports OOMKilled.` +
      `\nRemove when done: docker rm -f ${containerName}`
    );
  }
  return `${message}\nContainer will be removed after command completes.`;
}

function readDockerContainerOomKilled(containerName) {
  const result = spawnSync(
    getDockerCommand(),
    ['inspect', '-f', '{{.State.OOMKilled}}', containerName],
    getDockerSpawnOptions({
      encoding: 'utf8',
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  );
  if (result.error || result.status !== 0) {
    return null;
  }
  const value = String(result.stdout || '').trim();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return null;
}

function readDockerContainerStatus(containerName) {
  const result = spawnSync(
    getDockerCommand(),
    ['inspect', '-f', '{{.State.Status}}', containerName],
    getDockerSpawnOptions({
      encoding: 'utf8',
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  );
  if (result.error || result.status !== 0) {
    return null;
  }
  return String(result.stdout || '').trim() || null;
}

function removeDockerContainer(containerName, logPath = null) {
  const result = spawnSync(
    getDockerCommand(),
    ['rm', '-f', containerName],
    getDockerSpawnOptions({
      encoding: 'utf8',
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  );
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (logPath && output) {
    appendLogFile(logPath, output.endsWith('\n') ? output : `${output}\n`);
  }
  return !result.error && result.status === 0;
}

/**
 * Exit codes of a process that aborted itself: SIGABRT (134) and SIGSEGV (139).
 * These are exactly the codes a runtime produces when it dies on its own memory
 * limit — Node/V8 prints `FATAL ERROR: Reached heap limit ...` and aborts — long
 * before the container limit is reached, so the kernel never OOM-kills anything
 * and `State.OOMKilled` stays `false` (issue #165).
 */
const SELF_ABORT_EXIT_CODES = [134, 139];

/**
 * Appended to the kept-container reason for a self-abort exit code, so the
 * footer stops asserting the opposite of the `FATAL ERROR` printed a few lines
 * above it. The footer is the string downstream tooling greps.
 */
const OOM_FLAG_BLIND_NOTE =
  'a runtime self-abort on its own memory limit is invisible to this flag - ' +
  'check the log above for a fatal memory marker';

/**
 * Shell fragment computing `$__start_command_reason` for the kept footer.
 * @returns {string} Shell command
 */
function buildDockerKeptReasonSnippet() {
  return (
    '__start_command_reason="exitCode=$__start_command_exit oomKilled=$__start_command_oom"; ' +
    `case "$__start_command_exit" in ${SELF_ABORT_EXIT_CODES.join('|')}) ` +
    '[ "$__start_command_oom" = true ] || ' +
    `__start_command_reason="$__start_command_reason (${OOM_FLAG_BLIND_NOTE})";; ` +
    'esac'
  );
}

/**
 * Lines appended to an attached session's message when the container is kept
 * because the command failed. A runtime that aborts on its own memory limit
 * never trips `State.OOMKilled`, so a bare `oomKilled false` would contradict
 * the `FATAL ERROR` the runtime just printed into this very log (issue #165).
 * Best effort: the tail is read right after the child exits.
 *
 * @param {object} params - Container name, exit code, OOM flag and log path
 * @returns {string} Message lines to append
 */
function buildAttachedDockerKeptMessage({
  containerName,
  exitCode,
  oomKilled,
  logPath,
}) {
  let message =
    oomKilled === true
      ? `\nContainer kept because Docker reports it was OOM-killed.`
      : `\nContainer kept because the command failed.`;
  const memory = resolveMemoryExhaustion({
    exitCode,
    logTail: logPath ? readLogTail(logPath, FATAL_MARKER_TAIL_BYTES) : null,
    oomKilled,
  });
  if (memory) {
    message += `\nMemory exhaustion detected in the log: ${memory.memoryExhaustedReason}`;
  }
  return `${message}\nRemove when done: docker rm -f ${containerName}`;
}

function buildDockerKeptLogSnippet(containerName, quotedLogPath) {
  const quotedName = shellQuote(containerName);
  return (
    `${buildDockerKeptReasonSnippet()}; ` +
    `printf '\\nContainer kept for investigation: %s\\nReason: %s\\n` +
    `Re-enter while running: $ --attach %s\\n` +
    `Continue the stored command: $ --resume %s\\n` +
    `Run another command in the same container: $ --resume %s -- <command>\\n` +
    `Remove when done: docker rm -f %s\\n' ` +
    `${quotedName} "$__start_command_reason" ` +
    `${quotedName} ${quotedName} ${quotedName} ${quotedName} >> ${quotedLogPath}`
  );
}

function buildSuccessfulNonOomCondition() {
  return (
    '[ "$__start_command_exit" -eq 0 ] 2>/dev/null && ' +
    '[ "$__start_command_oom" != true ]'
  );
}

/**
 * Build the POSIX shell run by the detached completion watcher.
 *
 * The watcher is the only observer left once `start --detached` returns, so it
 * carries three responsibilities that used to be missing or deferred:
 *   1. it reads the container's post-mortem facts out of a single
 *      `docker inspect` (issue #171.1);
 *   2. it writes those facts into the log on every path — kept *and* removed —
 *      so an operator reading the log never has to reconstruct them from a
 *      container that no longer exists (issues #171.2, #171.3);
 *   3. it hands the same facts to the finalizer so the execution record stops
 *      being `executing` forever (issue #170.1).
 *
 * @param {string} containerName - Docker container name
 * @param {string} policy - One of DOCKER_CONTAINER_CLEANUP_POLICY
 * @param {string|null} logPath - Log file to append to, or null
 * @param {string|null} [executionId] - Execution UUID to finalize, or null
 * @returns {string} The shell script
 */
function buildDetachedDockerCompletionScript(
  containerName,
  policy,
  logPath,
  executionId = null
) {
  const quotedName = shellQuote(containerName);
  const parts = [];

  if (logPath) {
    const quotedLogPath = shellQuote(logPath);
    const removalNote = buildDockerRemovalNoteSnippet(
      containerName,
      quotedLogPath
    );
    const postMortem = buildDockerPostMortemSnippet(
      containerName,
      quotedLogPath
    );
    const remove = `docker rm -f ${quotedName} >> ${quotedLogPath} 2>&1 || true; ${removalNote}`;
    const keep = `${postMortem}; ${buildDockerKeptLogSnippet(containerName, quotedLogPath)}`;

    parts.push(`docker logs -f ${quotedName} >> ${quotedLogPath} 2>&1`);
    parts.push(buildDockerStateSnippet(containerName));
    if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS) {
      parts.push(remove);
    } else if (
      policy === DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT ||
      policy === DOCKER_CONTAINER_CLEANUP_POLICY.KEEP_ON_FAIL
    ) {
      parts.push(
        `if ${buildSuccessfulNonOomCondition()}; then ${remove}; else ${keep}; fi`
      );
    } else {
      // KEEP: the container is never removed, so the log used to end with the
      // raw command output and nothing else. The post-mortem is exactly the
      // information an operator needs before deciding what to do with it.
      parts.push(keep);
    }
    parts.push(`${createShellLogFooterSnippet()} >> ${quotedLogPath}`);
  } else {
    parts.push(`docker wait ${quotedName} >/dev/null 2>&1`);
    parts.push(buildDockerStateSnippet(containerName));
    if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS) {
      parts.push(`docker rm -f ${quotedName} >/dev/null 2>&1 || true`);
    } else if (
      policy === DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT ||
      policy === DOCKER_CONTAINER_CLEANUP_POLICY.KEEP_ON_FAIL
    ) {
      parts.push(
        `if ${buildSuccessfulNonOomCondition()}; then docker rm -f ${quotedName} >/dev/null 2>&1 || true; fi`
      );
    }
  }

  if (executionId) {
    // Last, so the record is only marked terminal once the log is complete.
    parts.push(buildDetachedFinalizeSnippet(executionId));
  }

  return parts.join('; ');
}

/**
 * Start the detached completion watcher.
 * @param {string} containerName - Docker container name
 * @param {string} policy - One of DOCKER_CONTAINER_CLEANUP_POLICY
 * @param {string|null} logPath - Log file to append to, or null
 * @param {string|null} [executionId] - Execution UUID to finalize, or null
 * @returns {void}
 */
function startDetachedDockerCompletionWatcher(
  containerName,
  policy,
  logPath,
  executionId = null
) {
  const watcher = spawn(
    'sh',
    [
      '-c',
      buildDetachedDockerCompletionScript(
        containerName,
        policy,
        logPath,
        executionId
      ),
    ],
    {
      detached: true,
      stdio: 'ignore',
    }
  );
  watcher.unref();
}

function spawnAttachedDocker(dockerArgs, logPath) {
  if (!logPath) {
    return spawn(
      getDockerCommand(),
      dockerArgs,
      getDockerSpawnOptions({ stdio: 'inherit' })
    );
  }

  const child = spawn(
    getDockerCommand(),
    dockerArgs,
    getDockerSpawnOptions({
      stdio: ['inherit', 'pipe', 'pipe'],
    })
  );
  const tee = (chunk, stream) => {
    stream.write(chunk);
    appendLogFile(logPath, chunk.toString());
  };
  child.stdout.on('data', (chunk) => tee(chunk, process.stdout));
  child.stderr.on('data', (chunk) => tee(chunk, process.stderr));
  return child;
}

module.exports = {
  buildAttachedDockerKeptMessage,
  DOCKER_CONTAINER_CLEANUP_POLICY,
  SELF_ABORT_EXIT_CODES,
  OOM_FLAG_BLIND_NOTE,
  buildDockerKeptReasonSnippet,
  getDockerCommand,
  getDockerSpawnOptions,
  getDockerContainerCleanupPolicy,
  isAbnormalDockerExit,
  shouldCleanupDockerContainer,
  getDockerContainerCleanupInstructions,
  appendDockerContainerCleanupPolicyMessage,
  readDockerContainerOomKilled,
  readDockerContainerStatus,
  removeDockerContainer,
  buildDetachedDockerCompletionScript,
  startDetachedDockerCompletionWatcher,
  spawnAttachedDocker,
};
