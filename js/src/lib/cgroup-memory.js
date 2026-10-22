/**
 * cgroup v2 memory counters of a detached docker container (issue #182).
 *
 * Docker's `State.OOMKilled` is container-wide and sticky (moby/moby#43564):
 * it says that *some* process in the container was OOM-killed at some point,
 * but not how many, not whether the container hit its own `--memory` limit or
 * the whole host ran out, and not how close the execution came to its limit.
 * The kernel provides raw counters per cgroup
 * (https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files):
 *   memory.events `oom`       allocation events reaching the memory limit
 *   memory.events `oom_kill`  processes killed here by *any* OOM killer
 *   memory.peak / memory.max  peak usage (Linux 5.19+) and limit (`max` when
 *                             unlimited)
 * These counters have different units and are hierarchical. A group OOM can
 * kill several processes for one allocation event; earlier allocation events
 * can also coexist with a later host OOM. Their comparison cannot establish
 * container, parent or host scope (issue #185).
 *
 * The cgroup is removed when the container stops, so the values cannot be read
 * afterwards. The detached completion watcher therefore samples them while the
 * container runs and hands the last sample to the post-mortem, the finalizer
 * and the recovery step. Best effort by design: no cgroup v2, a remote docker
 * daemon or a hidden `/proc` leave the counters unknown, and a kill in the last
 * sampling interval can be missed when the cgroup is gone before the final
 * read.
 */

const { shellQuote } = require('./isolation-log-utils');

/** Default seconds between samples; the watcher environment may override it. */
const CGROUP_SAMPLE_INTERVAL_SECONDS = 5;

/**
 * Longest wait between rounds that keep failing (issue #247), unless the
 * interval itself is longer. Each round without a sample doubles the wait.
 */
const CGROUP_SAMPLE_BACKOFF_MAX_SECONDS = 60;

/** Exit status of both in-container reads for unreadable counters. */
const CGROUP_UNREADABLE_EXIT = 3;

/** Shell variables used by the sampler snippets. */
const CGROUP_SHELL_VARS = {
  /** Last sample: `<memory.max> <memory.peak> <oom> <oom_kill>`. */
  sample: '__start_command_cgroup',
  sampler: '__start_command_cgroup_sampler',
  file: '__start_command_cgroup_file',
};

/**
 * Shell functions shared by the sampler and its final read:
 *   __start_command_cgroup_dir NAME  print the container's cgroup v2 directory
 *   __start_command_cgroup_read DIR  print `<max> <peak> <oom> <oom_kill> DIR`
 *
 * The directory comes from `/proc/<.State.Pid>/cgroup` (`0::<path>`), which
 * covers the systemd and cgroupfs drivers, `--cgroup-parent` and rootless
 * docker alike; the two default layouts are fallbacks. A candidate must name
 * the container ID, so a PID reported by a remote daemon can never select an
 * unrelated local cgroup. `START_COMMAND_CGROUP_ROOT` and
 * `START_COMMAND_PROC_ROOT` replace `/sys/fs/cgroup` and `/proc` (tests).
 *
 * @returns {string} Shell function definitions
 */
