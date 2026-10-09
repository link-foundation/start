/** Docker CPU hysteresis with timestamp-weighted, fully covered windows. */
const DEFAULTS = {
  cpus: 2,
  trigger: 95,
  triggerWindowMs: 900000,
  release: 65,
  releaseWindowMs: 900000,
};
const FIELDS = {
  '--cpu-penalty-cpus': 'cpus',
  '--cpu-penalty-trigger': 'trigger',
  '--cpu-penalty-trigger-window': 'triggerWindowMs',
  '--cpu-penalty-release': 'release',
  '--cpu-penalty-release-window': 'releaseWindowMs',
};
function duration(value) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
  const n = m
    ? Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]]
    : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw Error(`Invalid CPU penalty duration: ${value}`);
  }
  return n;
}
function parse(args, index, options) {
  const [flag, inline] = args[index].split('=', 2);
  if (flag === '--cpu-penalty') {
    if (inline !== undefined) {
      throw Error('--cpu-penalty does not take a value');
    }
    options.cpuPenalty = true;
    return 1;
  }
  const field = FIELDS[flag];
  if (!field) {
    return 0;
  }
  const value = inline ?? args[index + 1];
  if (!value) {
    throw Error(`${flag} requires a value`);
  }
  const number = field.endsWith('Ms')
    ? duration(value)
    : Number(field === 'cpus' ? value : value.replace(/%$/, ''));
  if (
    !(number > 0) ||
    !Number.isFinite(number) ||
    (field !== 'cpus' && !field.endsWith('Ms') && number > 100)
  ) {
    throw Error(`Invalid ${flag}: ${value}`);
  }
  options.cpuPenaltyConfig = {
    ...DEFAULTS,
    ...options.cpuPenaltyConfig,
    [field]: number,
  };
  return inline === undefined ? 2 : 1;
}
function validate(options) {
  if (!options.cpuPenalty && !options.cpuPenaltyConfig) {
    return;
  }
  if (!options.cpuPenalty) {
    throw Error('CPU penalty settings require --cpu-penalty');
  }
  if (!(options.isolatedStack || [options.isolated]).includes('docker')) {
    throw Error('--cpu-penalty requires Docker isolation');
  }
  options.cpuPenaltyConfig = { ...DEFAULTS, ...options.cpuPenaltyConfig };
}
function initialState(baseCpus = null, now = Date.now(), saved = null) {
  return {
    phase: saved?.phase === 'penalized' ? 'penalized' : 'observing',
    since: saved?.phase === 'penalized' ? saved.since : now,
    limitCpus: saved?.phase === 'penalized' ? saved.limitCpus : baseCpus,
    baseCpus,
    penaltyCount: saved?.penaltyCount || 0,
    penalizedMs: saved?.penalizedMs || 0,
    samples: [],
    lastAt: now,
    capacity: null,
  };
}
function average(samples, now, window) {
  const start = now - window;
  if (
    samples.length < 2 ||
    samples[0].at > start ||
    samples.at(-1).at !== now
  ) {
    return null;
  }
  let weighted = 0;
  for (let i = 1; i < samples.length; i++) {
    const left = Math.max(start, samples[i - 1].at),
      right = samples[i].at;
    if (right > left) {
      weighted += (right - left) * samples[i - 1].cores;
    }
  }
  return weighted / window;
}
function evaluate(
  state,
  { now, cores, daemonCpus, maxGapMs },
  config = DEFAULTS
) {
  const s = { ...state, samples: [...state.samples] };
  if (s.phase === 'penalized') {
    s.penalizedMs += Math.max(0, now - s.lastAt);
  }
  s.lastAt = now;
  const capacity = Number.isFinite(daemonCpus)
    ? Math.min(s.baseCpus || Infinity, daemonCpus)
    : NaN;
  if (
    !(cores >= 0) ||
    !Number.isFinite(cores) ||
    !(capacity > 0) ||
    now <= (s.samples.at(-1)?.at ?? -Infinity) ||
    (s.samples.length && now - s.samples.at(-1).at > maxGapMs) ||
    s.capacity !== capacity
  ) {
    s.samples = [];
  }
  s.capacity = capacity;
  if (!(cores >= 0) || !Number.isFinite(cores) || !(capacity > 0)) {
    return { state: s, action: null };
  }
  s.samples.push({ at: now, cores });
  const window =
    s.phase === 'penalized' ? config.releaseWindowMs : config.triggerWindowMs;
  while (s.samples.length > 2 && s.samples[1].at <= now - window) {
    s.samples.shift();
  }
  const avg = average(s.samples, now, window);
  let action = null;
  if (
    s.phase === 'observing' &&
    config.cpus < capacity &&
    avg !== null &&
    avg >= (config.trigger / 100) * capacity
  ) {
    action = { kind: 'apply', cpus: config.cpus, average: avg, capacity };
    s.phase = 'penalized';
    s.since = now;
    s.limitCpus = config.cpus;
    s.penaltyCount++;
  } else if (
    s.phase === 'penalized' &&
    (config.cpus >= capacity ||
      (now - s.since >= config.releaseWindowMs &&
        avg !== null &&
        avg < (config.release / 100) * config.cpus))
  ) {
    action = { kind: 'lift', cpus: capacity, average: avg, capacity };
    s.phase = 'observing';
    s.since = now;
    s.limitCpus = capacity;
  }
  if (action) {
    s.samples = [];
  }
  return { state: s, action };
}
module.exports = {
  DEFAULTS,
  parse,
  validate,
  duration,
  initialState,
  average,
  evaluate,
};
