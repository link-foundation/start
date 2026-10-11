/** A watcher-owned monitor. Sidecars avoid writing the store for every sample. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  initialState,
  evaluate,
  observeBase,
  transitionLog,
} = require('./cpu-penalty');
const { LockManager } = require('./store-lock');
const { shellQuote } = require('./isolation-log-utils');
const {
  cpuCount,
  cpuUpdateArgs,
  normalizeResourceLimits,
  readDockerResourceLimits,
} = require('./docker-resource-limits');
function statePath(record) {
  return `${record.logPath}.cpu-penalty.json`;
}
function readState(record) {
  if (!record.options?.cpuPenaltyConfig || !record.logPath) {
    return null;
  }
  try {
    const state = JSON.parse(fs.readFileSync(statePath(record), 'utf8'));
    if (
      state.containerName !== record.options.sessionName ||
      state.attemptNumber !== (record.attempt?.number || 1)
    ) {
      return null;
    }
    if (state.phase === 'penalized' && Number.isFinite(state.updatedAt)) {
      const until = record.endTime ? Date.parse(record.endTime) : Date.now();
      state.penalizedMs += Math.max(0, until - state.updatedAt);
      state.updatedAt = Math.max(until, state.updatedAt);
    }
    return state;
  } catch {
    return null;
  }
}
function publicState(state) {
  const result = { ...state };
  delete result.samples;
  delete result.lastAt;
  delete result.capacity;
  return result;
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    success: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}
async function monitor(
  uuid,
  name,
  attemptNumber,
  standalone,
  dependencies = {}
) {
  const filesystem = dependencies.fs || fs;
  const runner = dependencies.run || run;
  const { ExecutionStore } = require('./execution-store');
  const store = uuid
    ? new ExecutionStore(
        process.env.START_APP_FOLDER
          ? { appFolder: path.resolve(process.env.START_APP_FOLDER) }
          : {}
      )
    : null;
  const record = store ? store.get(uuid) : JSON.parse(standalone || 'null');
  if (
    !record?.options.cpuPenaltyConfig ||
    !record.logPath ||
    record.options.sessionName !== name
  ) {
    return;
  }
  const config = record.options.cpuPenaltyConfig;
  if ((record.attempt?.number || 1) !== Number(attemptNumber)) {
    return;
  }
  const lock = new LockManager(`${statePath(record)}.lock`, filesystem, true);
  if (!lock.acquire(100)) {
    return;
  }
  const docker = require('./docker-cleanup').getDockerCommand();
  let baseFlags = normalizeResourceLimits(
    record.options.baseResourceLimits || record.options.resourceLimits
  );
  const baseCpus = cpuCount(baseFlags);
  let state = initialState(baseCpus, Date.now(), readState(record));
  const interval = Math.min(
    30000,
    Math.max(50, Math.min(config.triggerWindowMs, config.releaseWindowMs) / 8)
  );
  const publish = (value = state) => {
    const file = statePath(record),
      tmp = `${file}.${process.pid}.tmp`;
    try {
      filesystem.writeFileSync(
        tmp,
        JSON.stringify({
          ...publicState(value),
          containerName: name,
          attemptNumber: Number(attemptNumber),
          updatedAt: Date.now(),
        })
      );
      filesystem.renameSync(tmp, file);
    } finally {
      try {
        filesystem.unlinkSync(tmp);
      } catch {
        /* Optional diagnostics are best effort. */
      }
    }
  };
  const log = (text) => {
    try {
      filesystem.appendFileSync(record.logPath, `${text}\n`);
    } catch {
      /* Optional diagnostics are best effort. */
    }
  };
  const debug = (error) => {
    if (process.env.START_DEBUG === '1') {
      const message = `[DEBUG] CPU monitor: ${error.stack || error}`;
      console.error(message);
      log(message);
    }
  };
  let stopping = false,
    wake;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    while (!stopping) {
      try {
        const current = store ? store.get(uuid) : record;
        if (
          !current ||
          current.options.sessionName !== name ||
          (current.attempt?.number || 1) !== Number(attemptNumber)
        ) {
          break;
        }
        const live = runner(docker, [
          'inspect',
          '-f',
          '{{.State.Running}}',
          name,
        ]);
        if (live.success && live.stdout.trim() === 'false') {
          break;
        }
        if (
          !live.success &&
          /No such (object|container)/i.test(live.stderr || '')
        ) {
          break;
        }
        const observed = readDockerResourceLimits(name, runner);
        if (observed !== null) {
          baseFlags = observed;
          state = observeBase(state, cpuCount(observed), Date.now());
        }
        const info = runner(docker, ['info', '--format', '{{json .}}']);
        const stats = runner(docker, [
          'stats',
          '--no-stream',
          '--format',
          '{{json .}}',
        ]);
        let daemonCpus = NaN,
          cores = NaN;
        try {
          if (info.success) {
            daemonCpus = JSON.parse(info.stdout).NCPU;
          }
          if (stats.success && live.success && observed !== null) {
            const row = stats.stdout
              .trim()
              .split('\n')
              .map((s) => JSON.parse(s))
              .find((s) => s.Name === name);
            if (row && /^\d+(?:\.\d+)?%$/.test(row.CPUPerc)) {
              cores = Number(row.CPUPerc.slice(0, -1)) / 100;
            }
          }
        } catch (error) {
          debug(error);
        }
        debug(
          `sample: phase=${state.phase} base=${state.baseCpus} limit=${state.limitCpus} cores=${cores} daemon=${daemonCpus}`
        );
        const decision = evaluate(
          state,
          {
            now: Date.now(),
            cores,
            daemonCpus,
            maxGapMs: Math.max(5000, interval * 3),
          },
          config
        );
        if (decision.action) {
          const action = decision.action;
          // Persist the base and intent before applying a cap. If this fails,
          // leave Docker alone; a killed monitor can always recover its base.
          if (action.kind === 'apply') {
            publish(decision.state);
          }
          const update = runner(docker, [
            'update',
            ...cpuUpdateArgs(baseFlags, action.cpus),
            name,
          ]);
          if (update.success) {
            state = decision.state;
            log(transitionLog(action, config));
          } else {
            debug(update.stderr || 'docker update failed');
            state = {
              ...decision.state,
              phase: state.phase,
              since: state.since,
              limitCpus: state.limitCpus,
              penaltyCount: state.penaltyCount,
              samples: [],
            };
          }
        } else {
          state = decision.state;
        }
        publish();
      } catch (error) {
        state.samples = [];
        debug(`tick failed: ${error.stack || error}`);
      }
      await new Promise((resolve) => {
        const timer = globalThis.setTimeout(resolve, interval);
        wake = () => {
          globalThis.clearTimeout(timer);
          resolve();
        };
        if (stopping) {
          wake();
        }
      });
    }
  } finally {
    try {
      const current = store ? store.get(uuid) : record;
      if (
        state.phase === 'penalized' &&
        current?.options.sessionName === name &&
        (current.attempt?.number || 1) === Number(attemptNumber)
      ) {
        const live = runner(docker, [
          'inspect',
          '-f',
          '{{.State.Running}}',
          name,
        ]);
        const observed = readDockerResourceLimits(name, runner);
        const info = runner(docker, ['info', '--format', '{{json .}}']);
        const capacity = info.success ? JSON.parse(info.stdout).NCPU : NaN;
        if (
          live.success &&
          live.stdout.trim() === 'true' &&
          observed !== null &&
          cpuCount(observed) === state.limitCpus &&
          capacity > 0
        ) {
          const cpus = Math.min(state.baseCpus || capacity, capacity);
          const update = runner(docker, [
            'update',
            ...cpuUpdateArgs(observed, cpus),
            name,
          ]);
          if (update.success) {
            state = {
              ...state,
              phase: 'observing',
              limitCpus: cpus,
              since: Date.now(),
            };
            log(`[start] CPU penalty lifted: ${cpus} CPUs (monitor stopped)`);
            publish();
          }
        }
      }
    } catch (error) {
      debug(error);
    }
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    lock.release();
  }
}
function startSnippet(uuid, name, attempt = 1, options = null) {
  const standalone =
    !uuid && options?.cpuPenaltyConfig && options.logPath
      ? JSON.stringify({
          logPath: options.logPath,
          options: {
            sessionName: name,
            cpuPenaltyConfig: options.cpuPenaltyConfig,
            baseResourceLimits: options.resourceLimits,
          },
        })
      : null;
  if (!uuid && !standalone) {
    return '';
  }
  const command = `${shellQuote(process.execPath)} ${shellQuote(__filename)} ${shellQuote(uuid || '')} ${shellQuote(name)} ${Number(attempt)} ${shellQuote(standalone || '')}`;
  // wait reaps a crashed child even in containers whose PID 1 never reaps.
  return `( __start_cpu_child=; trap 'if [ -n "$__start_cpu_child" ]; then kill "$__start_cpu_child" 2>/dev/null; wait "$__start_cpu_child" 2>/dev/null; fi; exit 0' TERM INT HUP; while :; do ${command} >/dev/null 2>&1 & __start_cpu_child=$!; wait "$__start_cpu_child"; __start_cpu_code=$?; [ "$__start_cpu_code" -eq 0 ] && break; sleep 1 & __start_cpu_child=$!; wait "$__start_cpu_child"; done ) & __start_cpu_monitor=$!`;
}
function stopSnippet() {
  return 'if [ -n "$__start_cpu_monitor" ]; then kill "$__start_cpu_monitor" 2>/dev/null; wait "$__start_cpu_monitor" 2>/dev/null; fi';
}
module.exports = {
  statePath,
  readState,
  publicState,
  monitor,
  startSnippet,
  stopSnippet,
};
if (require.main === module) {
  monitor(...process.argv.slice(2)).catch((error) => {
    process.exitCode = 1;
    if (process.env.START_DEBUG === '1') {
      console.error(`[DEBUG] CPU monitor: ${error.stack}`);
    }
  });
}
