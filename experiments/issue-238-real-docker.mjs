/**
 * Finite, sequential real-daemon polling probes: 32 MiB, 32 PIDs, 0.2 CPU.
 * Since issue #242 the hidden-cgroup fallback reads through one long-lived
 * `docker exec -i` per sampler instead of one exec per round, and a local
 * cgroup needs no exec at all.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cgroup = require('../js/src/lib/cgroup-memory');
const { shellQuote } = require('../js/src/lib/isolation-log-utils');
const run = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8' }).trim();
const image = 'alpine:3.23';
try {
  run('image', 'inspect', image);
} catch {
  run('pull', image);
}
console.log(
  JSON.stringify({
    image: run('image', 'inspect', '-f', '{{json .RepoDigests}}', image),
  })
);
const dir = mkdtempSync(join(tmpdir(), 'real-sampler-238-'));
try {
  writeFileSync(
    join(dir, 'docker'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$START_SAMPLER_TRACE"\nexec /usr/bin/docker "$@"\n',
    { mode: 0o755 }
  );
  writeFileSync(
    join(dir, 'sleep'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$START_SAMPLER_SLEEPS"\nexec /bin/sleep "$@"\n',
    { mode: 0o755 }
  );
  for (const [mode, interval] of [
    ['automatic', undefined],
    ['hidden', undefined],
    ['hidden', '1'],
  ]) {
    const id = run(
      'create',
      '--memory=32m',
      '--memory-swap=32m',
      '--pids-limit=32',
      '--cpus=0.2',
      '--network=none',
      '--cgroupns=private',
      image,
      'sleep',
      '12'
    );
    const trace = join(dir, `calls-${mode}-${interval || 'default'}`);
    const sleepTrace = `${trace}.sleep`;
    writeFileSync(trace, '');
    writeFileSync(sleepTrace, '');
    try {
      run('start', id);
      const script = [
        cgroup.buildCgroupSamplerStartSnippet(id),
        `docker wait ${shellQuote(id)} >/dev/null`,
        cgroup.buildCgroupSamplerStopSnippet(),
        'printf "sample=%s\\n" "$__start_command_cgroup"',
        cgroup.buildCgroupMemoryLogSnippet(shellQuote(join(dir, 'memory.log'))),
      ].join('; ');
      const env = {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        TMPDIR: dir,
        START_SAMPLER_TRACE: trace,
        START_SAMPLER_SLEEPS: sleepTrace,
      };
      delete env.START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS;
      if (interval) env.START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS = interval;
      if (mode === 'hidden') {
        env.START_COMMAND_CGROUP_ROOT = join(dir, 'hidden-cgroup');
        env.START_COMMAND_PROC_ROOT = join(dir, 'hidden-proc');
      }
      const output = execFileSync('/bin/sh', ['-c', script], {
        env,
        encoding: 'utf8',
      });
      const calls = readFileSync(trace, 'utf8').trim().split('\n');
      const sleeps = readFileSync(sleepTrace, 'utf8').trim().split('\n');
      const count = (text) =>
        calls.filter((line) => line.includes(text)).length;
      console.log(
        JSON.stringify({
          mode,
          interval: interval || 'default',
          output,
          namespace: count('HostConfig.CgroupnsMode'),
          liveness: count('State.Running'),
          exec: count('exec '),
          calls,
          sleeps,
          memory: readFileSync(join(dir, 'memory.log'), 'utf8'),
        })
      );
      if (
        count('HostConfig.CgroupnsMode') !== 1 ||
        count('State.Running') > (interval ? 12 : 3) ||
        sleeps.length < (interval ? 6 : 2) ||
        sleeps.some((value) => value !== (interval || '5')) ||
        count('exec ') !== (mode === 'hidden' ? 1 : 0) ||
        count('exec -i ') !== (mode === 'hidden' ? 1 : 0) ||
        !output.includes('sample=33554432 ')
      ) {
        throw new Error('Real Docker polling or memory sample regression');
      }
    } finally {
      run('rm', '-f', id);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
