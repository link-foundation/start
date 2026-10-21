/**
 * Parse and validate the opt-in init process for docker isolation
 * (issue #244):
 *   --init      run `docker run --init`, so Docker's bundled tini is PID 1
 *               and reaps orphaned processes
 *   --no-init   keep the command as PID 1, overriding the environment default
 *
 * Without either flag, START_COMMAND_DOCKER_INIT=1 turns it on for every
 * docker launch on the host. The default stays off: a command that is its own
 * supervisor keeps today's behaviour, and recovery works the same for
 * containers started with or without it.
 */

const DOCKER_INIT_ENV = 'START_COMMAND_DOCKER_INIT';

/**
 * Whether the environment asks for an init process by default.
 * @param {object} [env] - Environment
 * @returns {boolean}
 */
function dockerInitFromEnv(env = process.env) {
  const value = String(env[DOCKER_INIT_ENV] || '')
    .trim()
    .toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function parseDockerInitOption(args, index, options) {
  const arg = args[index];
  if (arg === '--init' || arg === '--no-init') {
    options.init = arg === '--init';
    return 1;
  }
  return 0;
}

/**
 * Resolve `options.init` to a boolean: the flag if one was given (`null`
 * means none), otherwise the environment default for launches whose stack
 * includes docker. Idempotent, because `validateOptions` may run again on
 * options it already resolved: `--no-init` (or a resolved `false`) without
 * docker is the default anyway and is accepted.
 * @param {object} options - Parsed options
 * @param {object} [env] - Environment
 * @throws {Error} If `--init` is given without docker isolation
 */
function validateDockerInitOption(options, env = process.env) {
  const stack = options.isolatedStack || [options.isolated];
  const hasDocker = options.isolated !== null && stack.includes('docker');
  if (options.init === true && !hasDocker) {
    throw new Error(
      '--init option is only valid when isolation stack includes docker'
    );
  }
  if (typeof options.init !== 'boolean') {
    options.init = hasDocker && dockerInitFromEnv(env);
  }
}

module.exports = {
  DOCKER_INIT_ENV,
  dockerInitFromEnv,
  parse: parseDockerInitOption,
  validate: validateDockerInitOption,
};
