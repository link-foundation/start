/** Parse and validate Docker network wrapper options. */

function parseDockerNetworkOption(args, index, options) {
  const arg = args[index];
  if (arg === '--network' || arg === '--network-alias') {
    if (index + 1 >= args.length || args[index + 1].startsWith('-')) {
      const value = arg === '--network' ? 'network name' : 'alias';
      throw new Error(`Option ${arg} requires a ${value} argument`);
    }
    if (arg === '--network') {
      options.networks.push(args[index + 1]);
      options.network ??= args[index + 1];
    } else {
      options.networkAliases.push(args[index + 1]);
    }
    return 2;
  }
  if (arg.startsWith('--network=')) {
    const network = arg.slice('--network='.length);
    options.networks.push(network);
    options.network ??= network;
    return 1;
  }
  if (arg.startsWith('--network-alias=')) {
    options.networkAliases.push(arg.slice('--network-alias='.length));
    return 1;
  }
  return 0;
}

function validateDockerNetworkOptionsRequireDocker(options) {
  if (options.network) {
    throw new Error(
      '--network option is only valid when isolation stack includes docker'
    );
  }
  if (options.networkAliases?.length > 0) {
    throw new Error(
      '--network-alias option is only valid when isolation stack includes docker'
    );
  }
}

module.exports = {
  parse: parseDockerNetworkOption,
  validateRequireDocker: validateDockerNetworkOptionsRequireDocker,
};
