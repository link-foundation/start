/**
 * Options for the guarded Docker snapshot resume (issue #224):
 *   --snapshot-wait <seconds>          wait for the host snapshot lock
 *   --snapshot-disk-wait <seconds>     wait for free disk instead of refusing
 *   --remove-original-after <seconds>  remove the original only if the
 *                                      replacement still runs after the delay
 *   --snapshot-size-hint <bytes>       skip the `docker inspect --size` walk
 *   --snapshot-prepare <command>       `docker exec` a command in the original
 *                                      before it is committed
 *
 * They only apply to `--resume`. The two waits also read
 * START_SNAPSHOT_LOCK_WAIT and START_SNAPSHOT_DISK_WAIT when the flags are
 * absent, so a supervisor can set them once for every resume it runs.
 */

const FIELDS = {
  '--snapshot-wait': 'snapshotWait',
  '--snapshot-disk-wait': 'snapshotDiskWait',
  '--remove-original-after': 'removeOriginalAfter',
  '--snapshot-size-hint': 'snapshotSizeHint',
  '--snapshot-prepare': 'snapshotPrepare',
};

const ENV_DEFAULTS = {
  snapshotWait: ['START_SNAPSHOT_LOCK_WAIT', '--snapshot-wait'],
  snapshotDiskWait: ['START_SNAPSHOT_DISK_WAIT', '--snapshot-disk-wait'],
};

const UNITS = {
  '': 1,
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
};

function createSnapshotOptionDefaults() {
  return {
    snapshotWait: null,
    snapshotDiskWait: null,
    removeOriginalAfter: null,
    snapshotSizeHint: null,
    snapshotPrepare: null,
  };
}

/**
 * Parse a non-negative number of seconds; fractions are allowed.
 * @param {string} value - Raw value
 * @param {string} name - Option or variable name for the error message
 * @returns {number} Seconds
 */
function parseSeconds(value, name) {
  const text = String(value).trim();
  const seconds = Number(text);
  if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(seconds)) {
    throw new Error(
      `Invalid ${name} value: "${value}". Expected a non-negative number of seconds.`
    );
  }
  return seconds;
}

/**
 * Parse a size in bytes; k, m, g and t suffixes are 1024-based.
 * @param {string} value - Raw value
 * @returns {number} Bytes
 */
function parseSizeHint(value) {
  const match = /^(\d+)([bkmgt])?$/.exec(String(value).trim().toLowerCase());
  const bytes = match ? Number(match[1]) * UNITS[match[2] || ''] : NaN;
  if (!Number.isSafeInteger(bytes)) {
    throw new Error(
      `Invalid --snapshot-size-hint value: "${value}". Expected a number of bytes (k, m, g, t suffixes allowed).`
    );
  }
  return bytes;
}

function parseValue(flag, value) {
  if (flag === '--snapshot-size-hint') {
    return parseSizeHint(value);
  }
  if (flag === '--snapshot-prepare') {
    if (String(value).trim() === '') {
      throw new Error('--snapshot-prepare requires a non-empty command');
    }
    return value;
  }
  return parseSeconds(value, flag);
}

/**
 * Parse one snapshot option.
 * @returns {number} Arguments consumed, 0 when `args[index]` is not one
 */
function parse(args, index, options) {
  const arg = args[index];
  const equals = arg.indexOf('=');
  const flag = equals === -1 ? arg : arg.slice(0, equals);
  const field = FIELDS[flag];
  if (!field) {
    return 0;
  }
  if (equals !== -1) {
    options[field] = parseValue(flag, arg.slice(equals + 1));
    return 1;
  }
  const value = args[index + 1];
  // A prepare command may itself start with a dash only through `=`.
  if (value === undefined || value.startsWith('-')) {
    const kind = {
      '--snapshot-size-hint': 'bytes',
      '--snapshot-prepare': 'command',
    }[flag];
    throw new Error(`Option ${flag} requires a ${kind || 'seconds'} argument`);
  }
  options[field] = parseValue(flag, value);
  return 2;
}

function hasValue(value) {
  return value !== null && value !== undefined;
}

/**
 * Reject snapshot options outside `--resume` and fill the waits from the
 * environment.
 * @param {object} options - Parsed wrapper options
 * @param {object} [env] - Environment
 */
function validate(options, env = process.env) {
  if (!hasValue(options.resume)) {
    for (const [flag, field] of Object.entries(FIELDS)) {
      if (hasValue(options[field])) {
        throw new Error(`${flag} is only valid with --resume`);
      }
    }
    return;
  }
  for (const [field, [name, flag]] of Object.entries(ENV_DEFAULTS)) {
    if (!hasValue(options[field]) && hasValue(env[name]) && env[name] !== '') {
      options[field] = parseSeconds(env[name], `${name} (${flag})`);
    }
  }
  if (hasValue(options.removeOriginalAfter)) {
    options.removeOriginal = true;
  }
}

/**
 * The `snapshotOptions` `resumeExecution` reads from the wrapper options.
 * @param {object} options - Parsed wrapper options
 * @returns {object} {waitSeconds, diskWaitSeconds, sizeHint, prepare}
 */
function snapshotResumeSettings(options = {}) {
  return {
    waitSeconds: options.snapshotWait ?? 0,
    diskWaitSeconds: options.snapshotDiskWait ?? 0,
    sizeHint: options.snapshotSizeHint ?? null,
    prepare: options.snapshotPrepare ?? null,
  };
}

module.exports = {
  FIELDS,
  createSnapshotOptionDefaults,
  parse,
  parseSeconds,
  parseSizeHint,
  snapshotResumeSettings,
  validate,
};
