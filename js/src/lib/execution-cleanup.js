/**
 * `$ --cleanup <uuid-or-session-name>` (issue #224): remove the Docker
 * containers of one execution and the snapshot images they were derived from.
 *
 * For callers that remove containers themselves: start-command's completion
 * watcher removes a snapshot image only when it removes the container. Nothing
 * here is forced, so Docker keeps any container that is still running and any
 * image that something else still uses; those are reported as retained.
 *
 * The containers are the current one and every earlier container of a
 * `--resume` chain (`sessionNameHistory`). The images are the
 * `start-command-resume/*` images named by the `start-command.snapshot-image`
 * label of those containers, by the record, and by the `-resume-N` names of
 * the chain, removed newest first.
 */
const { getDockerCommand } = require('./docker-cleanup');
const { runCommand } = require('./execution-control');
const { SNAPSHOT_IMAGE_LABEL } = require('./docker-snapshot-safety');

const SNAPSHOT_IMAGE_PATTERN = /^start-command-resume\/[a-z0-9._-]+:\d+$/;
const NOT_FOUND_PATTERN = /no such (container|image|object)/i;

/** Docker image name for snapshot attempt `attempt` of `sessionName`. */
function snapshotImageName(sessionName, attempt) {
  const { buildSnapshotImageName } = require('./execution-resume');
  return buildSnapshotImageName(sessionName, attempt);
}

/** Snapshot images implied by a `<name>-resume-<N>` chain, newest first. */
function chainImages(containerName) {
  const images = [];
  let current = String(containerName || '');
  for (
    let match = /^(.+)-resume-(\d+)$/.exec(current);
    match;
    match = /^(.+)-resume-(\d+)$/.exec(current)
  ) {
    images.push(snapshotImageName(match[1], match[2]));
    current = match[1];
  }
  return images;
}

function attemptOf(image) {
  return Number(/:(\d+)$/.exec(image)?.[1] || 0);
}

function errorText(result) {
  return (
    String(result?.stderr || '').trim() ||
    result?.error ||
    `exit code ${result?.status}`
  );
}

/**
 * The containers and images `--cleanup <execution>` would remove.
 * @param {object} record - Execution record
 * @param {Function} runner - Sync command runner
 * @returns {{containers: string[], images: string[]}}
 */
function planExecutionCleanup(record, runner) {
  const options = record.options || {};
  const current = options.sessionName || options.containerId || null;
  const containers = [
    ...new Set(
      [current, ...[...(options.sessionNameHistory || [])].reverse()].filter(
        Boolean
      )
    ),
  ];
  const images = [options.snapshotImage];
  for (const container of containers) {
    const labelled = runner(getDockerCommand(), [
      'inspect',
      '-f',
      `{{index .Config.Labels "${SNAPSHOT_IMAGE_LABEL}"}}`,
      container,
    ]);
    if (labelled.success) {
      images.push(String(labelled.stdout || '').trim());
    }
    images.push(...chainImages(container));
  }
  return {
    containers,
    images: [...new Set(images)]
      .filter((image) => SNAPSHOT_IMAGE_PATTERN.test(image || ''))
      .sort((a, b) => attemptOf(b) - attemptOf(a)),
  };
}

/**
 * Remove (or, with `dryRun`, list) one object without force.
 * @returns {{name: string, kind: string, state: string, detail?: string}}
 *   `state` is removed, absent, retained or present (dry run)
 */
function removeObject(kind, name, runner, dryRun) {
  const docker = getDockerCommand();
  const args = dryRun
    ? kind === 'image'
      ? ['image', 'inspect', '--format', '{{.Id}}', name]
      : ['container', 'inspect', '--format', '{{.Id}}', name]
    : kind === 'image'
      ? ['rmi', name]
      : ['rm', name];
  const result = runner(docker, args);
  if (result.success) {
    return { kind, name, state: dryRun ? 'present' : 'removed' };
  }
  const detail = errorText(result);
  if (!result.error && NOT_FOUND_PATTERN.test(detail)) {
    return { kind, name, state: 'absent' };
  }
  return { kind, name, state: 'retained', detail };
}

const LABELS = {
  removed: 'Removed',
  absent: 'Already gone:',
  retained: 'Retained',
  present: 'Would remove',
};

function formatOutcome(outcome) {
  const line = `${LABELS[outcome.state]} ${outcome.kind} ${outcome.name}`;
  return outcome.detail ? `${line} (${outcome.detail})` : line;
}

/**
 * Remove one execution's containers, then its snapshot images.
 * @param {?object} store - Execution store
 * @param {string} identifier - UUID or session name
 * @param {object} [deps] - {dryRun, runner}
 * @returns {{success: boolean, output?: string, error?: string}}
 */
function cleanupExecution(store, identifier, deps = {}) {
  if (!store) {
    return { success: false, error: 'Execution tracking is disabled.' };
  }
  const record = store.get(identifier);
  if (!record) {
    return {
      success: false,
      error: `No execution found with UUID or session name: ${identifier}`,
    };
  }
  if (record.options?.isolated !== 'docker') {
    return {
      success: false,
      error: `--cleanup <execution> only removes Docker containers and images; ${identifier} is not a Docker execution.`,
    };
  }
  const runner = deps.runner || runCommand;
  const dryRun = deps.dryRun === true;
  const plan = planExecutionCleanup(record, runner);
  const outcomes = plan.containers.map((name) =>
    removeObject('container', name, runner, dryRun)
  );
  // Images go only after their containers; Docker refuses a used image.
  for (const image of plan.images) {
    outcomes.push(removeObject('image', image, runner, dryRun));
  }
  const current = outcomes[0];
  if (
    !dryRun &&
    current &&
    ['removed', 'absent'].includes(current.state) &&
    typeof store.markContainerRemoved === 'function'
  ) {
    store.markContainerRemoved(record.uuid, new Date().toISOString());
  }
  const retained = outcomes.filter((outcome) => outcome.state === 'retained');
  const lines = outcomes.length
    ? outcomes.map(formatOutcome)
    : ['No containers or snapshot images recorded for this execution.'];
  const output = lines.join('\n');
  if (retained.length > 0) {
    return {
      success: false,
      output,
      error: `${retained.length} Docker object(s) retained; nothing was forced.`,
    };
  }
  return { success: true, output };
}

module.exports = {
  SNAPSHOT_IMAGE_PATTERN,
  chainImages,
  cleanupExecution,
  planExecutionCleanup,
};
