/**
 * Steps around the `docker commit` of a snapshot resume (issue #224):
 *
 * - `--snapshot-prepare <command>` runs in the stopped original before the
 *   commit: `docker start`, `docker exec ... sh -c <command>`, and always a
 *   `docker kill` afterwards. Starting the original runs its own command
 *   again, so this is only for containers whose start is known to be safe.
 * - Progress lines while `docker commit` runs, which prints nothing itself.
 * - `--remove-original-after <seconds>`: remove the stopped original only if
 *   the replacement is still running after the delay.
 */
const { spawn } = require('child_process');
const { setInterval, clearInterval, setTimeout } = globalThis;
const { appendLogFile } = require('./isolation-log-utils');
const { getDockerCommand, getDockerSpawnOptions } = require('./docker-cleanup');

const DEFAULT_PROGRESS_INTERVAL_SECONDS = 60;
/** Upper bound for one `--snapshot-prepare`; the original is killed after. */
const DEFAULT_PREPARE_TIMEOUT_SECONDS = 600;

/**
 * Format a duration the way the progress lines print it: "45s", "12 min".
 * @param {number} seconds - Elapsed seconds
 * @returns {string} Human-readable duration
 */
function formatElapsed(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) {
    return `${whole}s`;
  }
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest ? `${minutes} min ${rest}s` : `${minutes} min`;
}

function positiveSeconds(value, fallback) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

function progressIntervalSeconds(env = process.env) {
  return positiveSeconds(
    env.START_SNAPSHOT_PROGRESS_INTERVAL,
    DEFAULT_PROGRESS_INTERVAL_SECONDS
  );
}

/** Report one line to the execution log and through `notify`. */
function report(context, line) {
  if (context.logPath) {
    appendLogFile(context.logPath, `${line}\n`);
  }
  context.notify(line);
}

/**
 * Run a command without blocking the event loop.
 * @returns {Promise<{success, stdout, stderr, status, error}>}
 */
function runCommandAsync(command, args) {
  return new Promise((resolve) => {
    const options = { stdio: ['ignore', 'pipe', 'pipe'] };
    const child = spawn(
      command,
      args,
      command === getDockerCommand() ? getDockerSpawnOptions(options) : options
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({
        success: false,
        stdout,
        stderr,
        status: null,
        error: error.message,
      });
    });
    child.on('close', (status) => {
      resolve({ success: status === 0, stdout, stderr, status, error: null });
    });
  });
}

/**
 * Run `docker commit` and report the elapsed time every interval.
 * @param {{command: string, args: string[]}} step - The commit step
 * @param {object} context - {sessionName, logPath, notify, runAsync,
 *   intervalSeconds}
 * @returns {Promise<object>} The runner result
 */
async function commitWithProgress(step, context) {
  const started = Date.now();
  const intervalSeconds = context.intervalSeconds ?? progressIntervalSeconds();
  const timer = setInterval(() => {
    const elapsed = formatElapsed((Date.now() - started) / 1000);
    report(
      context,
      `[Resume] snapshotting ${context.sessionName}: ${elapsed} elapsed (docker commit reports no progress)`
    );
  }, intervalSeconds * 1000);
  let result;
  try {
    result = await context.runAsync(step.command, step.args);
  } finally {
    clearInterval(timer);
  }
  if (result && result.success) {
    report(
      context,
      `[Resume] snapshot of ${context.sessionName} committed after ${formatElapsed((Date.now() - started) / 1000)}`
    );
  }
  return result;
}

function detail(result, fallback) {
  return (
    String(result?.stderr || '').trim() ||
    result?.error ||
    (result?.status !== undefined && result?.status !== null
      ? `exit code ${result.status}`
      : fallback)
  );
}

/**
 * Run `--snapshot-prepare` in the stopped original. A failure is reported and
 * the snapshot continues with the files as they are.
 * @param {string} sessionName - Original container
 * @param {string} prepare - Shell command run with `sh -c`
 * @param {Function} runner - Sync command runner
 * @param {object} context - {logPath, notify}
 * @returns {{success: boolean, message: string}}
 */
function runSnapshotPrepare(sessionName, prepare, runner, context) {
  const docker = getDockerCommand();
  const started = runner(docker, ['start', sessionName]);
  if (!started.success) {
    const message = `[Resume] snapshot prepare skipped: could not start ${sessionName}: ${detail(started, 'docker start failed')}`;
    report(context, message);
    return { success: false, message };
  }
  let result;
  try {
    const timeout =
      positiveSeconds(
        process.env.START_SNAPSHOT_PREPARE_TIMEOUT,
        DEFAULT_PREPARE_TIMEOUT_SECONDS
      ) * 1000;
    result = runner(docker, ['exec', sessionName, 'sh', '-c', prepare], {
      timeout,
    });
  } catch (error) {
    result = { success: false, error: error.message };
  } finally {
    // Never commit a running original, and never leave it running.
    runner(docker, ['kill', sessionName]);
    runner(docker, ['wait', sessionName]);
  }
  const success = Boolean(result.success);
  const message = success
    ? `[Resume] snapshot prepare finished in ${sessionName}`
    : `[Resume] snapshot prepare failed in ${sessionName} (${detail(result, 'docker exec failed')}); snapshotting the files as they are`;
  report(context, message);
  return { success, message };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Remove the stopped original once the replacement has survived the delay.
 * @param {object} plan - Resume plan with sessionName and newSessionName
 * @param {number} delaySeconds - Startup window
 * @param {Function} runner - Sync command runner
 * @param {object} context - {logPath, notify, sleep}
 * @returns {Promise<string>} The note describing what happened
 */
async function removeOriginalAfter(plan, delaySeconds, runner, context) {
  report(
    context,
    `[Resume] Checking ${plan.newSessionName} again in ${formatElapsed(delaySeconds)} before removing ${plan.sessionName}`
  );
  await (context.sleep || sleep)(delaySeconds * 1000);
  const docker = getDockerCommand();
  const running = runner(docker, [
    'inspect',
    '-f',
    '{{.State.Running}}',
    plan.newSessionName,
  ]);
  let note;
  if (running.success && String(running.stdout).trim() === 'true') {
    const removed = runner(docker, ['rm', plan.sessionName]);
    note = removed.success
      ? `Stopped original container removed: ${plan.sessionName}`
      : `Original container retained: ${detail(removed, 'docker rm failed')}`;
  } else {
    note = `Original container retained: the snapshot container is not running ${formatElapsed(delaySeconds)} after launch.`;
  }
  if (context.logPath) {
    appendLogFile(context.logPath, `${note}\n`);
  }
  return note;
}

module.exports = {
  commitWithProgress,
  formatElapsed,
  progressIntervalSeconds,
  removeOriginalAfter,
  runCommandAsync,
  runSnapshotPrepare,
};
