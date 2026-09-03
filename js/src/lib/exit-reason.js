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
 * The same scan answers a narrower question for consumers that key off
 * `oomKilled`: was this run killed by memory exhaustion at all? That answer is
 * surfaced as `memoryExhausted` plus `memoryExhaustedReason`, the log line that
 * carried the evidence (issue #165).
 *
 * Both fields are hints, never verdicts: they never change `status`,
 * `exitCode` or `oomKilled`.
 */

/**
 * Reasons carrying this prefix report memory exhaustion, whatever the mechanism
 * (runtime self-abort, kernel OOM killer, failed allocation).
 */
const MEMORY_EXHAUSTION_PREFIX = 'memory-exhaustion';

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
 * Longest `memoryExhaustedReason` reported. A marker line is a single line of
 * runtime output, but a log can contain arbitrarily long lines, and the reason
 * travels inside status records that stay readable only when bounded.
 */
const MAX_MARKER_LINE_LENGTH = 300;

/**
 * Extract the whole log line containing `index`, trimmed and length-bounded.
 * @param {string} text - Log text
 * @param {number} index - Offset of the match inside `text`
 * @returns {string} The line the match sits on
 */
function extractLineAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  const line = text.slice(start, end === -1 ? undefined : end).trim();
  return line.length > MAX_MARKER_LINE_LENGTH
    ? `${line.slice(0, MAX_MARKER_LINE_LENGTH)}...`
    : line;
}

/**
 * Find the first known fatal marker in log text.
 * @param {string|null|undefined} text - Log text (usually the log tail)
 * @param {(marker: {reason: string, pattern: RegExp}) => boolean} [accept] - Marker filter
 * @returns {{reason: string, line: string}|null} Marker and the line carrying it
 */
function findExitReasonMarker(text, accept = () => true) {
  if (!text) {
    return null;
  }
  for (const marker of EXIT_REASON_MARKERS) {
    if (!accept(marker)) {
      continue;
    }
    const match = marker.pattern.exec(text);
    if (match) {
      return { reason: marker.reason, line: extractLineAt(text, match.index) };
    }
  }
  return null;
}

/**
 * Scan log text for a known fatal marker.
 * @param {string|null|undefined} text - Log text (usually the log tail)
 * @returns {string|null} Detected reason, or null when nothing matched
 */
function detectExitReason(text) {
  const marker = findExitReasonMarker(text);
  return marker ? marker.reason : null;
}

/**
 * Scan log text for a marker that specifically reports memory exhaustion.
 * @param {string|null|undefined} text - Log text (usually the log tail)
 * @returns {{reason: string, line: string}|null} Marker and the line carrying it
 */
function detectMemoryMarker(text) {
  return findExitReasonMarker(text, (marker) =>
    marker.reason.startsWith(MEMORY_EXHAUSTION_PREFIX)
  );
}

/**
 * Resolve the memory-exhaustion observation for a finished execution (#165).
 *
 * A runtime that aborts on its own heap limit is invisible to every container
 * signal: it dies below the container limit, so `State.OOMKilled` stays `false`
 * and the cgroup `oom_kill` counter stays `0`. The only evidence is what the
 * runtime printed on its way out, which sits in the very log tail the footer
 * scan already reads.
 *
 * Like `oomKilled` (#151) this is an *observation*, never a verdict: it is only
 * derived for a run that already ended abnormally, so a log that merely quotes
 * a fatal marker (a test fixture, an `rg` dump) cannot turn a clean run into a
 * reported memory failure.
 *
 * @param {{exitCode?: number|null, logTail?: string|null, oomKilled?: boolean}|null} input
 * @returns {{memoryExhausted: true, memoryExhaustedReason: string}|null}
 */
function resolveMemoryExhaustion(input) {
  if (!input) {
    return null;
  }
  const { exitCode } = input;
  if (
    typeof exitCode !== 'number' ||
    !Number.isFinite(exitCode) ||
    exitCode === 0
  ) {
    return null;
  }

  const marker = detectMemoryMarker(input.logTail);
  if (marker) {
    return { memoryExhausted: true, memoryExhaustedReason: marker.line };
  }
  if (input.oomKilled === true) {
    return {
      memoryExhausted: true,
      memoryExhaustedReason: 'Docker reported State.OOMKilled=true',
    };
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
  MEMORY_EXHAUSTION_PREFIX,
  SIGNAL_NAMES,
  detectExitReason,
  detectMemoryMarker,
  findExitReasonMarker,
  resolveMemoryExhaustion,
  resolveExitReason,
  signalNameForExitCode,
};
