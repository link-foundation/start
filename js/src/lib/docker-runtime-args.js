/**
 * Docker runtime options shared by `docker run`, `[Isolation]` status lines
 * and execution-record metadata: privileged mode, environment, volumes,
 * mounts, networks (issue #150) and resource limits (issue #176).
 */

const { getDockerNetworks } = require('./docker-network-lifecycle');
const {
  buildResourceLimitsStatusLine,
  normalizeResourceLimits,
} = require('./docker-resource-limits');

/**
 * Number of kill recoveries requested at launch; a recovery command on its own
 * implies one (issue #176).
 * @param {object} options - Options (onKillResume, recoveryCommand)
 * @returns {?number} Attempt limit, or null when recovery is off
 */
function getOnKillResume(options = {}) {
  const count = Number(options.onKillResume) || 0;
  if (count > 0) {
    return count;
  }
  return options.recoveryCommand ? 1 : null;
}

/**
 * Build the docker run runtime argument list contributed by configurable
 * container options: privileged mode, environment variables, volumes/bind
 * mounts, --mount specs, network configuration and resource limits. Returned
 * in a stable order so they can be spliced into the `docker run` argv before
 * the image name.
 * @param {object} options - Options (privileged, env, volumes, mounts, network, networkAliases, resourceLimits)
 * @returns {string[]} Docker CLI arguments
 */
function buildDockerRuntimeArgs(options = {}) {
  const args = [];
  if (options.privileged) {
    args.push('--privileged');
  }
  for (const envVar of options.env || []) {
    args.push('-e', envVar);
  }
  for (const volume of options.volumes || []) {
    args.push('-v', volume);
  }
  for (const mount of options.mounts || []) {
    args.push('--mount', mount);
  }
  const [firstNetwork] = getDockerNetworks(options);
  if (firstNetwork) {
    args.push('--network', firstNetwork);
  }
  for (const alias of options.networkAliases || []) {
    args.push('--network-alias', alias);
  }
  args.push(...normalizeResourceLimits(options.resourceLimits));
  return args;
}

/**
 * Build the human-readable `[Isolation]` status lines for docker runtime
 * options (volumes, mounts, env, privileged, networks, resource limits and
 * the launch-time recovery command). Empty collections and a falsy privileged
 * flag contribute no lines.
 * @param {object} options - Options (volumes, mounts, env, privileged, network, networks, networkAliases, resourceLimits, onKillResume, recoveryCommand)
 * @returns {string[]} Status lines for the start block / log header
 */
function buildDockerRuntimeStatusLines(options = {}) {
  const lines = [];
  if (options.volumes && options.volumes.length > 0) {
    lines.push(`[Isolation] Volumes: ${options.volumes.join(', ')}`);
  }
  if (options.mounts && options.mounts.length > 0) {
    lines.push(`[Isolation] Mounts: ${options.mounts.join(', ')}`);
  }
  if (options.env && options.env.length > 0) {
    lines.push(`[Isolation] Env: ${options.env.join(', ')}`);
  }
  if (options.privileged) {
    lines.push(`[Isolation] Privileged: true`);
  }
  const networks = getDockerNetworks(options);
  if (networks.length > 0) {
    lines.push(`[Isolation] Network: ${networks[0]}`);
  }
  if (networks.length > 1) {
    lines.push(`[Isolation] Networks: ${networks.join(', ')}`);
  }
  if (options.networkAliases && options.networkAliases.length > 0) {
    lines.push(
      `[Isolation] Network aliases: ${options.networkAliases.join(', ')}`
    );
  }
  const limitsLine = buildResourceLimitsStatusLine(options.resourceLimits);
  if (limitsLine) {
    lines.push(limitsLine);
  }
  const onKillResume = getOnKillResume(options);
  if (onKillResume) {
    const what = options.recoveryCommand || 'the original command';
    lines.push(
      `[Isolation] On kill: resume up to ${onKillResume} time(s) with ${what}`
    );
  }
  return lines;
}

/**
 * Build the execution-record metadata for docker runtime options, normalizing
 * empty collections and a falsy privileged flag to `null`.
 * @param {object} options - Options (volumes, mounts, env, privileged, network, networks, networkAliases, resourceLimits, onKillResume, recoveryCommand)
 * @returns {object} Record metadata
 */
function buildDockerRuntimeMetadata(options = {}) {
  const networks = getDockerNetworks(options);
  const resourceLimits = normalizeResourceLimits(options.resourceLimits);
  return {
    volumes:
      options.volumes && options.volumes.length > 0 ? options.volumes : null,
    mounts: options.mounts && options.mounts.length > 0 ? options.mounts : null,
    env: options.env && options.env.length > 0 ? options.env : null,
    privileged: options.privileged || null,
    network: networks[0] || null,
    networks: networks.length > 0 ? networks : null,
    networkAliases:
      options.networkAliases && options.networkAliases.length > 0
        ? options.networkAliases
        : null,
    resourceLimits: resourceLimits.length > 0 ? resourceLimits : null,
    onKillResume: getOnKillResume(options),
    recoveryCommand: options.recoveryCommand || null,
  };
}

module.exports = {
  buildDockerRuntimeArgs,
  buildDockerRuntimeStatusLines,
  buildDockerRuntimeMetadata,
  getOnKillResume,
};
