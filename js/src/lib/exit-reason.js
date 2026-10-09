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

const os = require('os');

/**
 * Reasons carrying this prefix report memory exhaustion, whatever the mechanism
 * (runtime self-abort, kernel OOM killer, failed allocation).
 */
const MEMORY_EXHAUSTION_PREFIX = 'memory-exhaustion';

/**
 * Reason reported when the container-wide OOM observation explains the exit.
 */
const CGROUP_OOM_EXIT_REASON = `${MEMORY_EXHAUSTION_PREFIX} (cgroup-oom-killer)`;

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
    reason: 'memory-exhaustion (go-runtime)',
    pattern: /fatal error: runtime: out of memory/i,
  },
  {
    reason: 'memory-exhaustion (allocation-failure)',
    pattern:
      /std::bad_alloc|Cannot allocate memory|memory allocation of \d+ bytes failed|Allocation failed - process out of memory|Array buffer allocation failed/i,
  },
];

/**
 * Exit codes above 128 encode the signal that killed the process.
 * Only the signals that actually show up in command logs are named.
 * @type {Object<number, string>}
 */
/** Rendered when an exit code is unavailable or not numeric. */
const UNKNOWN_EXIT_CODE = 'unknown';

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
 * The container-wide OOM signals (`State.OOMKilled`, the cgroup `oom_kill`
 * counter) only count when the exit fits an OOM kill of the command itself:
 * a child OOM-killed under a command that later exits 1 is not the reason the
 * command ended (#180).
 *
 * @param {{exitCode?: number|null, logTail?: string|null, oomKilled?: boolean, cgroupMemory?: object|null}|null} input
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

  const evidence =
    input.exitEvidence || require('./exit-evidence').fromLog(input.logTail);
  if (evidence.daemonRestart) {
    return null;
  }
  const marker = detectMemoryMarker(input.logTail);
  if (
    marker &&
    !(marker.reason.includes('kernel-oom-killer') && !evidence.mainOom)
  ) {
    return { memoryExhausted: true, memoryExhaustedReason: marker.line };
  }
  if (input.oomKilled === true && isOomKillOfCommand(input)) {
    return {
      memoryExhausted: true,
      memoryExhaustedReason: 'Docker reported State.OOMKilled=true',
    };
  }
  const oomKills = cgroupOomKills(input.cgroupMemory);
  if (oomKills > 0 && isOomKillOfCommand(input)) {
    return {
      memoryExhausted: true,
      memoryExhaustedReason: `cgroup memory.events reported oom_kill=${oomKills}`,
    };
  }
  return null;
}

/**
 * `oom_kill` counter sampled from the container cgroup (issue #182).
 * @param {{oomKills?: number|null}|null|undefined} cgroupMemory - Sampled counters
 * @returns {number} Number of OOM-killed processes, 0 when unknown
 */
