const { describe, it, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  buildCgroupSamplerStartSnippet,
  buildCgroupSamplerStopSnippet,
  buildCgroupMemoryLogSnippet,
} = require('../src/lib/cgroup-memory');

function sample(mode, interval, clockStep = '5') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sampler-238-'));
  try {
    const script = path.join(dir, 'sample.sh');
    fs.writeFileSync(
      script,
      [
        buildCgroupSamplerStartSnippet("task '238'"),
        'wait "$__start_command_cgroup_sampler"',
        mode === 'final'
          ? 'printf "oom 3\\noom_kill 3\\n" > "$START_COMMAND_CGROUP_ROOT/docker/238abc/memory.events"'
          : ':',
        buildCgroupSamplerStopSnippet(),
        'printf "sample=%s\\n" "$__start_command_cgroup"',
        buildCgroupMemoryLogSnippet('"$TMPDIR/memory.log"'),
        'cat "$TMPDIR/memory.log" "$TMPDIR/calls"',
        'sed "s/^/sleep=/" "$TMPDIR/sleeps"',
        // Stop must remove every temporary sample file.
        'for file in "$TMPDIR"/start-command-cgroup*; do [ ! -e "$file" ] || exit 1; done',
      ].join('; ')
    );
    const env = { ...process.env, START_SAMPLER_CLOCK_STEP: clockStep };
    delete env.START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS;
    if (interval !== undefined) {
      env.START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS = interval;
    }
    const result = spawnSync(
      '/bin/sh',
      [
        path.resolve(
          __dirname,
          '../../experiments/issue-238-cgroup-polling.sh'
        ),
        mode,
        script,
      ],
      { encoding: 'utf8', env }
    );
    expect(result.status).toBe(0);
    return result.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const count = (output, text) =>
  output.split('\n').filter((line) => line.includes(text)).length;
const posix = process.platform === 'win32' ? describe.skip : describe;

posix('issue #238: bounded Docker cgroup sampling', () => {
  it('defaults to five seconds and inspects local liveness only after removal', () => {
    const output = sample('local');
    expect(count(output, 'sleep=5')).toBe(3);
    expect(count(output, '{{.State.Running}}')).toBe(1);
    expect(count(output, '{{.HostConfig.CgroupnsMode}}')).toBe(1);
    // One fallback after local removal; no remote exec on readable rounds.
    expect(count(output, 'exec task')).toBe(1);
  });

  it('honors an override in the watcher environment and caches remote namespace', () => {
    const output = sample('remote', '2');
    expect(count(output, 'sleep=2')).toBe(3);
    expect(count(output, '{{.HostConfig.CgroupnsMode}}')).toBe(1);
    expect(count(output, '{{.State.Running}}')).toBe(4);
    expect(count(output, 'exec task')).toBe(4);
    expect(output).toContain(
      'memory.max=67108864 memory.peak=33554432 oom=1 oom_kill=3'
    );
  });

  it('rejects zero, negative, fractional, malformed and unsafe intervals', () => {
    for (const interval of [
      '',
      '0',
      '000',
      '-1',
      '0.5',
      'nope',
      '1; exit 7',
      '99999999999999999999999999',
    ]) {
      expect(count(sample('shared', interval), 'sleep=5')).toBe(3);
    }
  });

  it('keeps unavailable diagnostics and the last sample across remote outages', () => {
    for (const mode of ['shared', 'no-shell', 'outage']) {
      const output = sample(mode);
      expect(count(output, '{{.HostConfig.CgroupnsMode}}')).toBe(1);
      expect(count(output, '{{.State.Running}}')).toBe(4);
      if (mode === 'outage') {
        expect(output).toContain('sample=67108864 33554432 1 3 0 100');
      } else {
        expect(output).toContain('Memory:     unavailable');
        expect(output).toContain(
          mode === 'shared' ? 'namespace=host' : 'sh: not found'
        );
      }
    }
  });

  it('preserves a final read without treating a five-second counter gap as recent OOM', () => {
    expect(sample('final')).toContain('sample=67108864 33554432 3 3 0 115');
    expect(sample('final', '1', '1')).toContain(
      'sample=67108864 33554432 3 3 103 103'
    );
  });
});
