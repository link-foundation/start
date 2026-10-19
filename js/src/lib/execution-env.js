/**
 * START_* variables that tell a launched command which execution it belongs
 * to (issue #230). Every backend exports the same three variables, next to
 * the kill-recovery `START_COMMAND_RECOVERY_ATTEMPT`:
 *
 * - START_EXECUTION_ID: the execution UUID (`--session-id`)
 * - START_SESSION_NAME: the isolation session/container name (`--session`);
 *   empty for direct runs, which have no session
 * - START_ATTEMPT: 1 for the first run, n for the n-th attempt (`--resume`,
 *   kill recovery or `--append-attempt`), the same number `--status` shows
 */
const { shellQuote } = require('./isolation-log-utils');

const EXECUTION_ID_ENV = 'START_EXECUTION_ID';
const SESSION_NAME_ENV = 'START_SESSION_NAME';
const ATTEMPT_ENV = 'START_ATTEMPT';

/**
 * Build the START_* variables for one attempt.
 * @param {object} params - {executionId, sessionName, attempt}
 * @returns {object} Variables in a stable order, or {} without an execution id
 */
function buildExecutionEnv({ executionId, sessionName, attempt } = {}) {
  if (!executionId) {
    return {};
  }
  const number = Number(attempt);
  return {
    [EXECUTION_ID_ENV]: String(executionId),
    [SESSION_NAME_ENV]: sessionName ? String(sessionName) : '',
    [ATTEMPT_ENV]: String(Number.isSafeInteger(number) && number > 0 ? number : 1),
  };
}

/**
 * Build the variables from isolation options (`runIsolated`, `docker run`).
 * @param {object} options - {sessionId|executionId, containerName|session, attemptNumber}
 * @returns {object} Variables, or {}
 */
function executionEnvFromOptions(options = {}) {
  return buildExecutionEnv({
    executionId: options.sessionId || options.executionId,
    sessionName: options.containerName || options.session,
    attempt: options.attemptNumber,
  });
}

/**
 * `KEY=value` assignments, e.g. for `docker run -e`.
 * @param {object} env - Variables
 * @returns {string[]} Assignments
 */
function executionEnvAssignments(env = {}) {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

/**
 * POSIX `export` statement for the variables, without a trailing separator.
 * @param {object} env - Variables
 * @returns {string} Statement, or '' when there is nothing to export
 */
function buildExecutionEnvExport(env = {}) {
  const entries = Object.entries(env);
  if (!entries.length) {
    return '';
  }
  return `export ${entries
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ')}`;
}

/**
 * Prefix a shell command with the export statement. Used by the backends
 * whose command runs through a shell that does not inherit our environment:
 * a running tmux server, ssh, and `sudo` (which resets the environment).
 * @param {string} command - Shell command
 * @param {object} env - Variables
 * @returns {string} Prefixed command
 */
function prefixWithExecutionEnv(command, env = {}) {
  const statement = buildExecutionEnvExport(env);
  return statement ? `${statement}; ${command}` : command;
}

/**
 * Child-process environment with the variables applied.
 * @param {object} env - Variables
 * @param {object} [base] - Base environment (defaults to process.env)
 * @returns {object} Environment
 */
function withExecutionEnv(env = {}, base = process.env) {
  return { ...base, ...env };
}

/**
 * True when this process was itself started by execution `executionId`, i.e.
 * it is the next level of a stacked isolation that passes `--session-id`
 * down (see command-builder.js).
 * @param {string} executionId - Execution UUID
 * @param {object} [env] - Environment to inspect
 * @returns {boolean}
 */
function isNestedLaunchOf(executionId, env = process.env) {
  return Boolean(executionId) && env[EXECUTION_ID_ENV] === executionId;
}

module.exports = {
  EXECUTION_ID_ENV,
  SESSION_NAME_ENV,
  ATTEMPT_ENV,
  buildExecutionEnv,
  executionEnvFromOptions,
  executionEnvAssignments,
  buildExecutionEnvExport,
  prefixWithExecutionEnv,
  withExecutionEnv,
  isNestedLaunchOf,
};