function buildCgroupFunctionsSnippet() {
  return [
    '__start_command_cgroup_dir() { __scd_id=$(docker inspect -f \'{{.Id}}\' "$1" 2>/dev/null); ' +
      '[ -n "$__scd_id" ] || return 1; ' +
      "__scd_pid=$(docker inspect -f '{{.State.Pid}}' \"$1\" 2>/dev/null); __scd_rel=''; " +
      'case "$__scd_pid" in \'\'|0|*[!0-9]*) ;; ' +
      '*) __scd_rel=$(sed -n \'s/^0:://p\' "${START_COMMAND_PROC_ROOT:-/proc}/$__scd_pid/cgroup" 2>/dev/null);; esac; ' +
      '__scd_root=${START_COMMAND_CGROUP_ROOT:-/sys/fs/cgroup}; ' +
      'for __scd_dir in ${__scd_rel:+"$__scd_root$__scd_rel"} ' +
      '"$__scd_root/system.slice/docker-$__scd_id.scope" "$__scd_root/docker/$__scd_id"; do ' +
      'case "$__scd_dir" in *"$__scd_id"*) if [ -r "$__scd_dir/memory.events" ]; then ' +
      'printf \'%s\' "$__scd_dir"; return 0; fi;; esac; done; return 1; }',
    '__start_command_cgroup_read() { __scr_events=$(cat "$1/memory.events" 2>/dev/null) || return 1; ' +
      "__scr_oom=$(printf '%s\\n' \"$__scr_events\" | sed -n 's/^oom //p'); " +
      "__scr_kill=$(printf '%s\\n' \"$__scr_events\" | sed -n 's/^oom_kill //p'); " +
      'case "$__scr_oom:$__scr_kill" in *[!0-9:]*|:*|*:) return 1;; esac; ' +
      '__scr_max=$(cat "$1/memory.max" 2>/dev/null); __scr_peak=$(cat "$1/memory.peak" 2>/dev/null); ' +
      'printf \'%s %s %s %s %s\\n\' "${__scr_max:--}" "${__scr_peak:--}" ' +
      '"${__scr_oom:--}" "${__scr_kill:--}" "$1"; }',
  ].join('; ');
}

/**
 * In-container loop of the long-lived sampler exec (issue #242): `$1` is the
 * cgroup directory. The host paces it with one newline per interval on stdin
 * (`docker exec -i`), so it runs only shell builtins: the task's own CPU
 * limit pays for no `cat`, `sed` or `sleep` processes. Stdin reaches EOF when
 * the exec's client is gone, so the loop never outlives the sampler; dockerd
 * would accept its output even then. Exit 3: unreadable counters (no
 * delegated `memory` controller), which no later round can change.
 * @returns {string} Shell script for `sh -c`
 */
function buildCgroupStreamScript() {
  return [
    'while read -r __scx_tick; do __scx_oom=; __scx_kill=; __scx_max=-; __scx_peak=-',
    `[ -r "$1/memory.events" ] || exit ${CGROUP_UNREADABLE_EXIT}`,
    'while read -r __scx_key __scx_value; do case "$__scx_key" in ' +
      'oom) __scx_oom=$__scx_value;; oom_kill) __scx_kill=$__scx_value;; esac; ' +
      'done < "$1/memory.events"',
    `case "$__scx_oom:$__scx_kill" in *[!0-9:]*|:*|*:) exit ${CGROUP_UNREADABLE_EXIT};; esac`,
    '[ ! -r "$1/memory.max" ] || read -r __scx_max < "$1/memory.max"',
    '[ ! -r "$1/memory.peak" ] || read -r __scx_peak < "$1/memory.peak"',
    'printf \'%s %s %s %s %s\\n\' "${__scx_max:--}" "${__scx_peak:--}" ' +
      '"$__scx_oom" "$__scx_kill" "$1" || exit 0; done',
  ].join('; ');
}

/** `$0` of the long-lived exec, visible in `ps` inside the task container. */
const CGROUP_STREAM_NAME = 'start-command-cgroup-stream';

/** Interval value that turns the sampler off (issue #242). */
const CGROUP_SAMPLING_OFF_REASON =
  'sampling disabled by START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS=off';

/**
 * Shell fragment starting the background sampler. It writes each sample to a
 * temp file with `mv`, so the watcher never reads a half-written line, and
 * ends by itself once the container is gone.
 *
 * Where the cgroup is readable locally it reads it directly. Otherwise, with
 * a private cgroup namespace (a mounted docker.sock), one long-lived
 * `docker exec -i` answers one host tick per interval (issue #242); a
 * successful read proves the container runs, so Docker is asked for liveness
 * only after a failed round or when the stream ends. Without a usable stream it falls back
 * to one `docker exec` per round; without `sh` in the image (exit 126/127) or
 * without any readable cgroup (exit 3 from either exec, issue #247) it
 * records the reason and stops. Other failed rounds are retried, each one
 * doubling the wait up to CGROUP_SAMPLE_BACKOFF_MAX_SECONDS; a sample restores
 * the interval. `START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS=off` disables
 * sampling.
 * @param {string} containerName - Container to sample
 * @returns {string} Shell command
 */
