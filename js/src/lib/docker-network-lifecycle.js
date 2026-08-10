/** Docker multi-network lifecycle helpers. */

const { spawnSync } = require('child_process');

function getDockerNetworks(options = {}) {
  return options.networks?.length
    ? options.networks
    : options.network
      ? [options.network]
      : [];
}

function runDockerCommand(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `docker ${args[0]} exited with code ${result.status}`
    );
  }
  return result.stdout.trim();
}

function connectAdditionalDockerNetworks(containerName, options = {}) {
  for (const network of getDockerNetworks(options).slice(1)) {
    runDockerCommand(['network', 'connect', network, containerName]);
  }
}

module.exports = {
  connectAdditionalDockerNetworks,
  getDockerNetworks,
  runDockerCommand,
};
