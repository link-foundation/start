/**
 * Grace period between the stop signal and SIGKILL for docker executions
 * (issue #265):
 *
 *   $ --stop <uuid> --stop-timeout <seconds>
 *       `docker stop -t <seconds> <container>` for this stop only
 *   $ --isolated docker --stop-timeout <seconds> -- <command>
 *       `docker run --stop-timeout <seconds>`, recorded with the execution, so
 *       a plain `docker stop` (and the daemon on shutdown) honors it too
 *
 * START_DOCKER_STOP_TIMEOUT=<seconds> sets the default for both, so a caller
 * can configure it once. Without any of them Docker's own default applies:
 * SIGKILL 10 seconds after the stop signal.
 *
 * `--stop` resolves the grace period as: the `--stop-timeout` flag, then the
 * value recorded at launch (the container's own StopTimeout), then the
 * environment default, then Docker's 10 seconds.
 */

const DOCKER_STOP_TIMEOUT_ENV = 'START_DOCKER_STOP_TIMEOUT';
const DOCKER_DEFAULT_STOP_TIMEOUT = 10;

/**
 * Parse a grace period in whole seconds.
 * @param {*} value - Raw value
 * @param {string} source - Option or variable name, for the error message
 * @returns {number} Seconds (a non-negative integer)
 * @throws {Error} If the value is not a non-negative whole number
 */
function parseStopTimeoutValue(value, source) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error(
      `Invalid ${source} value: "${value}". Expected a non-negative whole number of seconds`
    );
  }
  return Number(text);
}

/**
 * The environment default, or null when it is unset or empty.
 * @param {object} [env] - Environment
 * @returns {?number} Seconds
 * @throws {Error} If the variable is set to an invalid value
 */
function stopTimeoutFromEnv(env = process.env) {
  const raw = env[DOCKER_STOP_TIMEOUT_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return null;
  }
  return parseStopTimeoutValue(raw, DOCKER_STOP_TIMEOUT_ENV);
}

/**
 * Parse `--stop-timeout <seconds>` / `--stop-timeout=<seconds>`.
 * @param {string[]} args - Arguments array
 * @param {number} index - Current index
 * @param {object} options - Options object to populate
 * @returns {number} Number of arguments consumed (0 if not recognized)
 */
function parseStopTimeoutOption(args, index, options) {
  const arg = args[index];
  if (arg === '--stop-timeout') {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new Error('Option --stop-timeout requires a number of seconds');
    }
    options.stopTimeout = parseStopTimeoutValue(value, '--stop-timeout');
    return 2;
  }
  if (arg.startsWith('--stop-timeout=')) {
    options.stopTimeout = parseStopTimeoutValue(
      arg.slice('--stop-timeout='.length),
      '--stop-timeout'
    );
    return 1;
  }
  return 0;
}

/**
 * `--stop-timeout` belongs to `--stop` or to a launch whose isolation stack
 * includes docker. A docker launch without it takes the environment default.
 * Idempotent: validation may run again on options it already resolved.
 * @param {object} options - Parsed options
 * @param {object} [env] - Environment
 * @throws {Error} If the option is used anywhere else
 */
function validateStopTimeoutOption(options, env = process.env) {
  const stack = options.isolatedStack || [options.isolated];
  const hasDocker = options.isolated !== null && stack.includes('docker');
  const isStop = options.stop !== null && options.stop !== undefined;
  if (options.stopTimeout !== null && options.stopTimeout !== undefined) {
    if (!isStop && !hasDocker) {
      throw new Error(
        '--stop-timeout option is only valid with --stop or when isolation stack includes docker'
      );
    }
    return;
  }
  options.stopTimeout = hasDocker ? stopTimeoutFromEnv(env) : null;
}

/**
 * The grace period `--stop` gives a docker execution.
 * @param {object} record - Execution record
 * @param {?number} requested - `--stop-timeout`, or null
 * @param {object} [env] - Environment
 * @returns {{seconds: number, explicit: boolean}} Seconds, and whether start
 *   chose them (so `docker stop -t` must pass them) rather than Docker
 */
function resolveStopTimeout(record, requested, env = process.env) {
  if (requested !== null && requested !== undefined) {
    return { seconds: requested, explicit: true };
  }
  const recorded = record && record.options ? record.options.stopTimeout : null;
  if (recorded !== null && recorded !== undefined) {
    return {
      seconds: parseStopTimeoutValue(recorded, 'recorded stopTimeout'),
      explicit: true,
    };
  }
  const fromEnv = stopTimeoutFromEnv(env);
  if (fromEnv !== null) {
    return { seconds: fromEnv, explicit: true };
  }
  return { seconds: DOCKER_DEFAULT_STOP_TIMEOUT, explicit: false };
}

module.exports = {
  DOCKER_DEFAULT_STOP_TIMEOUT,
  DOCKER_STOP_TIMEOUT_ENV,
  parse: parseStopTimeoutOption,
  parseStopTimeoutValue,
  resolveStopTimeout,
  stopTimeoutFromEnv,
  validate: validateStopTimeoutOption,
};