function buildCgroupSamplerStartSnippet(containerName) {
  const v = CGROUP_SHELL_VARS;
  const name = shellQuote(containerName);
  const remoteRead = `__start_command_cgroup_read /sys/fs/cgroup || exit ${CGROUP_UNREADABLE_EXIT}`;
  // Exit statuses no later round can change: no `sh`, or no counters.
  const permanent = `${CGROUP_UNREADABLE_EXIT}|126|127`;
  const backoff = CGROUP_SAMPLE_BACKOFF_MAX_SECONDS;
  const unavailable = (detail) =>
    `printf '%s\\n' "local cgroup unavailable; ${detail}" > "$${v.file}.reason"`;
  const execReason = unavailable(
    'Docker exec exit=$__scs_exit: ${__scs_detail:-private cgroup v2 counters unreadable}'
  );
  return [
    buildCgroupFunctionsSnippet(),
    `${v.file}="\${TMPDIR:-/tmp}/start-command-cgroup.$$"`,
    `rm -f "$${v.file}" "$${v.file}.tmp" "$${v.file}.reason"`,
    `__start_command_memory_limit=$(docker inspect -f '{{.HostConfig.Memory}}' ${name} 2>/dev/null)`,
    `__start_command_sample_name=${name}`,
    `( export START_COMMAND_CGROUP_SAMPLING=1; ` +
      // Validate in the watcher, so attached and detached launches inherit the
      // same setting. Never allow a malformed/zero sleep to create a busy loop.
      `__scs_interval=\${START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS:-${CGROUP_SAMPLE_INTERVAL_SECONDS}}; ` +
      `case "$__scs_interval" in [Oo][Ff][Ff]) printf '%s\\n' '${CGROUP_SAMPLING_OFF_REASON}' > "$${v.file}.reason"; exit 0;; ` +
      `*[!0-9]*|'') __scs_interval=${CGROUP_SAMPLE_INTERVAL_SECONDS};; esac; ` +
      `[ "$__scs_interval" -gt 0 ] 2>/dev/null || __scs_interval=${CGROUP_SAMPLE_INTERVAL_SECONDS}; ` +
      // Store one `<max> <peak> <oom> <oom_kill>` line. The previous sample is
      // read back from the file, so the stream's reader subshell can record
      // too. The first counter is a baseline, including after watcher restart;
      // only changes between adjacent samples supply exit-time evidence.
      `__scs_record() { set -f; set -- $1; set +f; case "$3:$4" in *[!0-9:]*|:*|*:) return 1;; esac; ` +
      `__scs_now=$(date +%s); __scs_previous=''; __scs_changed=0; __scs_previous_at=0; ` +
      `[ ! -r "$${v.file}" ] || read -r __scs_p __scs_p __scs_p __scs_previous __scs_changed __scs_previous_at __scs_p < "$${v.file}"; ` +
      'if [ -n "$__scs_previous" ] && [ "$4" -gt "$__scs_previous" ] 2>/dev/null && [ "$((__scs_now-__scs_previous_at))" -le 3 ]; then __scs_changed=$__scs_now; fi; ' +
      `printf '%s %s %s %s %s %s %s\\n' "$1" "$2" "$3" "$4" "$__scs_changed" "$__scs_now" "$__scs_dir" > "$${v.file}.tmp" && mv -f "$${v.file}.tmp" "$${v.file}"; }; ` +
      `__scs_dir=$(__start_command_cgroup_dir ${name}); ` +
      // The namespace is fixed at container creation, including when reads fail.
      `__scs_ns=$(docker inspect -f '{{.HostConfig.CgroupnsMode}}' ${name} 2>/dev/null); __scs_stream=1; __scs_reader=''; ` +
      `__scs_delay=$__scs_interval; ` +
      `while :; do __scs_ok=''; __scs_sampled=''; if [ -n "$__scs_dir" ]; then ` +
      '__scs_line=$(__start_command_cgroup_read "$__scs_dir") && __scs_record "$__scs_line" && __scs_ok=1; ' +
      `elif [ "$__scs_ns" != private ]; then ${unavailable('container cgroup namespace=${__scs_ns:-unavailable}, private required')}; break; ` +
      `elif [ "$__scs_stream" = 1 ]; then ` +
      // The reader ends with the stream; stopping the sampler stops it too.
      `trap 'kill "$__scs_reader" 2>/dev/null; wait "$__scs_reader" 2>/dev/null; exit 0' TERM; ` +
      // The ticker runs in the background, so a failed exec is reported at
      // once; it ends on its first write after the exec is gone.
      `{ { while :; do echo || exit 0; sleep "$__scs_interval" || exit 0; done 2>/dev/null & } | ` +
      `docker exec -i ${name} sh -c ${shellQuote(buildCgroupStreamScript())} ${CGROUP_STREAM_NAME} /sys/fs/cgroup 2>&1; printf '__scs_exit %s\\n' "$?"; } | ` +
      `{ __scs_got=''; __scs_exit=''; __scs_detail=''; while IFS= read -r __scs_line; do case "$__scs_line" in ` +
      `'__scs_exit '*) __scs_exit=\${__scs_line#__scs_exit };; ` +
      `*) if __scs_record "$__scs_line"; then __scs_got=1; elif [ -z "$__scs_detail" ]; then __scs_detail=$(printf '%s' "$__scs_line" | cut -c 1-240); fi;; esac; done; ` +
      `[ -z "$__scs_got" ] || exit 0; ${execReason}; ` +
      `case "$__scs_exit" in ''|0|*[!0-9]*) exit 1;; esac; exit "$__scs_exit"; } & ` +
      `__scs_reader=$!; wait "$__scs_reader"; __scs_exit=$?; trap - TERM; __scs_reader=''; ` +
      // No shell in the image or no counters: a per-round exec cannot
      // succeed either.
      `case "$__scs_exit" in 0) __scs_sampled=1;; ${permanent}) break;; *) __scs_stream=0;; esac; ` +
      `else __scs_remote=$(docker exec ${name} sh -c ${shellQuote(`${buildCgroupFunctionsSnippet()}; ${remoteRead}`)} 2>&1); __scs_exit=$?; ` +
      'if [ "$__scs_exit" = 0 ] && __scs_record "$__scs_remote"; then __scs_ok=1; ' +
      `else __scs_detail=$(printf "%s" "$__scs_remote" | sed -n "1p" | cut -c 1-240); ${execReason}; ` +
      `case "$__scs_exit" in ${permanent}) break;; esac; fi; fi; ` +
      // A successful read needs no Docker liveness probe, and the completion
      // watcher still stops us after docker wait.
      `if [ -z "$__scs_ok" ] && [ "$(docker inspect -f '{{.State.Running}}' ${name} 2>/dev/null)" = false ]; then break; fi; ` +
      // Back off while rounds keep failing, never below the interval.
      `if [ -n "$__scs_ok$__scs_sampled" ]; then __scs_delay=$__scs_interval; else __scs_delay=$((__scs_delay*2)); ` +
      `[ "$__scs_delay" -le ${backoff} ] || __scs_delay=${backoff}; [ "$__scs_delay" -ge "$__scs_interval" ] || __scs_delay=$__scs_interval; fi; ` +
      `sleep "$__scs_delay"; done ) >/dev/null 2>&1 & ${v.sampler}=$!`,
  ].join('; ');
}

