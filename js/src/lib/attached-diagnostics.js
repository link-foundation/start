/** Keep the same memory and CPU monitors alive during an attached Docker run. */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cgroup = require('./cgroup-memory');
const cpu = require('./cpu-penalty-monitor');
const evidence = require('./exit-evidence');
const { shellQuote } = require('./isolation-log-utils');

function startAttachedDiagnostics(name, options) {
  const file = path.join(os.tmpdir(), `start-attached-${crypto.randomUUID()}`);
  let worker;
  {
    const script = [
      cgroup.buildCgroupSamplerStartSnippet(name),
      cpu.startSnippet(options.executionId, name, 1, options),
      'read __start_stop',
      cgroup.buildCgroupSamplerStopSnippet(),
      cpu.stopSnippet(),
      `printf '%s' "$__start_command_cgroup" > ${shellQuote(file)}`,
      `printf '%s' "$__start_command_memory_unavailable" > ${shellQuote(`${file}.reason`)}`,
    ]
      .filter(Boolean)
      .join('; ');
    worker = spawn('sh', ['-c', script], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    worker.on('error', () => {});
    // Subscribe before a fast command finishes, including shell startup failure.
    worker.done = new Promise((resolve) => worker.once('close', resolve));
    worker.stdin.on('error', () => {});
  }
  return {
    async finish(state) {
      if (worker) {
        worker.stdin.end();
        await worker.done;
      }
      let sample = '';
      let unavailable = 'sampler could not start (sh unavailable)';
      try {
        sample = fs.readFileSync(file, 'utf8');
        unavailable =
          fs.readFileSync(`${file}.reason`, 'utf8') ||
          'sampler stopped before a reading';
      } catch {
        /* Optional diagnostics are best effort. */
      }
      try {
        fs.unlinkSync(file);
        fs.unlinkSync(`${file}.reason`);
      } catch {
        /* Optional diagnostics are best effort. */
      }
      const docker = require('./docker-cleanup').getDockerCommand();
      const limit = spawnSync(
        docker,
        ['inspect', '-f', '{{.HostConfig.Memory}}', name],
        { encoding: 'utf8' }
      );
      const line = evidence.collectExitEvidence({
        containerName: name,
        sample,
        finishedAt: state?.finishedAt,
        exitCode: state?.exitCode,
        oomKilled: state?.oomKilled,
      });
      if (options.logPath) {
        try {
          fs.appendFileSync(
            options.logPath,
            `${cgroup.formatCgroupMemoryLogLine(sample, limit.status === 0 ? limit.stdout.trim() : 'unknown', unavailable)}\n${line}\n`
          );
        } catch (error) {
          if (process.env.START_DEBUG === '1') {
            console.error(`[DEBUG] Attached diagnostics: ${error.message}`);
          }
        }
      }
      return {
        cgroupMemory: cgroup.parseCgroupMemorySample(sample),
        exitEvidence: evidence.fromLog(line),
      };
    },
  };
}

module.exports = { startAttachedDiagnostics };
