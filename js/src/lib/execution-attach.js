/**
 * Attach to a tracked detached execution (issue #162).
 *
 * `--stop`/`--terminate` can already address a stored session name; `--attach`
 * completes the set by re-entering the session's terminal instead of only
 * tailing its log. `--attach --read-only` follows the output without
 * forwarding stdin, which is the safe default for supervisors that must not
 * accidentally type into a long-running agent session.
 */

const { spawnSync } = require('child_process');
const { escapeForLinksNotation } = require('./output-blocks');
const { getDockerCommand, getDockerSpawnOptions } = require('./docker-cleanup');
const { runCommand } = require('./execution-control');
const { SessionState, probeSession } = require('./session-probe');

/**
 * Run a command with the parent terminal attached (stdin included unless the
 * plan is read-only). Used for `screen -r`, `tmux attach-session`,
 * `docker attach`, and log following.
 * @param {string} command - Executable
 * @param {string[]} args - Arguments
 * @param {object} plan - Attach plan (interactive flag)
 * @returns {{success: boolean, status: ?number, error: ?string}}
 */
function runInteractive(command, args, plan = {}) {
  const options = {
    stdio: plan.interactive ? 'inherit' : ['ignore', 'inherit', 'inherit'],
  };
  const result = spawnSync(
    command,
    args,
    command === getDockerCommand() ? getDockerSpawnOptions(options) : options
  );
  return {
    success: !result.error && result.status === 0,
    status: result.status,
    error: result.error ? result.error.message : null,
  };
}

function logFollowPlan(record, backend, sessionName) {
  if (!record.logPath) {
    return {
      error: `Execution "${record.uuid}" has no stored log to follow.`,
    };
  }
  return {
    backend,
    sessionName,
    command: 'tail',
    args: ['-f', record.logPath],
    interactive: false,
    method: 'LOG_FOLLOW',
    message: `Following stored log for ${backend} session: ${sessionName}`,
  };
}

function notRunningError(record, probe) {
  const sessionName = probe.sessionName;
  const uuid = record.uuid;
  if (probe.state === SessionState.MISSING) {
    return {
      error:
        `Session "${sessionName}" no longer exists, so there is nothing to attach to. ` +
        `Use \`$ --resume ${uuid}\` to start it again, or \`$ --status ${uuid}\` to inspect the recorded result.`,
    };
  }
  return {
    error:
      `Session "${sessionName}" is not running (state: ${probe.containerStatus || probe.state}). ` +
      `Use \`$ --resume ${uuid}\` to continue it in the same container, or \`$ --status ${uuid}\` to inspect the recorded result.`,
  };
}

/**
 * Build the attach plan for an execution record.
 * @param {object} record - Execution record
 * @param {object} options - {readOnly: boolean, probe: object}
 * @returns {object} Plan with command/args/interactive/method/message, or {error}
 */
function buildAttachPlan(record, options = {}) {
  const readOnly = options.readOnly === true;
  const probe = options.probe || {};
  const opts = (record && record.options) || {};
  const backend = opts.isolated;
  const sessionName = opts.sessionName;

  if (!sessionName) {
    return {
      error: 'Execution record does not contain an isolation session name.',
    };
  }

  if (opts.isolationMode !== 'detached') {
    return {
      error: 'Only detached isolated executions can be attached to.',
    };
  }

  // ssh sessions cannot be probed or re-entered locally: the stored log is the
  // only channel back into them.
  if (backend === 'ssh') {
    return logFollowPlan(record, backend, sessionName);
  }

  if (!probe.alive) {
    return notRunningError(record, { ...probe, sessionName });
  }

  switch (backend) {
    case 'screen':
      return readOnly
        ? logFollowPlan(record, backend, sessionName)
        : {
            backend,
            sessionName,
            command: 'screen',
            args: ['-r', sessionName],
            interactive: true,
            method: 'SCREEN_ATTACH',
            message: `Attaching to detached screen session: ${sessionName}`,
          };
    case 'tmux':
      return {
        backend,
        sessionName,
        command: 'tmux',
        args: readOnly
          ? ['attach-session', '-r', '-t', sessionName]
          : ['attach-session', '-t', sessionName],
        interactive: true,
        method: readOnly ? 'TMUX_ATTACH_READONLY' : 'TMUX_ATTACH',
        message: `Attaching to detached tmux session: ${sessionName}${readOnly ? ' (read-only)' : ''}`,
      };
    case 'docker':
      return readOnly
        ? {
            backend,
            sessionName,
            command: getDockerCommand(),
            args: ['logs', '-f', sessionName],
            interactive: false,
            method: 'DOCKER_LOG_FOLLOW',
            message: `Following logs of detached docker container: ${sessionName}`,
          }
        : {
            backend,
            sessionName,
            command: getDockerCommand(),
            args: ['attach', sessionName],
            interactive: true,
            method: 'DOCKER_ATTACH',
            message: `Attaching to detached docker container: ${sessionName}`,
          };
    default:
      return {
        error: `Attaching to detached ${backend || 'unknown'} executions is not supported.`,
      };
  }
}

/**
 * Format an attach result as links notation.
 * @param {object} result - Attach result fields
 * @returns {string} Links notation block
 */
function formatAttachResultAsLinksNotation(result) {
  return [
    'executionAttach',
    `  identifier ${escapeForLinksNotation(result.identifier)}`,
    `  uuid ${escapeForLinksNotation(result.uuid)}`,
    `  backend ${escapeForLinksNotation(result.backend)}`,
    `  sessionName ${escapeForLinksNotation(result.sessionName)}`,
    `  method ${escapeForLinksNotation(result.method)}`,
    `  readOnly ${result.readOnly === true}`,
    `  command ${escapeForLinksNotation(result.command)}`,
    `  message ${escapeForLinksNotation(result.message)}`,
  ].join('\n');
}

/**
 * Attach to a tracked execution by UUID or session name.
 * @param {?object} store - Execution store
 * @param {string} identifier - UUID or session name
 * @param {object} deps - {readOnly, probe, interactiveRunner, runner}
 * @returns {{success: boolean, output?: string, error?: string, exitCode?: number}}
 */
function attachExecution(store, identifier, deps = {}) {
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
  const plan = buildAttachPlan(record, {
    readOnly: deps.readOnly === true,
    probe: probeFn(record),
  });

  if (plan.error) {
    return { success: false, error: plan.error };
  }

  const interactiveRunner = deps.interactiveRunner || runInteractive;
  const commandLine = [plan.command, ...plan.args].join(' ');
  const runResult = interactiveRunner(plan.command, plan.args, plan);

  const output = formatAttachResultAsLinksNotation({
    identifier,
    uuid: record.uuid,
    backend: plan.backend,
    sessionName: plan.sessionName,
    method: plan.method,
    readOnly: deps.readOnly === true,
    command: commandLine,
    message: plan.message,
  });

  if (!runResult.success) {
    const detail = runResult.error || `exit code ${runResult.status}`;
    return {
      success: false,
      error: `Failed to attach to ${plan.backend} session "${plan.sessionName}": ${detail}`,
      exitCode: typeof runResult.status === 'number' ? runResult.status : 1,
    };
  }

  return { success: true, output };
}

module.exports = {
  attachExecution,
  buildAttachPlan,
  formatAttachResultAsLinksNotation,
  runInteractive,
};
