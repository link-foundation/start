/**
 * Issue #263: runs one `pause-control` shared golden case
 * (parity/fixtures/contracts.json) through the JavaScript `--pause` /
 * `--unpause` control path. rust/tests/shared_golden.rs runs the same cases
 * through the Rust path, so both runtimes are held to identical reports,
 * errors, docker argv and persisted records.
 *
 * The in-memory docker follows the rules spelled out in
 * `pause-control.docker` of the fixture file; keep it in step with
 * `GoldenDocker` in rust/tests/shared_golden.rs.
 */

const TIMESTAMP =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/** Replace every ISO-8601 timestamp, which differs per run, with a marker. */
function normalize(value) {
  if (typeof value === 'string') {
    return value.replace(TIMESTAMP, '<timestamp>');
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalize(entry)])
    );
  }
  return value;
}

function goldenDocker(initial, name) {
  const docker = { state: initial, calls: [] };
  const ok = (stdout = '') => ({
    success: true,
    stdout,
    stderr: '',
    status: 0,
    error: null,
  });
  const fail = (stderr) => ({
    success: false,
    stdout: '',
    stderr,
    status: 1,
    error: null,
  });
  docker.runner = (command, args, extra = {}) => {
    docker.calls.push({ args: [...args], bounded: Boolean(extra.timeout) });
    const verb = args[0];
    if (docker.state === 'removed' && verb !== 'rm') {
      return fail(`Error response from daemon: No such container: ${name}`);
    }
    const alive = docker.state === 'running' || docker.state === 'paused';
    switch (verb) {
      case 'inspect': {
        const format = args[args.indexOf('-f') + 1];
        if (format === '{{.State.Status}} {{.State.Paused}}') {
          return ok(`${docker.state} ${docker.state === 'paused'}\n`);
        }
        if (format === '{{.State.Status}}') {
          return ok(`${docker.state}\n`);
        }
        if (format === '{{.Id}} {{.State.Pid}}') {
          return ok(`abc263def ${alive ? 4242 : 0}\n`);
        }
        return ok('');
      }
      case 'pause':
        if (docker.state !== 'running') {
          return fail(`container ${name} is not running`);
        }
        docker.state = 'paused';
        return ok(`${name}\n`);
      case 'unpause':
        if (docker.state !== 'paused') {
          return fail(`container ${name} is not paused`);
        }
        docker.state = 'running';
        return ok(`${name}\n`);
      default:
        return ok('');
    }
  };
  return docker;
}

/**
 * Run one case and return its normalized observable result.
 * @param {{ExecutionRecord: Function, pause: object}} modules - Code under test
 * @param {object} store - An empty ExecutionStore
 * @param {object} section - `pause-control` from the contracts file
 * @param {object} fixture - One of `section.cases`
 * @returns {object} The value `fixture.expected` must equal
 */
function runPauseCase({ ExecutionRecord, pause }, store, section, fixture) {
  const base = section.record;
  store.save(
    ExecutionRecord.fromObject({
      ...base,
      status: fixture.status || base.status,
      exitCode:
        fixture.exitCode === undefined ? base.exitCode : fixture.exitCode,
      options: { ...base.options, ...(fixture.options || {}) },
    })
  );
  const docker = goldenDocker(fixture.docker, base.options.sessionName);
  const deps = {
    runner: docker.runner,
    outputFormat: fixture.outputFormat,
    reason: fixture.reason,
    by: fixture.by,
  };
  const result =
    fixture.action === 'pause'
      ? pause.pauseExecution(store, fixture.identifier, deps)
      : pause.unpauseExecution(store, fixture.identifier, deps);
  const saved = store.get(base.uuid).toObject();
  let output = result.output === undefined ? null : result.output;
  if (output !== null && fixture.outputFormat === 'json') {
    output = JSON.parse(output);
  }
  return normalize({
    success: result.success,
    output,
    error: result.error === undefined ? null : result.error,
    dockerCalls: docker.calls.map((call) => call.args),
    unboundedDockerCalls: docker.calls
      .filter((call) => !call.bounded)
      .map((call) => call.args),
    dockerState: docker.state,
    record: {
      status: saved.status,
      exitCode: saved.exitCode === undefined ? null : saved.exitCode,
      containerState:
        saved.containerState === undefined ? null : saved.containerState,
      options: saved.options,
    },
  });
}

module.exports = { normalize, goldenDocker, runPauseCase };
