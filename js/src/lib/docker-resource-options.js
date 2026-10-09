/** Launch and recovery resource specifications, resolved against the daemon. */
const { getDockerCommand } = require('./docker-cleanup');
const { normalizeResourceLimits } = require('./docker-resource-limits');
const FIELDS = {
  '--memory': 'memory',
  '--memory-swap': 'memorySwap',
  '--cpus': 'cpus',
  '--on-kill-resume-memory': 'onKillResumeMemory',
};

function parseResourceSpec(value, cpu = false) {
  const text = String(value).trim().toLowerCase();
  const percent = /^(\d+(?:\.\d+)?)%(?:-(\d+(?:\.\d+)?)%)?$/.exec(text);
  if (percent) {
    const min = Number(percent[1]),
      max = Number(percent[2] || percent[1]);
    if (min > 0 && max <= 100 && min <= max) {
      return { min, max, percent: true };
    }
  } else {
    const absolute = /^(\d+(?:\.\d+)?)(b|k|m|g|t|kb|mb|gb|tb)?$/.exec(text);
    if (absolute && (!cpu || !absolute[2])) {
      const power = ['', 'k', 'm', 'g', 't'].indexOf(
        (absolute[2] || '').replace('b', '')
      );
      const amount =
        Number(absolute[1]) * (cpu ? 1 : 1024 ** Math.max(0, power));
      if (
        Number.isFinite(amount) &&
        amount > 0 &&
        amount <= Number.MAX_SAFE_INTEGER
      ) {
        return { amount };
      }
    }
  }
  throw new Error(
    `Invalid resource limit: "${value}". Expected a positive ${cpu ? 'CPU count' : 'Docker size'}, N% or MIN%-MAX% within (0, 100].`
  );
}

function parse(args, index, options) {
  const [flag, inline] = args[index].split('=', 2);
  if (!FIELDS[flag]) {
    return 0;
  }
  const value = inline ?? args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`Option ${flag} requires a resource limit`);
  }
  parseResourceSpec(value, flag === '--cpus');
  options[FIELDS[flag]] = value;
  return inline === undefined ? 2 : 1;
}

function validate(options) {
  if (
    !Object.values(FIELDS).some(
      (field) => options[field] !== null && options[field] !== undefined
    )
  ) {
    return;
  }
  if (
    !options.resume &&
    !(options.isolatedStack || [options.isolated]).includes('docker')
  ) {
    throw new Error('Resource options require Docker isolation or --resume');
  }
  if (options.memorySwap && !options.memory && !options.resume) {
    throw new Error('--memory-swap requires --memory');
  }
  if (
    options.onKillResumeMemory &&
    !options.onKillResume &&
    !options.recoveryCommand
  ) {
    throw new Error(
      '--on-kill-resume-memory requires --on-kill-resume or --recovery-command'
    );
  }
}

function readDaemonCapacity(runner) {
  const result = runner(getDockerCommand(), ['info', '--format', '{{json .}}']);
  if (!result?.success) {
    throw new Error('Cannot read resource capacity from Docker daemon');
  }
  const info = JSON.parse(result.stdout);
  if (!(info.MemTotal > 0) || !(info.NCPU > 0)) {
    throw new Error('Docker daemon did not report MemTotal/NCPU');
  }
  return { memory: info.MemTotal, cpus: info.NCPU };
}

function resolveResourceOptions(options, runner, random = Math.random) {
  const specs = {};
  for (const field of ['memory', 'memorySwap', 'cpus']) {
    if (options[field] !== null && options[field] !== undefined) {
      specs[field] = parseResourceSpec(options[field], field === 'cpus');
    }
  }
  const capacity = Object.values(specs).some((s) => s.percent)
    ? readDaemonCapacity(runner)
    : null;
  const resolved = {};
  const limits = normalizeResourceLimits(options.resourceLimits);
  for (const [field, spec] of Object.entries(specs)) {
    const amount = spec.percent
      ? (capacity[field === 'cpus' ? 'cpus' : 'memory'] *
          (spec.min + (spec.max - spec.min) * random())) /
        100
      : spec.amount;
    resolved[field] =
      field === 'cpus' ? Math.floor(amount * 1e9) / 1e9 : Math.floor(amount);
    if (resolved[field] < (field === 'cpus' ? 0.01 : 6 * 1024 * 1024)) {
      throw new Error(`Resolved ${field} is below Docker's minimum`);
    }
  }
  if (
    resolved.memory !== null &&
    resolved.memory !== undefined &&
    (resolved.memorySwap === null || resolved.memorySwap === undefined)
  ) {
    resolved.memorySwap = resolved.memory;
  }
  const existingMemory = limits
    .find((flag) => flag.startsWith('--memory='))
    ?.slice(9);
  const memory =
    resolved.memory ??
    (existingMemory ? parseResourceSpec(existingMemory).amount : null);
  if (
    resolved.memorySwap !== null &&
    resolved.memorySwap !== undefined &&
    (memory === null || memory === undefined || resolved.memorySwap < memory)
  ) {
    throw new Error('memory-swap must be at least memory');
  }
  for (const [field, amount] of Object.entries(resolved)) {
    const flag = field === 'memorySwap' ? '--memory-swap' : `--${field}`;
    for (let i = limits.length - 1; i >= 0; i--) {
      if (
        limits[i].startsWith(`${flag}=`) ||
        (field === 'cpus' && /^--cpu-(quota|period)=/.test(limits[i]))
      ) {
        limits.splice(i, 1);
      }
    }
    limits.push(`${flag}=${amount}`);
  }
  return {
    resourceLimits: limits,
    resolvedLimits: resolved,
    resourceLimitSpecs: Object.fromEntries(
      Object.keys(specs).map((field) => [field, options[field]])
    ),
  };
}

function limitsLogLine(options) {
  const values = options.resolvedLimits || {};
  return Object.keys(values).length
    ? `Limits: ${Object.entries(values)
        .map(
          ([field, value]) =>
            `${field}=${value}${options.resourceLimitSpecs?.[field] ? ` (${options.resourceLimitSpecs[field]} -> ${value})` : ''}`
        )
        .join(' ')}`
    : null;
}

module.exports = {
  parse,
  validate,
  parseResourceSpec,
  readDaemonCapacity,
  resolveResourceOptions,
  limitsLogLine,
};
