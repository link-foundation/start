/**
 * Regression tests for issue #242: when the task container's cgroup cannot be
 * read where `$` runs (a mounted docker.sock), every sampler round started a
 * new `docker exec` (sh, three `cat`, two `sed` inside the task container) and
 * a `docker inspect -f {{.State.Running}}`.
 *
 * Now one long-lived `docker exec -i` answers one host tick per interval with
 * shell builtins, liveness is probed only after a round without a sample, and
 * `START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS=off` turns sampling off.
 * The per-round counts are covered by regression-238 (shared fixture).
 */

const { describe, it, expect, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  CGROUP_SAMPLING_OFF_REASON,
  CGROUP_STREAM_NAME,
  buildCgroupStreamScript,
  buildCgroupSamplerStartSnippet,
  buildCgroupSamplerStopSnippet,
  buildCgroupMemoryLogSnippet,
} = require('../src/lib/cgroup-memory');

const posix = process.platform === 'win32' ? describe.skip : describe;
const tempDirs = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sampler-242-'));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(file, lines) {
  fs.writeFileSync(file, [...lines, ''].join('\n'));
  fs.chmodSync(file, 0o755);
}

/**
 * Runs the in-container loop with an empty PATH, so any `cat`, `sed`, `cut`
 * or `sleep` would fail, and `ticks` newlines from the host on stdin.
 */
function stream(files, ticks = 2) {
  const dir = tempDir();
  const cgroup = path.join(dir, 'cgroup');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(cgroup);
  fs.mkdirSync(bin);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(cgroup, name), content);
  }
  const result = spawnSync(
    '/bin/sh',
    ['-c', buildCgroupStreamScript(), CGROUP_STREAM_NAME, cgroup],
    {
      encoding: 'utf8',
      env: { PATH: bin },
      input: '\n'.repeat(ticks),
      timeout: 10000,
    }
  );
  return { ...result, cgroup };
}

const EVENTS = 'low 0\nhigh 0\nmax 4\noom 2\noom_kill 1\noom_group_kill 0\n';

