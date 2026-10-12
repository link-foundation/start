/** Sequential probes, 128 MiB memory+swap, 32 PIDs, half a CPU, finite allocations. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { collectExitEvidence } = require('../js/src/lib/exit-evidence');
const {
  resolveExitReason,
  resolveMemoryExhaustion,
} = require('../js/src/lib/exit-reason');
const worker = readFileSync(
  new URL('./issue-209-worker.py', import.meta.url),
  'utf8'
);
const run = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8' }).trim();
const image = 'python:3.13-alpine';
try {
  run('image', 'inspect', image);
} catch {
  let prepared = false;
  for (const registry of [
    'mirror.gcr.io/library/',
    'public.ecr.aws/docker/library/',
    'docker.io/library/',
  ]) {
    try {
      run('pull', registry + image);
      run('tag', registry + image, image);
      prepared = true;
      break;
    } catch {
      /* Retain the registry failure on stderr and try the next mirror. */
    }
  }
  if (!prepared)
    throw new Error('Unable to prepare the finite Python Docker probe');
}
console.log(
  JSON.stringify({
    image: run('image', 'inspect', '-f', '{{json .RepoDigests}}', image),
  })
);
for (const mode of ['main-oom', 'normal-exit', 'external-kill']) {
  const id = run(
    'create',
    '--memory=128m',
    '--memory-swap=128m',
    '--pids-limit=32',
    '--cpus=0.5',
    '--network=none',
    image,
    'python',
    '-c',
    worker,
    mode
  );
  try {
    run('start', id);
    if (mode === 'external-kill') {
      // Keep the child OOM outside the three-second attribution window, then
      // deliver SIGKILL from Docker rather than from namespace PID 1 itself.
      await new Promise((resolve) => setTimeout(resolve, 32000));
      run('kill', '--signal=KILL', id);
    }
    run('wait', id);
    const state = JSON.parse(run('inspect', '-f', '{{json .State}}', id));
    const log = run('logs', id);
    const { sample } = JSON.parse(log.split('\n')[0]);
    const commands = [];
    const line = collectExitEvidence(
      {
        containerName: id,
        sample,
        finishedAt: state.FinishedAt,
        exitCode: state.ExitCode,
        oomKilled: state.OOMKilled,
      },
      (cmd, args) => {
        try {
          const stdout = execFileSync(cmd, args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          commands.push({ cmd, args, stdout });
          return { success: true, stdout };
        } catch (error) {
          commands.push({
            cmd,
            args,
            stderr: String(error.stderr || error.message),
          });
          return { success: false, stdout: '' };
        }
      }
    );
    const input = {
      exitCode: state.ExitCode,
      oomKilled: state.OOMKilled,
      logTail: line,
    };
    const reason = resolveExitReason(input),
      memory = resolveMemoryExhaustion(input);
    console.log(
      JSON.stringify({
        mode,
        id,
        state,
        sample,
        line,
        reason,
        memory,
        commands,
      })
    );
    if (
      mode === 'main-oom'
        ? reason !== 'memory-exhaustion (cgroup-oom-killer)' || !memory
        : Boolean(memory) ||
          (mode === 'external-kill' &&
            reason !== 'signal (SIGKILL; cause unknown)')
    ) {
      throw new Error(`Unexpected attribution for ${mode}`);
    }
  } finally {
    run('rm', '-f', id);
  }
}
