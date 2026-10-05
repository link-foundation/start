/** Issue #185: allocation events and killed processes cannot establish OOM scope. */
const { describe, it, expect } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildCgroupMemoryLogSnippet,
  describeCgroupOomScope,
  formatCgroupMemory,
  formatCgroupMemoryLogLine,
  parseCgroupMemorySample,
} = require('../src/lib/cgroup-memory');
const {
  CGROUP_OOM_EXIT_REASON,
  resolveExitReason,
  resolveMemoryExhaustion,
} = require('../src/lib/exit-reason');

// Group kills, equal counts, earlier allocation failures, zero and unknown oom.
const SAMPLES = [
  '3135373312 3135373312 1 3',
  '3135373312 3135373312 2 2',
  '3135373312 3135373312 4 1',
  '3135373312 3135373312 0 3',
  '3135373312 3135373312 - 3',
];
const NOTE = 'OOM kill scope unknown';

describe('issue #185: counter-only OOM scope is unknown', () => {
  for (const sample of SAMPLES) {
    it(`preserves raw counters without attributing scope: ${sample}`, () => {
      const memory = parseCgroupMemorySample(sample);
      const [, , oom, kills] = sample.split(' ');
      expect(memory).toEqual({
        limitBytes: 3135373312,
        peakBytes: 3135373312,
        oomEvents: oom === '-' ? null : Number(oom),
        oomKills: Number(kills),
      });
      expect(describeCgroupOomScope(memory)).toBe('unknown');
      expect(formatCgroupMemory(memory)).toBe(
        `peak 2.9 GiB of 2.9 GiB limit, oom ${oom === '-' ? 'unknown' : oom}, oom_kill ${kills} (${NOTE})`
      );
      expect(formatCgroupMemoryLogLine(sample)).toBe(
        `Memory:     memory.max=3135373312 memory.peak=3135373312 oom=${oom} oom_kill=${kills} (${NOTE})`
      );
    });
  }

  it('does not report an OOM scope when kills are zero or unknown', () => {
    for (const memory of [null, {}, { oomKills: 0 }, { oomKills: null }]) {
      expect(describeCgroupOomScope(memory)).toBeNull();
    }
    for (const sample of ['max - 4 0', 'max - 4 -']) {
      expect(formatCgroupMemoryLogLine(sample)).not.toContain(NOTE);
    }
  });

  it('writes the same unknown scope from the POSIX watcher shell', () => {
    if (process.platform === 'win32') {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgroup-185-'));
    try {
      const logPath = path.join(dir, 'memory.log');
      for (const sample of [...SAMPLES, 'max - 4 0', 'max - 4 -']) {
        fs.writeFileSync(logPath, '');
        const result = spawnSync(
          '/bin/sh',
          [
            '-c',
            `__start_command_cgroup='${sample}'; ${buildCgroupMemoryLogSnippet('"$1"')}`,
            'watcher',
            logPath,
          ],
          { encoding: 'utf8', timeout: 5000 }
        );
        expect(result.status).toBe(0);
        const [max, peak, oom, kills] = sample.split(' ');
        const note = Number(kills) > 0 ? ` (${NOTE})` : '';
        expect(fs.readFileSync(logPath, 'utf8')).toBe(
          `Memory:     memory.max=${max} memory.peak=${peak} oom=${oom} oom_kill=${kills}${note}\n`
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains the exit-code guard for earlier child OOM kills', () => {
    const cgroupMemory = parseCgroupMemorySample(SAMPLES[0]);
    for (const exitCode of [0, 1, 134, 139, 143]) {
      const input = { exitCode, oomKilled: false, cgroupMemory };
      expect(resolveExitReason(input)).not.toBe(CGROUP_OOM_EXIT_REASON);
      expect(resolveMemoryExhaustion(input)).toBeNull();
    }
    for (const exitCode of [137, null, -1]) {
      const input = { exitCode, oomKilled: false, cgroupMemory };
      expect(resolveExitReason(input)).toBe(CGROUP_OOM_EXIT_REASON);
      expect(resolveMemoryExhaustion(input)).toEqual(
        exitCode === null
          ? null
          : {
              memoryExhausted: true,
              memoryExhaustedReason: 'cgroup memory.events reported oom_kill=3',
            }
      );
    }
  });
});
