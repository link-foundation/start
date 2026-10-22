// Prints the sampler trace of every fixture mode (issue #242).
// Usage: node experiments/issue-242-sampler-trace.js [mode...] [--interval N]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cg = require('../js/src/lib/cgroup-memory');
const args = process.argv.slice(2);
const at = args.indexOf('--interval');
const interval = at >= 0 ? args.splice(at, 2)[1] : undefined;
const modes = args.length ? args : ['local', 'final', 'remote', 'shared', 'no-shell', 'outage'];
for (const mode of modes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-242-'));
  const script = path.join(dir, 's.sh');
  fs.writeFileSync(script, [
    cg.buildCgroupSamplerStartSnippet("task '238'"),
    'wait "$__start_command_cgroup_sampler"',
    cg.buildCgroupSamplerStopSnippet(),
    'printf "sample=%s\\n" "$__start_command_cgroup"',
    cg.buildCgroupMemoryLogSnippet('"$TMPDIR/memory.log"'),
    'cat "$TMPDIR/memory.log"; cut -c 1-60 "$TMPDIR/calls"; sed "s/^/sleep=/" "$TMPDIR/sleeps"',
  ].join('; '));
  const env = { ...process.env };
  delete env.START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS;
  if (interval !== undefined) env.START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS = interval;
  const r = spawnSync('/bin/sh', [path.join(__dirname, 'issue-238-cgroup-polling.sh'), mode, script], { encoding: 'utf8', env });
  console.log(`== ${mode} (status ${r.status})\n${r.stdout}${r.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