posix('issue #242: the long-lived sampler exec', () => {
  it('prints one line per host tick using only builtins', () => {
    const result = stream({
      'memory.events': EVENTS,
      'memory.max': 'max\n',
      'memory.peak': '1234\n',
    });
    expect(result.stdout).toBe(
      `max 1234 2 1 ${result.cgroup}\nmax 1234 2 1 ${result.cgroup}\n`
    );
    // End of input (the sampler is gone) ends the loop.
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('prints - for counters the kernel does not provide', () => {
    const result = stream({ 'memory.events': EVENTS }, 1);
    expect(result.stdout).toBe(`- - 2 1 ${result.cgroup}\n`);
    expect(result.status).toBe(0);
  });

  it('prints nothing before the first tick', () => {
    const result = stream({ 'memory.events': EVENTS }, 0);
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  for (const [name, files] of [
    ['missing memory.events', {}],
    ['memory.events without oom_kill', { 'memory.events': 'oom 1\n' }],
    ['a malformed counter', { 'memory.events': 'oom x\noom_kill 1\n' }],
  ]) {
    it(`exits 3 on ${name}`, () => {
      const result = stream(files);
      expect(result.stdout).toBe('');
      expect(result.status).toBe(3);
    });
  }

  it('starts the stream under a recognisable name', () => {
    const snippet = buildCgroupSamplerStartSnippet('task');
    expect(snippet).toContain("| docker exec -i 'task' sh -c ");
    expect(snippet).toContain(`${CGROUP_STREAM_NAME} /sys/fs/cgroup 2>&1`);
    // The per-round exec stays as the fallback.
    expect(snippet).toContain('__start_command_cgroup_read /sys/fs/cgroup');
  });

  it('matches the Rust snippet byte for byte', () => {
    const golden = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../parity/fixtures/cgroup-sampler-start-242.sh'
      ),
      'utf8'
    );
    expect(`${buildCgroupSamplerStartSnippet("task '242'")}\n`).toBe(golden);
  });
});

/** Runs the start snippet, waits, stops, and prints the results. */
function run(env, between) {
  const dir = tempDir();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // A daemon reached through a mounted socket: no local cgroup, private
  // namespace, and an exec that answers each tick until its input ends.
  writeExecutable(path.join(bin, 'docker'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "$TMPDIR/calls"`,
    'case "$1 $3" in',
    '  *HostConfig.Memory*) echo 0 ;;',
    '  *CgroupnsMode*) echo private ;;',
    '  *State.Pid*) echo 0 ;;',
    // Never asked when the stream works; ends a regressed sampler at once.
    '  *State.Running*) echo false ;;',
    '  *Id*) echo remote242 ;;',
    '  exec*)',
    `    [ "$2 $7" = "-i ${CGROUP_STREAM_NAME}" ] || exit 1`,
    '    echo $$ > "$TMPDIR/exec.pid"',
    "    while read -r tick; do echo '67108864 1048576 0 0 /sys/fs/cgroup'; done ;;",
    'esac',
  ]);
  const script = [
    buildCgroupSamplerStartSnippet('task-242'),
    between,
    buildCgroupSamplerStopSnippet(),
    'printf "sample=%s\\n" "$__start_command_cgroup"',
    buildCgroupMemoryLogSnippet('"$TMPDIR/memory.log"'),
    'cat "$TMPDIR/memory.log"',
    'for file in "$TMPDIR"/start-command-cgroup*; do [ ! -e "$file" ] || echo "left: $file"; done',
  ].join('; ');
  const result = spawnSync('/bin/sh', ['-c', script], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ...env,
      TMPDIR: dir,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      START_COMMAND_CGROUP_ROOT: path.join(dir, 'hidden'),
      START_COMMAND_PROC_ROOT: path.join(dir, 'hidden'),
    },
  });
  expect(result.status).toBe(0);
  const calls = fs.existsSync(path.join(dir, 'calls'))
    ? fs.readFileSync(path.join(dir, 'calls'), 'utf8')
    : '';
  const pidFile = path.join(dir, 'exec.pid');
  const pid = fs.existsSync(pidFile)
    ? Number(fs.readFileSync(pidFile, 'utf8'))
    : null;
  return { output: result.stdout, calls, pid };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

posix('issue #242: sampler lifecycle against a mounted docker.sock', () => {
  it('samples from one exec and stops it with the sampler', async () => {
    const { output, calls, pid } = run(
      { START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS: '1' },
      'sleep 2'
    );
    expect(output).toMatch(/^sample=67108864 1048576 0 0 0 \d+$/m);
    expect(output).toContain(
      'Memory:     memory.max=67108864 memory.peak=1048576 oom=0 oom_kill=0'
    );
    expect(output).not.toContain('left:');
    const lines = calls.split('\n');
    expect(lines.filter((line) => line.startsWith('exec ')).length).toBe(1);
    // A streaming exec proves liveness; Docker is never asked.
    expect(calls).not.toContain('{{.State.Running}}');
    // Once the reader is gone, the next tick ends the exec and the ticker.
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 50 && alive(pid); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(alive(pid)).toBe(false);
  });

  for (const value of ['off', 'OFF', 'Off']) {
    it(`turns sampling off with ${value}`, () => {
      const { output, calls } = run(
        { START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS: value },
        'wait "$__start_command_cgroup_sampler"'
      );
      expect(output).toContain('sample=\n');
      expect(output).toContain(
        `Memory:     unavailable (${CGROUP_SAMPLING_OFF_REASON}) memory.limit=0 (HostConfig)`
      );
      expect(output).not.toContain('left:');
      // Only the HostConfig.Memory lookup that the post-mortem prints.
      expect(calls).toBe('inspect -f {{.HostConfig.Memory}} task-242\n');
    });
  }

  it('keeps unrelated values on the default interval', () => {
    const snippet = buildCgroupSamplerStartSnippet('task');
    expect(snippet).toContain("[Oo][Ff][Ff]) printf '%s\\n' ");
    expect(snippet).toContain("*[!0-9]*|'') __scs_interval=5;;");
  });
});
