/**
 * Exit reason hints for finished executions.
 *
 * A numeric exit code alone is frequently misleading: a Bun/Node process that
 * exhausts its heap aborts itself, so the container reports `exitCode 139` with
 * `OOMKilled false` even though the run died of memory exhaustion (issue #162,
 * related to #144, #148 and #151). `start` already reads the tail of the log to
 * find the terminal footer, so the same tail is scanned for well-known fatal
 * markers and the finding is surfaced as an extra `exitReason` field.
 *
 * `exitReason` is a hint, never a verdict: it never changes `status`,
 * `exitCode` or `oomKilled`.
 */

/**
 * Fatal markers, most specific first. The first matching entry wins.
 * @type {{reason: string, pattern: RegExp}[]}
 */
const EXIT_REASON_MARKERS = [
  {
    reason: 'memory-exhaustion (v8-heap-limit)',
    pattern:
      /FATAL ERROR:[^\r\n]*(?:Reached heap limit|JavaScript heap out of memory)/i,
  },
  {
    reason: 'memory-exhaustion (v8-heap-limit)',
    pattern: /JavaScript heap out of memory/i,
  },
  {
    reason: 'memory-exhaustion (kernel-oom-killer)',
    pattern:
      /Out of memory: Kill(?:ed)? process|oom-kill(?:er)?[: ]|Killed process \d+/i,
  },
  {
    reason: 'memory-exhaustion (allocation-failure)',
    pattern:
      /std::bad_alloc|Cannot allocate memory|memory allocation of \d+ bytes failed|Allocation failed - process out of memory/i,
  },
];

/**
 * Exit codes above 128 encode the signal that killed the process.
 * Only the signals that actually show up in command logs are named.
 * @type {Object<number, string>}
 */
const SIGNAL_NAMES = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGILL',
  6: 'SIGABRT',
  8: 'SIGFPE',
  9: 'SIGKILL',
  11: 'SIGSEGV',
  13: 'SIGPIPE',
  15: 'SIGTERM',
};

/**
 * Scan log text for a known fatal marker.
 * @param {string|null|undefined} text - Log text (usually the log tail)
 * @returns {string|null} Detected reason, or null when nothing matched
 */
function detectExitReason(text) {
  if (!text) {
    return null;
  }
  for (const marker of EXIT_REASON_MARKERS) {
    if (marker.pattern.test(text)) {
      return marker.reason;
    }
  }
  return null;
}

/**
 * Map a shell exit code to the signal name it encodes.
 * @param {number|null|undefined} exitCode - Terminal exit code
 * @returns {string|null} Signal name, or null when the code is not a signal
 */
function signalNameForExitCode(exitCode) {
  if (typeof exitCode !== 'number' || !Number.isFinite(exitCode)) {
    return null;
  }
  if (exitCode <= 128 || exitCode > 128 + 64) {
    return null;
  }
  return SIGNAL_NAMES[exitCode - 128] || null;
}

/**
 * Resolve the best available hint for why an execution ended.
 *
 * Precedence: the log marker (evidence written by the command itself), then the
 * cgroup OOM observation, then the signal encoded in the exit code.
 *
 * @param {{exitCode?: number|null, logTail?: string|null, oomKilled?: boolean}|null} input
 * @returns {string|null} Exit reason hint, or null when nothing is known
 */
function resolveExitReason(input) {
  if (!input) {
    return null;
  }

  const fromLog = detectExitReason(input.logTail);
  if (fromLog) {
    return fromLog;
  }

  if (input.oomKilled === true) {
    return 'memory-exhaustion (cgroup-oom-killer)';
  }

  const signalName = signalNameForExitCode(input.exitCode);
  return signalName ? `signal (${signalName})` : null;
}

module.exports = {
  EXIT_REASON_MARKERS,
  SIGNAL_NAMES,
  detectExitReason,
  resolveExitReason,
  signalNameForExitCode,
};
