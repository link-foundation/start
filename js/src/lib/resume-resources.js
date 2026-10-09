const {
  normalizeResourceLimits,
  cpuCount,
  withCpuLimit,
  readDockerResourceLimits,
} = require('./docker-resource-limits');
const { resolveResourceOptions } = require('./docker-resource-options');

// Temporary penalty quotas must never become a resumed execution's base quota.
function restoreBaseCpu(limits, options) {
  if (!options.cpuPenaltyConfig) {
    return limits;
  }
  const base = normalizeResourceLimits(
    options.baseResourceLimits || options.resourceLimits
  );
  return [
    ...limits.filter((s) => !/^--(?:cpus|cpu-quota|cpu-period)=/.test(s)),
    ...base.filter((s) => /^--(?:cpus|cpu-quota|cpu-period)=/.test(s)),
  ];
}

function prepareResumeResources(record, probe, overrides, runner, random) {
  const options = record.options || {};
  if (options.isolated !== 'docker') {
    if (
      ['memory', 'memorySwap', 'cpus'].some(
        (k) => overrides[k] !== null && overrides[k] !== undefined
      )
    ) {
      throw new Error('Resource overrides require a Docker execution');
    }
    return null;
  }
  const live =
    probe.state === 'stopped'
      ? readDockerResourceLimits(options.sessionName, runner)
      : null;
  const base = restoreBaseCpu(
    normalizeResourceLimits(live || options.resourceLimits),
    options
  );
  const oldMemory = base.find((s) => s.startsWith('--memory='))?.slice(9);
  const result = resolveResourceOptions(
    { ...overrides, resourceLimits: base },
    runner,
    random
  );
  if (overrides.cpus && probe.state === 'stopped') {
    // Docker cannot switch an existing legacy quota to NanoCPUs in place.
    const cpu = withCpuLimit(base, result.resolvedLimits.cpus);
    result.resourceLimits = [
      ...result.resourceLimits.filter(
        (s) => !/^--(?:cpus|cpu-quota|cpu-period)=/.test(s)
      ),
      ...cpu.filter((s) => /^--(?:cpus|cpu-quota|cpu-period)=/.test(s)),
    ];
  }
  result.oldMemory = oldMemory
    ? require('./docker-resource-options').parseResourceSpec(oldMemory).amount
    : 'unlimited';
  result.resolvedLimits = {
    ...options.resolvedLimits,
    ...result.resolvedLimits,
  };
  result.resourceLimitSpecs = {
    ...options.resourceLimitSpecs,
    ...result.resourceLimitSpecs,
  };
  result.update =
    probe.state === 'stopped' &&
    (['memory', 'memorySwap', 'cpus'].some(
      (k) => overrides[k] !== null && overrides[k] !== undefined
    ) ||
      Boolean(options.cpuPenaltyConfig));
  if (options.cpuPenaltyConfig && !overrides.cpus) {
    result.resourceLimits = clampCpuToDaemon(result.resourceLimits, runner);
    result.resolvedLimits.cpus = cpuCount(result.resourceLimits);
  }
  return result;
}

function clampCpuToDaemon(limits, runner) {
  const { readDaemonCapacity } = require('./docker-resource-options');
  const capacity = readDaemonCapacity(runner).cpus;
  return withCpuLimit(limits, Math.min(cpuCount(limits) || capacity, capacity));
}
module.exports = { prepareResumeResources, restoreBaseCpu, clampCpuToDaemon };