function cgroupOomKills(cgroupMemory) {
  const value = cgroupMemory ? cgroupMemory.oomKills : null;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Can a container-wide OOM observation be blamed on the command itself?
 *
 * Docker's `State.OOMKilled` and the cgroup `oom_kill` counter are
 * container-wide and sticky (moby/moby#43564): they turn on as soon as *any*
 * process in the container is OOM-killed, e.g. one `rustc` child under
 * `cargo test`, while the command keeps running and later exits on its own
 * (issue #180). The OOM killer always sends SIGKILL, so the observation only
 * explains the command's exit when that exit is 137 (`128 + SIGKILL`) or there
 * is no usable exit code at all (null, or the `-1` of an unknown exit). This is
 * the rule `isKilledExit()` already applies to `--on-kill-resume` (#178).
 *
 * @param {{exitCode?: number|null, oomKilled?: boolean, cgroupMemory?: object|null}|null} input
 * @returns {boolean} True when an OOM was observed and the exit fits an OOM kill
 */
function isOomKillOfCommand(input) {
  if (!input) {
    return false;
  }
  const evidence =
    input.exitEvidence || require('./exit-evidence').fromLog(input.logTail);
  if (!evidence.mainOom || evidence.daemonRestart) {
    return false;
  }
  const { exitCode } = input;
  if (typeof exitCode !== 'number' || !Number.isFinite(exitCode)) {
    return true;
  }
  return exitCode < 0 || signalNameForExitCode(exitCode) === 'SIGKILL';
}

/**
 * Exit code of a child process that has finished.
 *
 * Node reports `code === null` for a child killed by a signal, and the
 * `code || 0` this replaces turned that into a successful exit 0 (issue #174).
 * A signal death follows the shell's `128 + n` convention, so the result
 * decodes back to the signal through `describeExitCode()`; a missing code with
 * no known signal is a failure (1), never a success.
 *
 * @param {number|null|undefined} code - `code` from `exit`/`close`
 * @param {string|null} [signal] - `signal` from `exit`/`close`, e.g. `SIGKILL`
 * @returns {number} Exit code
 */
function resolveChildExitCode(code, signal = null) {
  if (typeof code === 'number' && Number.isFinite(code)) {
    return code;
  }
  const number = signal ? os.constants.signals[signal] : undefined;
  return typeof number === 'number' ? 128 + number : 1;
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
 * Describe a terminal exit code, decoding the `128+n` signal convention.
 *
 * Single source of truth for issue #171.4: the detached Docker watcher writes
 * this text into the log at completion time (through the shell it generates),
 * and `--status` renders the same text at query time from the stored record.
 * Both used to decode `128+n` on their own, so they could disagree.
 *
 * @param {number|string|null|undefined} exitCode - Terminal exit code
 * @returns {{code: number|null, signal: string|null, text: string}} Description
 */
function describeExitCode(exitCode) {
  const code =
    typeof exitCode === 'number' ? exitCode : Number.parseInt(exitCode, 10);
  if (!Number.isFinite(code)) {
    return { code: null, signal: null, text: UNKNOWN_EXIT_CODE };
  }
  const signal = signalNameForExitCode(code);
  return {
    code,
    signal,
    text: signal ? `${code} (${signal} - 128+${code - 128})` : String(code),
  };
}

/**
 * Resolve the best available hint for why an execution ended.
 *
 * Precedence: the log marker (evidence written by the command itself), then the
 * cgroup OOM observation when the exit fits an OOM kill of the command (#180),
 * then the signal encoded in the exit code.
 *
 * @param {{exitCode?: number|null, logTail?: string|null, oomKilled?: boolean, cgroupMemory?: object|null}|null} input
 * @returns {string|null} Exit reason hint, or null when nothing is known
 */
function resolveExitReason(input) {
  if (!input) {
    return null;
  }

  const evidence =
    input.exitEvidence || require('./exit-evidence').fromLog(input.logTail);
  if (evidence.daemonRestart) {
    return 'killed (docker daemon restart)';
  }
  const fromLog = detectExitReason(input.logTail);
  if (
    fromLog &&
    !(fromLog.includes('kernel-oom-killer') && !evidence.mainOom)
  ) {
    return fromLog;
  }

  if (isOomKillOfCommand(input)) {
    return CGROUP_OOM_EXIT_REASON;
  }

  const signalName = signalNameForExitCode(input.exitCode);
  return signalName
    ? `signal (${signalName}${signalName === 'SIGKILL' ? '; cause unknown' : ''})`
    : null;
}

module.exports = {
  CGROUP_OOM_EXIT_REASON,
  EXIT_REASON_MARKERS,
  UNKNOWN_EXIT_CODE,
  MEMORY_EXHAUSTION_PREFIX,
  SIGNAL_NAMES,
  detectExitReason,
  detectMemoryMarker,
  findExitReasonMarker,
  isOomKillOfCommand,
  resolveMemoryExhaustion,
  describeExitCode,
  resolveChildExitCode,
  resolveExitReason,
  signalNameForExitCode,
};
