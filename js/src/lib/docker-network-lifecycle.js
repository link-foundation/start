/** Docker multi-network lifecycle helpers. */

const { spawnSync } = require('child_process');

// Opt-in tracing, off by default: the multi-network attachment sequence
// (`docker create` -> `docker network connect` -> `docker start`) previously
// failed in CI with nothing but an exit code to go on (issue #158). Enable with
// START_DEBUG=1 to see every docker invocation, its status and its output.
const DEBUG =
  process.env.START_DEBUG === '1' || process.env.START_DEBUG === 'true';

function debugLog(message) {
  if (DEBUG) {
    console.error(`[docker-network] ${message}`);
  }
}

function getDockerNetworks(options = {}) {
  return options.networks?.length
    ? options.networks
    : options.network
      ? [options.network]
      : [];
}

function runDockerCommand(args) {
  debugLog(`$ docker ${args.join(' ')}`);
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) {
    debugLog(`spawn failed: ${result.error.message}`);
    throw result.error;
  }
  debugLog(
    `exit=${result.status} stdout=${JSON.stringify(
      (result.stdout || '').trim()
    )} stderr=${JSON.stringify((result.stderr || '').trim())}`
  );
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
  const networks = getDockerNetworks(options);
  debugLog(
    `connecting ${containerName} to additional networks: ${
      networks.slice(1).join(', ') || '<none>'
    }`
  );
  for (const network of networks.slice(1)) {
    runDockerCommand(['network', 'connect', network, containerName]);
  }
}

module.exports = {
  connectAdditionalDockerNetworks,
  debugLog,
  getDockerNetworks,
  runDockerCommand,
};