/**
 * Shell fragment stopping the sampler once the container has exited and
 * leaving the last sample (`<max> <peak> <oom> <oom_kill>`, or empty) in
 * `$__start_command_cgroup`. The cgroup can outlive the main process for a
 * moment, so it is read one last time when it still exists.
 * @returns {string} Shell command
 */
function buildCgroupSamplerStopSnippet() {
  const v = CGROUP_SHELL_VARS;
  return [
    `kill "$${v.sampler}" 2>/dev/null`,
    `wait "$${v.sampler}" 2>/dev/null`,
    `${v.sample}=$(cat "$${v.file}" 2>/dev/null)`,
    `__start_command_memory_unavailable=$(cat "$${v.file}.reason" 2>/dev/null)`,
    `__scs_dir=$(printf '%s' "$${v.sample}" | cut -s -d ' ' -f 7-)`,
    `if [ -n "$__scs_dir" ] && __scs_line=$(__start_command_cgroup_read "$__scs_dir"); then ` +
      `__scs_old=$(printf '%s' "$${v.sample}" | cut -d ' ' -f 4); __scs_at=$(printf '%s' "$${v.sample}" | cut -d ' ' -f 6); ` +
      `__scs_changed=$(printf '%s' "$${v.sample}" | cut -d ' ' -f 5); __scs_now=$(date +%s); ` +
      `__scs_new=$(printf '%s' "$__scs_line" | cut -d ' ' -f 4); ` +
      `if [ "$__scs_new" -gt "$__scs_old" ] 2>/dev/null && [ "$((__scs_now-__scs_at))" -le 3 ]; then __scs_changed=$__scs_now; fi; ` +
      `${v.sample}="$(printf '%s' "$__scs_line" | cut -d ' ' -f 1-4) $__scs_changed $__scs_now"; fi`,
    `rm -f "$${v.file}" "$${v.file}.tmp" "$${v.file}.reason"`,
    `${v.sample}=$(printf '%s' "$${v.sample}" | cut -d ' ' -f 1-6)`,
  ].join('; ');
}

