/**
 * cgroup v2 memory counters of a detached docker container (issue #182).
 *
 * Docker's `State.OOMKilled` is container-wide and sticky (moby/moby#43564):
 * it says that *some* process in the container was OOM-killed at some point,
 * but not how many, not whether the container hit its own `--memory` limit or
 * the whole host ran out, and not how close the execution came to its limit.
 * The kernel keeps all three per cgroup
 * (https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files):
 *   memory.events `oom`       the cgroup hit its own limit
 *   memory.events `oom_kill`  processes killed here by *any* OOM killer, so
 *                             `oom_kill > oom` points to a host-wide (or
 *                             parent cgroup) OOM
 *   memory.peak / memory.max  peak usage (Linux 5.19+) and limit (`max` when
 *                             unlimited)
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

/** Seconds between two samples of a running container's cgroup. */
const CGROUP_SAMPLE_INTERVAL_SECONDS = 1;

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
      '__scr_max=$(cat "$1/memory.max" 2>/dev/null); __scr_peak=$(cat "$1/memory.peak" 2>/dev/null); ' +
      'printf \'%s %s %s %s %s\\n\' "${__scr_max:--}" "${__scr_peak:--}" ' +
      '"${__scr_oom:--}" "${__scr_kill:--}" "$1"; }',
  ].join('; ');
}

/**
 * Shell fragment starting the background sampler. It writes each sample to a
 * temp file with `mv`, so the watcher never reads a half-written line, and
 * ends by itself once the cgroup is gone.
 * @param {string} containerName - Container to sample
 * @returns {string} Shell command
 */
function buildCgroupSamplerStartSnippet(containerName) {
  const v = CGROUP_SHELL_VARS;
  return [
    buildCgroupFunctionsSnippet(),
    `${v.file}="\${TMPDIR:-/tmp}/start-command-cgroup.$$"`,
    `rm -f "$${v.file}" "$${v.file}.tmp"`,
    `( __scs_dir=$(__start_command_cgroup_dir ${shellQuote(containerName)}) || exit 0; ` +
      'while __scs_line=$(__start_command_cgroup_read "$__scs_dir"); do ' +
      `printf '%s\\n' "$__scs_line" > "$${v.file}.tmp" && mv -f "$${v.file}.tmp" "$${v.file}"; ` +
      `sleep ${CGROUP_SAMPLE_INTERVAL_SECONDS}; done ) >/dev/null 2>&1 & ${v.sampler}=$!`,
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
    `__scs_dir=$(printf '%s' "$${v.sample}" | cut -s -d ' ' -f 5-)`,
    `if [ -n "$__scs_dir" ] && __scs_line=$(__start_command_cgroup_read "$__scs_dir"); then ${v.sample}=$__scs_line; fi`,
    `rm -f "$${v.file}" "$${v.file}.tmp"`,
    `${v.sample}=$(printf '%s' "$${v.sample}" | cut -d ' ' -f 1-4)`,
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
    `if [ "$4" -gt 0 ] 2>/dev/null; then if [ "$4" -gt "$3" ] 2>/dev/null; then ` +
    `__scm_note=' (${OOM_SCOPE_NOTES[OOM_SCOPE.HOST_OR_PARENT]})'; ` +
    `else __scm_note=' (${OOM_SCOPE_NOTES[OOM_SCOPE.CONTAINER_LIMIT]})'; fi; fi; ` +
    `printf 'Memory:     memory.max=%s memory.peak=%s oom=%s oom_kill=%s%s\\n' ` +
    `"$1" "$2" "$3" "$4" "$__scm_note"; }; ` +
    `if [ -n "$${v.sample}" ]; then __start_command_cgroup_log $${v.sample} >> ${quotedLogPath}; fi`
  );
}

/**
 * The `Memory:` line for a sample, exactly as the watcher's shell writes it.
 * Used where JavaScript writes the post-mortem itself (the recovery step).
 * @param {string|null|undefined} text - `<memory.max> <memory.peak> <oom> <oom_kill>`
 * @returns {?string} Line without a trailing newline, or null without a sample
 */
function formatCgroupMemoryLogLine(text) {
  const counters = parseCgroupMemorySample(text);
  if (!counters) {
    return null;
  }
  const [max, peak, oom, kill] = String(text).trim().split(/\s+/);
  const scope = describeCgroupOomScope(counters);
  return `Memory:     memory.max=${max} memory.peak=${peak} oom=${oom} oom_kill=${kill}${
    scope ? ` (${OOM_SCOPE_NOTES[scope]})` : ''
  }`;
}

/** Where the OOM killer that killed processes in the container came from. */
const OOM_SCOPE = {
  CONTAINER_LIMIT: 'container-limit',
  HOST_OR_PARENT: 'host-or-parent',
};

const OOM_SCOPE_NOTES = {
  [OOM_SCOPE.CONTAINER_LIMIT]: 'the container hit its own memory limit',
  [OOM_SCOPE.HOST_OR_PARENT]:
    'oom_kill > oom: a host-wide or parent cgroup OOM killed processes here',
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
 * @returns {?string} One of OOM_SCOPE, or null when nothing was OOM-killed
 */
function describeCgroupOomScope(memory) {
  const counters = normalizeCgroupMemory(memory);
  if (!counters || !(counters.oomKills > 0)) {
    return null;
  }
  return counters.oomKills > (counters.oomEvents || 0)
    ? OOM_SCOPE.HOST_OR_PARENT
    : OOM_SCOPE.CONTAINER_LIMIT;
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
  CGROUP_SAMPLE_INTERVAL_SECONDS,
  CGROUP_SHELL_VARS,
  OOM_SCOPE,
  OOM_SCOPE_NOTES,
  buildCgroupFunctionsSnippet,
  buildCgroupMemoryLogSnippet,
  buildCgroupSamplerStartSnippet,
  buildCgroupSamplerStopSnippet,
  describeCgroupOomScope,
  formatCgroupMemory,
  formatCgroupMemoryLogLine,
  normalizeCgroupMemory,
  parseCgroupMemorySample,
};
