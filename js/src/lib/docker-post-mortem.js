/**
 * Container post-mortem facts (issues #170, #171).
 *
 * When a detached container dies the only thing `start` used to write into the
 * log was `Reason: exitCode=137 oomKilled=false` — the two facts that, together,
 * say the least. `137` is `128 + 9`, i.e. SIGKILL, and `oomKilled=false` rules
 * out the cgroup OOM killer, so the container was killed from the outside
 * (`docker kill`, a `docker stop` escalation, systemd, the CI runner). None of
 * that was said out loud, and the three fields that would have shown *when* it
 * happened — `State.StartedAt`, `State.FinishedAt`, `State.Error` — were never
 * read at all, even though the watcher was already one `docker inspect` away
 * from them.
 *
 * This module owns those facts in one place:
 * - `describeExitCode()` decodes `128 + n` once, for the watcher (completion
 *   time, written into the log) and for `--status` (query time, in memory), so
 *   the two can never disagree (issue #171);
 * - the `build*Snippet()` helpers generate the POSIX shell the detached watcher
 *   runs, including the signal table, so the shell and the runtime share a
 *   single source of truth;
 * - `formatContainerPostMortem()` renders the same block for callers that
 *   already hold the facts in memory (the attached docker path).
 */

const {
  SIGNAL_NAMES,
  UNKNOWN_EXIT_CODE,
  describeExitCode,
} = require('./exit-reason');
const { shellQuote } = require('./isolation-log-utils');

/**
 * Docker's zero value for a timestamp that was never set. `State.FinishedAt`
 * carries it for every container that has not finished, and `State.StartedAt`
 * for every container that never started. It must never reach a record as an
 * `endTime`: a year-1 timestamp is worse than an honest `null`.
 */
const DOCKER_ZERO_TIME = '0001-01-01T00:00:00Z';

/** Placeholder written instead of a fact that could not be observed. */
const UNKNOWN = UNKNOWN_EXIT_CODE;

/** Placeholder for `State.Error` when docker reported no error at all. */
const NO_ERROR = '(none)';

/** Header line of the post-mortem block appended to a kept container's log. */
const POST_MORTEM_HEADER = '=== Container post-mortem ===';

/**
 * Normalize a timestamp reported by `docker inspect`.
 * @param {string|null|undefined} value - Raw `State.StartedAt`/`State.FinishedAt`
 * @returns {string|null} The timestamp, or null when docker reported no time
 */
function normalizeDockerTimestamp(value) {
  const text = String(
    value === null || value === undefined ? '' : value
  ).trim();
  if (!text || text === DOCKER_ZERO_TIME || text === UNKNOWN) {
    return null;
  }
  if (text === '<no value>' || !Number.isFinite(Date.parse(text))) {
    return null;
  }
  return text;
}

/**
 * Format the time a container was alive.
 * @param {string|null} startedAt - `State.StartedAt`
 * @param {string|null} finishedAt - `State.FinishedAt`
 * @returns {string|null} Lifetime such as `5.798s`, or null when unknown
 */
