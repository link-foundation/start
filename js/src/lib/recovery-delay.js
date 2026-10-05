/**
 * Random delay before each launch-time kill recovery (issue #181):
 *   --on-kill-resume-delay <min[-max]>   seconds; one number is a fixed delay,
 *                                        0 (the default) resumes at once
 *
 * One host-wide OOM event can kill several detached docker executions at the
 * same moment. Without a delay every watcher resumes its container in the same
 * second, all of them rebuild their working sets at once, and the next OOM
 * event follows. A uniformly random delay spreads the recoveries out.
 */

const DELAY_PATTERN = /^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/;

/** How often a pending recovery checks whether a stop was requested. */
const CANCEL_CHECK_INTERVAL_MS = 1000;

/**
 * Parse a delay range in seconds.
 * @param {string|number|null|undefined} value - `30-90`, `45`, `0`, ...
 * @returns {?{minSeconds: number, maxSeconds: number}} Range, or null when
 *   the value is missing or malformed
 */
function parseRecoveryDelayRange(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const match = DELAY_PATTERN.exec(String(value).trim());
  if (!match) {
    return null;
  }
  const minSeconds = Number(match[1]);
  const maxSeconds = match[2] === undefined ? minSeconds : Number(match[2]);
  if (
    !Number.isFinite(minSeconds) ||
    !Number.isFinite(maxSeconds) ||
    maxSeconds < minSeconds
  ) {
    return null;
  }
  return { minSeconds, maxSeconds };
}

/**
 * Validate and normalize the `--on-kill-resume-delay` argument.
 * @param {string} value - Raw argument
 * @returns {string} Normalized range: `30-90`, `45` or `0`
 * @throws {Error} If the value is not `<min>[-<max>]` seconds with max >= min
 */
function parseOnKillResumeDelayValue(value) {
  const range = parseRecoveryDelayRange(value);
  if (!range) {
    throw new Error(
      `Invalid --on-kill-resume-delay value: "${value}". ` +
        'Expected seconds as <min>[-<max>] with max >= min, e.g. 30-90.'
    );
  }
  return formatRecoveryDelayRange(range);
}

/**
 * @param {{minSeconds: number, maxSeconds: number}} range - Delay range
 * @returns {string} `30-90` for a range, `45` for a fixed delay
 */
function formatRecoveryDelayRange(range) {
  return range.minSeconds === range.maxSeconds
    ? `${range.minSeconds}`
    : `${range.minSeconds}-${range.maxSeconds}`;
}

/**
 * The delay range stored in the record, or null when there is no delay.
 * @param {object} options - Options or record options (onKillResumeDelay)
 * @returns {?string} Normalized non-zero range
 */
function getOnKillResumeDelay(options = {}) {
  const range = parseRecoveryDelayRange(options.onKillResumeDelay);
  if (!range || range.maxSeconds <= 0) {
    return null;
  }
  return formatRecoveryDelayRange(range);
}

/**
 * Pick a uniformly random delay from the range.
 * @param {string|null} value - Stored range (`30-90`)
 * @param {function(): number} [random] - Source in [0, 1), for tests
 * @returns {number} Delay in whole milliseconds, 0 without a range
 */
function pickRecoveryDelayMs(value, random = Math.random) {
  const range = parseRecoveryDelayRange(value);
  if (!range) {
    return 0;
  }
  const minMs = range.minSeconds * 1000;
  const maxMs = range.maxSeconds * 1000;
  return Math.round(minMs + (maxMs - minMs) * random());
}

/**
 * @param {number} delayMs - Delay in milliseconds
 * @returns {string} `42s`, `42.5s`
 */
function formatRecoveryDelay(delayMs) {
  return `${Math.round(delayMs / 100) / 10}s`;
}

/**
 * Block the current thread. The recovery entry point is a short-lived
 * synchronous child of the watcher shell, so there is no event loop to keep
 * responsive; `Atomics.wait` works on the main thread of node and bun.
 * @param {number} ms - Milliseconds
 */
function sleepSync(ms) {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

/**
 * Wait out the delay in short steps, giving up as soon as `shouldCancel`
 * returns true (a `--stop` during the wait).
 * @param {object} params - {delayMs, shouldCancel, sleep, intervalMs}
 * @returns {boolean} True when the wait was cancelled
 */
function waitForRecoveryDelay(params) {
  const sleep = params.sleep || sleepSync;
  const shouldCancel = params.shouldCancel || (() => false);
  const intervalMs = params.intervalMs || CANCEL_CHECK_INTERVAL_MS;
  let remaining = Math.max(0, Number(params.delayMs) || 0);
  while (remaining > 0) {
    if (shouldCancel()) {
      return true;
    }
    const step = Math.min(intervalMs, remaining);
    sleep(step);
    remaining -= step;
  }
  return shouldCancel();
}

module.exports = {
  CANCEL_CHECK_INTERVAL_MS,
  formatRecoveryDelay,
  formatRecoveryDelayRange,
  getOnKillResumeDelay,
  parseOnKillResumeDelayValue,
  parseRecoveryDelayRange,
  pickRecoveryDelayMs,
  sleepSync,
  waitForRecoveryDelay,
};