/**
 * Shell fragment appending the `Memory:` line of the post-mortem when a
 * sample exists.
 * @param {string} quotedLogPath - Already shell-quoted log path
 * @returns {string} Shell command
 */
function buildCgroupMemoryLogSnippet(quotedLogPath) {
  const v = CGROUP_SHELL_VARS;
  // A function, so `$1`.. of the watcher script itself stay untouched.
  return (
    `__start_command_cgroup_log() { __scm_note=''; ` +
    `if [ "$4" -gt 0 ] 2>/dev/null; then ` +
    `__scm_note=' (${OOM_SCOPE_NOTES[OOM_SCOPE.UNKNOWN]})'; fi; ` +
    `printf 'Memory:     memory.max=%s memory.peak=%s oom=%s oom_kill=%s%s\\n' ` +
    `"$1" "$2" "$3" "$4" "$__scm_note"; }; ` +
    `if [ -n "$${v.sample}" ]; then __start_command_cgroup_log $${v.sample} >> ${quotedLogPath}; ` +
    `else printf 'Memory:     unavailable (%s) memory.limit=%s (HostConfig)\\n' "\${__start_command_memory_unavailable:-sampler stopped before a reading; local cgroup unavailable}" "\${__start_command_memory_limit:-unknown}" >> ${quotedLogPath}; fi`
  );
}

/**
 * The `Memory:` line for a sample, exactly as the watcher's shell writes it.
 * Used where JavaScript writes the post-mortem itself (the recovery step).
 * @param {string|null|undefined} text - `<memory.max> <memory.peak> <oom> <oom_kill>`
 * @returns {?string} Line without a trailing newline, or null without a sample
 */
function formatCgroupMemoryLogLine(
  text,
  memoryLimit = 'unknown',
  unavailable = 'sampler unavailable; local cgroup hidden or unreadable'
) {
  const counters = parseCgroupMemorySample(text);
  if (!counters) {
    return `Memory:     unavailable (${unavailable}) memory.limit=${memoryLimit} (HostConfig)`;
  }
  const [max, peak, oom, kill] = String(text).trim().split(/\s+/);
  const scope = describeCgroupOomScope(counters);
  return `Memory:     memory.max=${max} memory.peak=${peak} oom=${oom} oom_kill=${kill}${
    scope ? ` (${OOM_SCOPE_NOTES[scope]})` : ''
  }`;
}

/** Where the OOM killer that killed processes in the container came from. */
const OOM_SCOPE = {
  UNKNOWN: 'unknown',
  // Retained scope names; raw counters alone cannot establish either one.
  CONTAINER_LIMIT: 'container-limit',
  HOST_OR_PARENT: 'host-or-parent',
};

const OOM_SCOPE_NOTES = {
  [OOM_SCOPE.UNKNOWN]: 'OOM kill scope unknown',
  [OOM_SCOPE.CONTAINER_LIMIT]: 'the container hit its own memory limit',
  [OOM_SCOPE.HOST_OR_PARENT]:
    'a host-wide or parent cgroup OOM killed processes here',
};

