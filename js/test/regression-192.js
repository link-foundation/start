const { it, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  buildCgroupSamplerStartSnippet,
  buildCgroupMemoryLogSnippet,
} = require('../src/lib/cgroup-memory');
it('samples remote/private cgroups through Docker and reports unavailable counters', () => {
  expect(buildCgroupSamplerStartSnippet('remote-task')).toContain(
    'docker exec'
  );
  expect(buildCgroupMemoryLogSnippet("'/tmp/log'")).toContain('unavailable');
  expect(buildCgroupSamplerStartSnippet('remote-task')).toContain(
    'HostConfig.Memory'
  );
});

for (const mode of ['remote', 'no-shell', 'outage', 'shared']) {
  it(`real watcher shell: ${mode}`, () => {
    if (process.platform === 'win32') {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-192-'));
    try {
      const script = path.join(dir, 'sample.sh');
      fs.writeFileSync(
        script,
        [
          buildCgroupSamplerStartSnippet('remote-task'),
          'sleep 1.2',
          require('../src/lib/cgroup-memory').buildCgroupSamplerStopSnippet(),
          buildCgroupMemoryLogSnippet('"$TMPDIR/memory.log"'),
          'cat "$TMPDIR/memory.log"',
        ].join('; ')
      );
      const result = spawnSync(
        '/bin/sh',
        [
          path.resolve(
            __dirname,
            '../../experiments/issue-195-memory-sampler.sh'
          ),
          mode,
          script,
        ],
        { encoding: 'utf8' }
      );
      expect(result.status).toBe(0);
      if (mode === 'remote' || mode === 'outage') {
        expect(result.stdout).toContain(
          'memory.max=67108864 memory.peak=33554432 oom=1 oom_kill=3'
        );
      } else {
        expect(result.stdout).toContain('Memory:     unavailable');
        expect(result.stdout).toContain('memory.limit=67108864 (HostConfig)');
        expect(result.stdout).toContain(
          mode === 'no-shell' ? 'sh: not found' : 'namespace=host'
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
}
