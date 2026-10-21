/**
 * One `docker inspect` for every container a status query probes (issue #243).
 *
 * `--list` used to start one or two `docker inspect` processes per record
 * (the live state, the process IDs, the removal check), one after another,
 * and `--status` up to three for its one record. While a query runs, this
 * module asks Docker once for every field those probes read, and answers the
 * per-record `docker inspect -f <format> <target>` calls from that answer.
 *
 * Docker prints one line per found container, in argument order, and one
 * `No such container: <target>` line on stderr per missing one. Each line
 * is matched back to its target by name or ID prefix (Docker's own lookup
 * order), so the answer does not depend on the line order. A target the
 * batch cannot account for (an old or stubbed docker, a daemon error) is
 * not answered, and its per-record probe runs as before.
 */

const { spawnSync } = require('child_process');

/** Fields of the batched inspect, in output order. */
const BATCH_FIELDS = [
  '.Name',
  '.Id',
  '.State.Pid',
  '.State.Running',
  '.State.ExitCode',
  '.State.OOMKilled',
  '.State.StartedAt',
  '.State.FinishedAt',
];
const BATCH_FORMAT = BATCH_FIELDS.map((field) => `{{${field}}}`).join(' ');
const NOT_FOUND_LINE = /no such (?:object|container):\s*(\S+)/gi;
const PLACEHOLDER = /\{\{\s*(\.[A-Za-z.]+)\s*\}\}/g;

/** Answers of the query in progress: target -> fields, or null (missing). */
let prefetched = null;

/**
 * Containers the status probes of these records would inspect. Records
 * whose container is already marked removed are skipped: they are never
 * probed (issue #243).
 * @param {Object[]} records - Execution records
 * @returns {string[]} Unique names and IDs
 */
function dockerProbeTargets(records) {
  const targets = new Set();
  for (const record of records) {
    const opts = (record && record.options) || {};
    if (opts.isolated !== 'docker' || record.containerState === 'removed') {
      continue;
    }
    for (const target of [opts.sessionName, opts.containerId]) {
      if (typeof target === 'string' && target) {
        targets.add(target);
      }
    }
  }
  return [...targets];
}

/**
 * Match a batched inspect answer to its targets.
 * @param {string[]} targets - Names and IDs passed to docker
 * @param {string} stdout - One line of `BATCH_FORMAT` per found container
 * @param {string} stderr - Docker's errors
 * @returns {Map<string, Object|null>} Fields per answered target, null for
 *   a target Docker reported missing; unanswered targets are absent
 */
function parseBatchInspect(targets, stdout, stderr) {
  const rows = String(stdout || '')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === BATCH_FIELDS.length)
    .map((parts) =>
      Object.fromEntries(BATCH_FIELDS.map((field, i) => [field, parts[i]]))
    );
  const missing = new Set(
    [...String(stderr || '').matchAll(NOT_FOUND_LINE)].map((m) => m[1])
  );
  const answers = new Map();
  for (const target of targets) {
    // Docker's own "no such container" wins over a prefix of another
    // target's ID.
    const row = missing.has(target)
      ? null
      : rows.find((r) => r['.Name'] === `/${target}`) ||
        rows.find((r) => r['.Id'].startsWith(target));
    if (row !== undefined) {
      answers.set(target, row);
    }
  }
  return answers;
}

/**
 * Run the batched inspect.
 * @returns {Map<string, Object|null>} See `parseBatchInspect`
 */
function runBatchInspect(targets, dockerCommand, spawnOptions) {
  if (targets.length === 0) {
    return new Map();
  }
  const result = spawnSync(
    dockerCommand,
    ['inspect', '--type', 'container', '-f', BATCH_FORMAT, ...targets],
    spawnOptions
  );
  if (result.error) {
    return new Map();
  }
  return parseBatchInspect(targets, result.stdout, result.stderr);
}

/**
 * Run `fn` with the docker probes of `records` answered by one inspect.
 * Nested calls reuse the outer answer.
 * @param {Object[]} records - Records the query will probe
 * @param {{dockerCommand: string, spawnOptions: Object}} docker - How to run docker
 * @param {function(): *} fn - The query
 * @returns {*} What `fn` returns
 */
function withDockerInspectBatch(records, docker, fn) {
  if (prefetched) {
    return fn();
  }
  prefetched = runBatchInspect(
    dockerProbeTargets(records),
    docker.dockerCommand,
    docker.spawnOptions
  );
  try {
    return fn();
  } finally {
    prefetched = null;
  }
}

/**
 * Answer `docker inspect -f <format> <target>` from the batch.
 * @param {string} format - Go template of the per-record probe
 * @param {string} target - Container name or ID
 * @returns {{success: boolean, status: number, stdout: string,
 *   stderr: string}|null} A spawn-like result, or null when the batch has
 *   no answer and the probe must run
 */
function prefetchedInspect(format, target) {
  if (!prefetched || !prefetched.has(target)) {
    return null;
  }
  const row = prefetched.get(target);
  if (row === null) {
    return {
      success: false,
      status: 1,
      stdout: '',
      stderr: `Error response from daemon: No such container: ${target}\n`,
    };
  }
  let known = true;
  const stdout = format.replace(PLACEHOLDER, (_, field) => {
    known = known && field in row;
    return row[field];
  });
  if (!known || stdout.includes('{{')) {
    return null;
  }
  return { success: true, status: 0, stdout: `${stdout}\n`, stderr: '' };
}

module.exports = {
  BATCH_FORMAT,
  dockerProbeTargets,
  parseBatchInspect,
  prefetchedInspect,
  withDockerInspectBatch,
};