function parseCounter(text) {
  return /^\d+$/.test(text || '') ? Number(text) : null;
}

/**
 * Parse a sample written by the watcher.
 * @param {string|null|undefined} text - `<memory.max> <memory.peak> <oom> <oom_kill>`
 * @returns {?{limitBytes: ?number, peakBytes: ?number, oomEvents: ?number, oomKills: ?number}}
 *   Counters (`limitBytes` is null without a limit), or null without a sample
 */
function parseCgroupMemorySample(text) {
  const fields = String(text === null || text === undefined ? '' : text)
    .trim()
    .split(/\s+/);
  if (fields.length < 4) {
    return null;
  }
  const [max, peak, oom, kill] = fields;
  const counters = {
    limitBytes: parseCounter(max),
    peakBytes: parseCounter(peak),
    oomEvents: parseCounter(oom),
    oomKills: parseCounter(kill),
  };
  if (counters.oomEvents === null && counters.oomKills === null) {
    // memory.events was unreadable: the line carries no information.
    return null;
  }
  return counters;
}

/**
 * Normalize counters read back from an execution record.
 * @param {*} value - `record.cgroupMemory`
 * @returns {?{limitBytes: ?number, peakBytes: ?number, oomEvents: ?number, oomKills: ?number}}
 */
function normalizeCgroupMemory(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const counter = (field) => {
    const raw = value[field];
    const number = typeof raw === 'string' && raw !== '' ? Number(raw) : raw;
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  };
  return {
    limitBytes: counter('limitBytes'),
    peakBytes: counter('peakBytes'),
    oomEvents: counter('oomEvents'),
    oomKills: counter('oomKills'),
  };
}

/**
 * @param {?object} memory - Counters
 * Raw counters do not attribute the OOM killer's scope. Separately attributed
 * kernel/cgroup evidence would be needed to establish container, parent or
 * host scope. An unknown oomEvents count remains unknown, never zero.
 * @returns {?string} OOM_SCOPE.UNKNOWN for observed kills, otherwise null
 */
function describeCgroupOomScope(memory) {
  const counters = normalizeCgroupMemory(memory);
  if (!counters || !(counters.oomKills > 0)) {
    return null;
  }
  return OOM_SCOPE.UNKNOWN;
}

function formatBytes(bytes) {
  if (bytes === null) {
    return 'unknown';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Human-readable counters for `--status`.
 * @param {?object} memory - Counters
 * @returns {?string} e.g. `peak 255.9 MiB of 256.0 MiB limit, oom 0, oom_kill 3 (...)`
 */
function formatCgroupMemory(memory) {
  const counters = normalizeCgroupMemory(memory);
  if (!counters) {
    return null;
  }
  const limit =
    counters.limitBytes === null
      ? 'no limit'
      : `${formatBytes(counters.limitBytes)} limit`;
  const count = (value) => (value === null ? 'unknown' : value);
  const scope = describeCgroupOomScope(counters);
  return (
    `peak ${formatBytes(counters.peakBytes)} of ${limit}, ` +
    `oom ${count(counters.oomEvents)}, oom_kill ${count(counters.oomKills)}${
      scope ? ` (${OOM_SCOPE_NOTES[scope]})` : ''
    }`
  );
}

module.exports = {
  CGROUP_SAMPLE_BACKOFF_MAX_SECONDS,
  CGROUP_SAMPLE_INTERVAL_SECONDS,
  CGROUP_SAMPLING_OFF_REASON,
  CGROUP_SHELL_VARS,
  CGROUP_STREAM_NAME,
  CGROUP_UNREADABLE_EXIT,
  OOM_SCOPE,
  OOM_SCOPE_NOTES,
  buildCgroupFunctionsSnippet,
  buildCgroupMemoryLogSnippet,
  buildCgroupSamplerStartSnippet,
  buildCgroupSamplerStopSnippet,
  buildCgroupStreamScript,
  describeCgroupOomScope,
  formatCgroupMemory,
  formatCgroupMemoryLogLine,
  normalizeCgroupMemory,
  parseCgroupMemorySample,
};