function formatLifetime(startedAt, finishedAt) {
  const start = normalizeDockerTimestamp(startedAt);
  const end = normalizeDockerTimestamp(finishedAt);
  if (!start || !end) {
    return null;
  }
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}s`;
}

/**
 * Render the post-mortem block for facts already held in memory.
 * @param {object} facts - Container name and inspected `State` fields
 * @returns {string} Block text, newline terminated
 */
function formatContainerPostMortem(facts = {}) {
  const startedAt = normalizeDockerTimestamp(facts.startedAt);
  const finishedAt = normalizeDockerTimestamp(facts.finishedAt);
  const lifetime = formatLifetime(facts.startedAt, facts.finishedAt);
  const error = String(facts.error || '').trim();
  return [
    POST_MORTEM_HEADER,
    `Container:  ${facts.containerName || UNKNOWN}`,
    `Exit Code:  ${describeExitCode(facts.exitCode).text}`,
    `OOMKilled:  ${facts.oomKilled === undefined || facts.oomKilled === null ? UNKNOWN : facts.oomKilled}`,
    `StartedAt:  ${startedAt || UNKNOWN}`,
    `FinishedAt: ${finishedAt || UNKNOWN}`,
    `Lifetime:   ${lifetime || UNKNOWN}`,
    `Error:      ${error || NO_ERROR}`,
    '',
  ].join('\n');
}

/**
 * Render the single line written when a container is removed, so a successful
 * run keeps its log terse while still carrying the same facts (issue #171).
 * @param {object} facts - Container name and inspected `State` fields
 * @returns {string} One line, newline terminated
 */
function formatContainerRemovalNote(facts = {}) {
  const described = describeExitCode(facts.exitCode);
  const signal = described.signal ? `, ${described.signal}` : '';
  const lifetime = formatLifetime(facts.startedAt, facts.finishedAt) || UNKNOWN;
  const oomKilled =
    facts.oomKilled === undefined || facts.oomKilled === null
      ? UNKNOWN
      : facts.oomKilled;
  return (
    `Container removed: ${facts.containerName || UNKNOWN} ` +
    `(exit ${described.code === null ? UNKNOWN : described.code}${signal}, ` +
    `lifetime ${lifetime}, oomKilled=${oomKilled})\n`
  );
}

/** Shell variables the completion watcher fills in and the snippets consume. */
const SHELL_VARS = {
  exit: '__start_command_exit',
  oom: '__start_command_oom',
  started: '__start_command_started',
  finished: '__start_command_finished',
  error: '__start_command_error',
  errorText: '__start_command_error_text',
  signal: '__start_command_signal',
  exitText: '__start_command_exit_text',
  lifetime: '__start_command_lifetime',
  running: '__start_command_running',
};

/** `docker inspect -f` template collecting every post-mortem fact at once. */
const DOCKER_STATE_INSPECT_FORMAT =
  '{{.State.ExitCode}} {{.State.OOMKilled}} {{.State.StartedAt}} {{.State.FinishedAt}}';

/** `docker inspect -f` template answering "is the container still running?". */
const DOCKER_RUNNING_INSPECT_FORMAT = '{{.State.Running}}';

/**
 * Written into the log when `docker logs -f` returned while the container was
 * still running (issue #174).
 */
const LOG_CAPTURE_STOPPED_NOTE =
  'Log capture stopped early: docker logs -f returned while the container ' +
  'was still running (a failed write to this log such as ENOSPC, or a dockerd ' +
  'restart). Waiting for the container to exit.';

/**
 * Written into the log when the watcher gave up while the container was still
 * running. No footer follows: an `Exit Code:` line would be a fabrication.
 */
const STILL_RUNNING_NOTE =
  'The watcher stopped observing it before it exited, so it was not removed ' +
  'and the execution record stays executing.';

/**
 * Shell condition that holds while the container is running.
 * @param {string} quotedName - Already shell-quoted container name
 * @returns {string} Shell condition
 */
function buildDockerRunningCondition(quotedName) {
  return `[ "$(docker inspect -f '${DOCKER_RUNNING_INSPECT_FORMAT}' ${quotedName} 2>/dev/null)" = true ]`;
}

/**
 * Shell fragment blocking until the container has really exited.
 *
 * `docker logs -f` and `docker wait` both return early when the *stream* ends
 * rather than the container: `docker logs -f C >> LOG` returns as soon as its
 * own write to LOG fails (ENOSPC, when the container filled the disk the log
 * lives on), and both return when dockerd restarts under live-restore while the
 * container keeps running. The watcher used to take that return as the
 * container's exit, inspect a *running* container — Docker reports its zero
 * values `ExitCode=0 FinishedAt=0001-01-01T00:00:00Z` — and `docker rm -f` the
 * live workload as a success (issue #174). So the fragment loops on
 * `.State.Running`, not on the return of the command it waited on; `sleep 1`
 * keeps a failing `docker wait` from spinning.
 *
 * @param {string} containerName - Container to wait for
 * @param {string|null} [quotedLogPath] - Already shell-quoted log path, to
 *   record that log capture stopped early; null when there is no log
 * @returns {string} Shell command
 */
function buildDockerWaitForExitSnippet(containerName, quotedLogPath = null) {
  const quotedName = shellQuote(containerName);
  const running = buildDockerRunningCondition(quotedName);
  const parts = [];
  if (quotedLogPath) {
    parts.push(
      `if ${running}; then printf '\\n%s\\n' ${shellQuote(LOG_CAPTURE_STOPPED_NOTE)} >> ${quotedLogPath} 2>/dev/null; fi`
    );
  }
  parts.push(
    `while ${running}; do docker wait ${quotedName} >/dev/null 2>&1 || sleep 1; done`
  );
  return parts.join('; ');
}

/**
 * Shell fragment reading the container's terminal state.
 *
 * Also records `.State.Running` in `$__start_command_running`, so the caller
 * can refuse to remove or finalize a container that is still alive
 * (issue #174).
 *
 * The four whitespace-free fields are split with `set --` rather than the
 * `${var%% *}` / `${var##* }` pair the two-field version used: those only ever
 * reach the first and the last field. `State.Error` is read separately because
 * it is free-form text that can contain spaces.
 *
 * @param {string} containerName - Container to inspect
 * @returns {string} Shell command
 */
function buildDockerStateSnippet(containerName) {
  const quotedName = shellQuote(containerName);
  const v = SHELL_VARS;
  return [
    `__start_command_state=$(docker inspect -f '${DOCKER_STATE_INSPECT_FORMAT}' ${quotedName} 2>/dev/null || printf '%s' '-1 false ${UNKNOWN} ${UNKNOWN}')`,
    'set -- $__start_command_state',
    `${v.exit}=\${1:--1}`,
    `${v.oom}=\${2:-false}`,
    `${v.started}=\${3:-${UNKNOWN}}`,
    `${v.finished}=\${4:-${UNKNOWN}}`,
    `${v.error}=$(docker inspect -f '{{.State.Error}}' ${quotedName} 2>/dev/null)`,
    `case "$${v.started}" in ${DOCKER_ZERO_TIME}|'') ${v.started}=${UNKNOWN};; esac`,
    `case "$${v.finished}" in ${DOCKER_ZERO_TIME}|'') ${v.finished}=${UNKNOWN};; esac`,
    // `ExitCode=0` next to a zero `FinishedAt` is Docker's zero value for a
    // container that has not finished, never an observed exit 0 (issue #174).
    `if [ "$${v.finished}" = ${UNKNOWN} ] && [ "$${v.exit}" = 0 ]; then ${v.exit}=-1; fi`,
    `${v.running}=$(docker inspect -f '${DOCKER_RUNNING_INSPECT_FORMAT}' ${quotedName} 2>/dev/null)`,
    buildSignalDecodeSnippet(),
    buildLifetimeSnippet(),
  ].join('; ');
}

/**
 * Shell fragment decoding `128 + n` into a signal name.
 *
 * The `case` arms are generated from the very table `describeExitCode()` uses,
 * so the log the watcher writes and the `exitReason` `--status` computes can
 * never name different signals for the same code (issue #171).
 *
 * @returns {string} Shell command
 */
function buildSignalDecodeSnippet() {
  const v = SHELL_VARS;
  const arms = Object.entries(SIGNAL_NAMES)
    .map(([signal, name]) => `${128 + Number(signal)}) ${v.signal}=${name};;`)
    .join(' ');
  return [
    `${v.signal}=''`,
    `case "$${v.exit}" in ${arms} esac`,
    `${v.exitText}="$${v.exit}"`,
    `if [ -n "$${v.signal}" ]; then ${v.exitText}="$${v.exit} ($${v.signal} - 128+$((${v.exit} - 128)))"; fi`,
  ].join('; ');
}

/**
 * Shell fragment computing how long the container was alive.
 *
 * Best effort by design: `date -d` is GNU, `date -j -f` is BSD, and a host that
 * offers neither leaves the lifetime `unknown` rather than guessing.
 *
 * BSD `date` cannot parse the fractional seconds docker reports, so the
 * fallback strips them before parsing and adds them back afterwards. Truncating
 * both timestamps to whole seconds instead would *not* cancel out: a container
 * alive from `.942` to `.740` of the next-but-five second measures 5.798s but
 * truncates to 6.000s, and the error can reach a full second either way.
 *
 * @returns {string} Shell command
 */
function buildLifetimeSnippet() {
  const v = SHELL_VARS;
  return [
    '__start_command_millis() { ' +
      'case "$1" in *.*) __start_command_frac=${1#*.};; ' +
      "*) printf '000'; return;; esac; " +
      '__start_command_frac=${__start_command_frac%%[!0-9]*}; ' +
      'printf \'%.3s\' "${__start_command_frac}000"; }',
    '__start_command_epoch_ms() { ' +
      '__start_command_ts=$(date -u -d "$1" +%s%3N 2>/dev/null); ' +
      'case "$__start_command_ts" in \'\'|*[!0-9]*) ' +
      '__start_command_ts=$(date -u -j -f \'%Y-%m-%dT%H:%M:%S\' "${1%.*}" +%s 2>/dev/null) && ' +
      '__start_command_ts="${__start_command_ts}$(__start_command_millis "$1")";; esac; ' +
      "case \"$__start_command_ts\" in ''|*[!0-9]*) __start_command_ts='';; esac; " +
      'printf \'%s\' "$__start_command_ts"; }',
    `${v.lifetime}=${UNKNOWN}`,
    `__start_command_t0=$(__start_command_epoch_ms "$${v.started}")`,
    `__start_command_t1=$(__start_command_epoch_ms "$${v.finished}")`,
    'if [ -n "$__start_command_t0" ] && [ -n "$__start_command_t1" ] && ' +
      '[ "$__start_command_t1" -ge "$__start_command_t0" ] 2>/dev/null; then ' +
      '__start_command_ms=$((__start_command_t1 - __start_command_t0)); ' +
      `${v.lifetime}="$((__start_command_ms / 1000)).$(printf '%03d' "$((__start_command_ms % 1000))")s"; fi`,
  ].join('; ');
}

/**
 * Shell fragment appending the post-mortem block for a kept container.
 * @param {string} containerName - Container that was kept
 * @param {string} quotedLogPath - Already shell-quoted log path
 * @returns {string} Shell command
 */
function buildDockerPostMortemSnippet(containerName, quotedLogPath) {
  const v = SHELL_VARS;
  return (
    `${v.errorText}="$${v.error}"; ` +
    `if [ -z "$${v.errorText}" ]; then ${v.errorText}='${NO_ERROR}'; fi; ` +
    `printf '\\n${POST_MORTEM_HEADER}\\nContainer:  %s\\nExit Code:  %s\\n` +
    `OOMKilled:  %s\\nStartedAt:  %s\\nFinishedAt: %s\\nLifetime:   %s\\nError:      %s\\n' ` +
    `${shellQuote(containerName)} "$${v.exitText}" "$${v.oom}" ` +
    `"$${v.started}" "$${v.finished}" "$${v.lifetime}" "$${v.errorText}" >> ${quotedLogPath}`
  );
}

/**
 * Shell fragment appending the note for a container the watcher lost while it
 * was still running (issue #174).
 * @param {string} containerName - Container that is still running
 * @param {string} quotedLogPath - Already shell-quoted log path
 * @returns {string} Shell command
 */
function buildDockerStillRunningNoteSnippet(containerName, quotedLogPath) {
  const quotedName = shellQuote(containerName);
  return (
    `printf '\\nContainer still running: %s\\n%s\\nCheck it with: docker inspect %s\\n' ` +
    `${quotedName} ${shellQuote(STILL_RUNNING_NOTE)} ${quotedName} >> ${quotedLogPath}`
  );
}

/**
 * Shell fragment appending the one-line note for a removed container.
 * @param {string} containerName - Container that was removed
 * @param {string} quotedLogPath - Already shell-quoted log path
 * @returns {string} Shell command
 */
function buildDockerRemovalNoteSnippet(containerName, quotedLogPath) {
  const v = SHELL_VARS;
  return (
    `__start_command_signal_note=''; ` +
    `if [ -n "$${v.signal}" ]; then __start_command_signal_note=", $${v.signal}"; fi; ` +
    `printf '\\nContainer removed: %s (exit %s%s, lifetime %s, oomKilled=%s)\\n' ` +
    `${shellQuote(containerName)} "$${v.exit}" "$__start_command_signal_note" ` +
    `"$${v.lifetime}" "$${v.oom}" >> ${quotedLogPath}`
  );
}

module.exports = {
  DOCKER_RUNNING_INSPECT_FORMAT,
  DOCKER_STATE_INSPECT_FORMAT,
  DOCKER_ZERO_TIME,
  LOG_CAPTURE_STOPPED_NOTE,
  STILL_RUNNING_NOTE,
  NO_ERROR,
  POST_MORTEM_HEADER,
  SHELL_VARS,
  UNKNOWN,
  buildDockerPostMortemSnippet,
  buildDockerRemovalNoteSnippet,
  buildDockerRunningCondition,
  buildDockerStateSnippet,
  buildDockerStillRunningNoteSnippet,
  buildDockerWaitForExitSnippet,
  buildLifetimeSnippet,
  buildSignalDecodeSnippet,
  describeExitCode,
  formatContainerPostMortem,
  formatContainerRemovalNote,
  formatLifetime,
  normalizeDockerTimestamp,
};
