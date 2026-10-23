/**
 * Regression tests for issue #247: with cgroup counters unreadable on both
 * sides (no local cgroup, no `memory.events` in the container because the
 * `memory` controller is not delegated), the sampler kept starting one
 * `docker exec` and one `docker inspect -f {{.State.Running}}` every interval
 * for the whole life of the task, although no round could ever record a
 * sample.
 *
 * Now exit 3 (unreadable counters) from the stream or from the per-round read
 * records the reason and stops, as exit 126/127 already did, and other failed
 * rounds back off exponentially. The no-memory fixture modes run the real
 * in-container scripts against a cgroup directory without `memory.events`.
 */

const { describe, it, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  CGROUP_SAMPLE_BACKOFF_MAX_SECONDS,
  CGROUP_UNREADABLE_EXIT,
  buildCgroupSamplerStartSnippet,
  buildCgroupSamplerStopSnippet,
  buildCgroupMemoryLogSnippet,
} = require('../src/lib/cgroup-memory');

/** Runs the shared fixture of issue #238 and returns its trace. */
function sample(mode, interval) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sampler-247-'));
  try {
    const script = path.join(dir, 'sample.sh');
    fs.writeFileSync(
      script,
      [
        buildCgroupSamplerStartSnippet("task '238'"),
        'wait "$__start_command_cgroup_sampler"',
        buildCgroupSamplerStopSnippet(),
        'printf "sample=%s\\n" "$__start_command_cgroup"',
        buildCgroupMemoryLogSnippet('"$TMPDIR/memory.log"'),
        'cat "$TMPDIR/memory.log" "$TMPDIR/calls"',
        'sed "s/^/sleep=/" "$TMPDIR/sleeps"',
        'for file in "$TMPDIR"/start-command-cgroup*; do [ ! -e "$file" ] || exit 1; done',
      ].join('; ')
    );
    const env = { ...process.env };
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
      { encoding: 'utf8', env, timeout: 30000 }
    );
    expect(result.status).toBe(0);
    return result.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const count = (output, text) =>
  output.split('\n').filter((line) => line.includes(text)).length;
const sleeps = (output) =>
  output
    .split('\n')
    .filter((line) => line.startsWith('sleep='))
    .map((line) => Number(line.slice('sleep='.length)));
const posix = process.platform === 'win32' ? describe.skip : describe;
const unreadable = `Memory:     unavailable (local cgroup unavailable; Docker exec exit=${CGROUP_UNREADABLE_EXIT}: private cgroup v2 counters unreadable)`;

posix('issue #247: unreadable cgroup counters stop the sampler', () => {
  it('stops after the stream exits 3, without per-round execs or liveness probes', () => {
    const output = sample('no-memory');
    expect(output).toContain('sample=\n');
    expect(output).toContain(unreadable);
    expect(count(output, "exec -i task '238' sh -c")).toBe(1);
    expect(count(output, "task '238' sh -c")).toBe(1);
    expect(count(output, '{{.State.Running}}')).toBe(0);
    expect(sleeps(output)).toEqual([]);
  });

  it('stops after a per-round read exits 3', () => {
    // The stream fails for a transient reason first, so one per-round exec
    // runs; its real read finds no memory.events.
    const output = sample('no-memory-outage');
    expect(output).toContain(unreadable);
    expect(count(output, "exec -i task '238' sh -c")).toBe(1);
    expect(count(output, "exec task '238' sh -c")).toBe(1);
    expect(count(output, '{{.State.Running}}')).toBe(1);
    expect(sleeps(output)).toHaveLength(1);
  });

  it('stops after a per-round exec finds no shell', () => {
    const output = sample('no-shell-outage');
    expect(output).toContain('Docker exec exit=127: sh: not found');
    expect(count(output, "exec task '238' sh -c")).toBe(1);
    expect(count(output, '{{.State.Running}}')).toBe(1);
  });

  it('records the per-round reason as exit 3, not as an exec failure', () => {
    const snippet = buildCgroupSamplerStartSnippet('task');
    expect(snippet).toContain(
      `__start_command_cgroup_read /sys/fs/cgroup || exit ${CGROUP_UNREADABLE_EXIT}`
    );
    expect(snippet).toContain('3|126|127) break;;');
  });
});

posix('issue #247: failed rounds back off exponentially', () => {
  it('doubles the wait after each round without a sample', () => {
    // Round 0 streams a sample; the stream, then per-round execs, fail.
    expect(sleeps(sample('outage'))).toEqual([5, 10, 20]);
  });

  it(`caps the wait at ${CGROUP_SAMPLE_BACKOFF_MAX_SECONDS} seconds`, () => {
    expect(sleeps(sample('outage', '40'))).toEqual([
      40,
      CGROUP_SAMPLE_BACKOFF_MAX_SECONDS,
      CGROUP_SAMPLE_BACKOFF_MAX_SECONDS,
    ]);
  });

  it('never waits less than a longer interval', () => {
    expect(sleeps(sample('outage', '100'))).toEqual([100, 100, 100]);
  });

  it('keeps the interval while samples arrive', () => {
    expect(sleeps(sample('remote', '2'))).toEqual([2, 2, 2]);
    expect(sleeps(sample('local'))).toEqual([5, 5, 5]);
  });
});
